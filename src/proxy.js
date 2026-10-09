'use strict';
/**
 * The proxy — the "condom".
 *
 * The agent points its remote at this process and holds a placeholder token (or none). This
 * process holds the real PAT and is the only thing that ever talks to GitHub. Because the
 * gate is a pre-receive hook on a mirror this process owns, it cannot be skipped from the
 * client: `--no-verify`, a hand-built pack, or a patched git all still land here.
 *
 *   info/refs          -> sync the mirror, then advertise from it
 *   POST upload-pack   -> served from the mirror (clone/fetch)
 *   POST receive-pack  -> served from the mirror, whose pre-receive hook is the policy
 *                         gate; only after the hook accepts is the result forwarded
 *                         upstream with the PAT
 *
 * Everything is served from the mirror rather than passed through, so the PAT is used in
 * exactly two places (sync and forward) and the gate sits on the only path a push can take.
 * The mirror is synced before every ref advertisement so the client computes its pack
 * against upstream's real refs — receiving into a stale mirror would fail to resolve a thin
 * pack. A sync on each request also picks up a push made upstream by a human.
 */

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { loadPolicy } = require('./config');
const CC_BIN = path.join(__dirname, '..', 'bin', 'cc.js');

/** Wrap a string in a git pkt-line. */
function pkt(line) {
  const s = Buffer.isBuffer(line) ? line : Buffer.from(String(line), 'utf8');
  const len = s.length + 4;
  if (len > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), s]);
}

/** Redact a token from anything that might be logged. */
function redact(s) {
  return String(s == null ? '' : s).replace(/([a-zA-Z0-9_]{8,})@/g, '***@').replace(/(ghp_|sk-)[A-Za-z0-9]+/g, '$1***');
}

/** The upstream URL with the credential injected. Never logged, never stored on disk.
 *
 *  The credential is only injected for an http(s) upstream: a file:// or ssh:// remote has
 *  no place to put a token, and setting one on file:// throws. That also makes the whole
 *  proxy testable against a local bare repo with no network and no real secret.
 */
function authedUrl(base, owner, repo, token) {
  const u = new URL(base);
  if (token && /^https?:$/.test(u.protocol)) { u.username = token; u.password = ''; }
  u.pathname = `${u.pathname.replace(/\/$/, '')}/${owner}/${repo}.git`;
  return u.toString();
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let out = '', errOut = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
    child.on('error', (e) => resolve({ code: -1, stdout: out, stderr: String(e.message) }));
    child.on('close', (code) => resolve({ code, stdout: out, stderr: errOut }));
  });
}

/** Pipe a request body into a git service and return its raw stdout + exit code. */
function runService(repoDir, subcmd, bodyBuffer, env) {
  return new Promise((resolve) => {
    const child = spawn('git', [subcmd, '--stateless-rpc', repoDir], { env });
    const chunks = [];
    let errOut = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
    child.on('error', (e) => resolve({ code: -1, body: Buffer.alloc(0), stderr: String(e.message) }));
    child.on('close', (code) => resolve({ code, body: Buffer.concat(chunks), stderr: errOut }));
    child.stdin.on('error', () => { /* a rejecting hook closes stdin early; that is fine */ });
    child.stdin.end(bodyBuffer);
  });
}

function advertise(repoDir, subcmd, env) {
  return new Promise((resolve) => {
    const child = spawn('git', [subcmd, '--stateless-rpc', '--advertise-refs', repoDir], { env });
    const chunks = [];
    let errOut = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
    child.on('error', (e) => resolve({ code: -1, body: Buffer.alloc(0), stderr: String(e.message) }));
    child.on('close', (code) => resolve({ code, body: Buffer.concat(chunks), stderr: errOut }));
  });
}

function readBody(req, cap = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > cap) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createProxy(cfg) {
  const dataDir = cfg.dataDir || path.join(require('os').homedir(), '.commit-condom');
  const config = {
    upstream: cfg.upstream || 'https://github.com',
    token: cfg.token || '',
    dataDir,
    policyPath: cfg.policyPath || '',
    // A per-repo policy registry the PROXY owns. A pusher cannot reach this directory with git,
    // so a repo registered here is gated by a policy it cannot edit, weaken or delete. This is
    // what makes the gate inescapable: the alternative — reading .condom.json out of the pushed
    // tree — would let a push that deletes that file disable its own gate.
    policyDir: cfg.policyDir || path.join(dataDir, 'policies'),
    log: cfg.log || ((m) => process.stderr.write(m + '\n')),
  };
  if (!config.token) throw new Error('no upstream token: set CC_PAT (or GITHUB_PAT) before starting the proxy');
  const mirrorsDir = path.join(config.dataDir, 'mirrors');
  fs.mkdirSync(mirrorsDir, { recursive: true });
  fs.mkdirSync(config.policyDir, { recursive: true });
  const locks = new Map();

  /** The policy file in force for one repo, or '' for the built-in defaults. */
  const policyFor = (owner, repo) => {
    const registered = path.join(config.policyDir, `${owner}__${repo}.json`);
    if (fs.existsSync(registered)) return registered;
    return config.policyPath || '';
  };

  const mirrorFor = (owner, repo) => path.join(mirrorsDir, owner, `${repo}.git`);
  const routeFor = (urlPath) => {
    const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(urlPath);
    if (!m) return null;
    return { owner: m[1], repo: m[2], path: m[3] };
  };

  /** Serialize everything per repo: a push must not race its own sync or forward. */
  async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    locks.set(key, prev.then(() => next));
    await prev;
    try { return await fn(); } finally { release(); }
  }

  /** Ensure the mirror exists and its heads match upstream. */
  async function syncMirror(owner, repo) {
    const dir = mirrorFor(owner, repo);
    const url = authedUrl(config.upstream, owner, repo, config.token);
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
      const r = await run('git', ['clone', '--mirror', '--quiet', url, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      if (r.code !== 0) throw new Error(`mirror clone failed: ${redact(r.stderr).trim().slice(0, 200)}`);
    } else {
      const r = await run('git', ['-C', dir, 'fetch', '--prune', '--quiet', url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      if (r.code !== 0) throw new Error(`mirror fetch failed: ${redact(r.stderr).trim().slice(0, 200)}`);
    }
    // The gate lives on the mirror. Re-install it every sync so it cannot be removed and so
    // a policy change takes effect on the next push. The policy is copied from the proxy-owned
    // registry (or the machine policy), NOT from the incoming commit, so a push cannot carry
    // in a weaker policy or delete the one in force.
    await run(process.execPath, [CC_BIN, 'install-hooks', '--repo', dir, '--bare']);
    const pol = policyFor(owner, repo);
    const mirrorPolicy = path.join(dir, 'condom.json');
    if (pol) {
      try { fs.copyFileSync(pol, mirrorPolicy); } catch { /* optional */ }
    } else {
      try { fs.rmSync(mirrorPolicy, { force: true }); } catch { /* none */ }
    }
    return dir;
  }

  /** Push the refs the mirror just advanced up to upstream, with the PAT.
   *
   *  Namespaces, not --mirror. A mirror clone carries refs/pull/* and refs/merge-requests/*
   *  copied from the remote, and GitHub refuses to update those hidden refs ("deny updating a
   *  hidden ref"). `--mirror` therefore exits non-zero on EVERY push even though the branch
   *  landed, so the proxy logged "forward to upstream failed" for a push that had in fact
   *  succeeded - and the caller could not tell a real rejection from this. Measured against
   *  webchat-to-api-harness: `main -> main` in the same output as three hidden-ref rejections.
   *  Push exactly the two namespaces a user can own, and a partial failure is then real.
   */
  async function forward(owner, repo) {
    const dir = mirrorFor(owner, repo);
    const url = authedUrl(config.upstream, owner, repo, config.token);
    const r = await run('git',
      ['-C', dir, 'push', '--quiet', url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.code !== 0) throw new Error(`forward to upstream failed: ${redact(r.stderr).trim().slice(0, 300)}`);
  }

  const server = http.createServer(async (req, res) => {
    const route = routeFor((req.url || '').split('?')[0]);
    if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('commit-condom: not a git route\n'); }
    const { owner, repo, path: svcPath } = route;
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    // Hand the gate the repo's policy explicitly. The hook reads CC_POLICY before any file in
    // the repo, so this wins even if something in the mirror tried to shadow it.
    const pol = policyFor(owner, repo);
    if (pol) env.CC_POLICY = pol;

    // The service name comes from the URL for a POST, but from the ?service= query for the
    // ref advertisement (whose path is just `info/refs`). Deriving it from the path for
    // info/refs made every receive-pack advertisement look like an upload-pack one and
    // answered 400, which the client reports only as "The requested URL returned error: 400".
    const svcFromPath = svcPath === 'info/refs'
      ? null
      : svcPath;
    const isWrite = (q) => (q || svcFromPath) === 'git-receive-pack';
    // The protocol name and the git subcommand are NOT the same string: the protocol is
    // git-upload-pack, the command is `git upload-pack`.
    const subcmdFor = (q) => (isWrite(q) ? 'receive-pack' : 'upload-pack');

    try {
      if (svcPath === 'info/refs') {
        const q = new URL(req.url, 'http://x').searchParams.get('service');
        if (q !== 'git-upload-pack' && q !== 'git-receive-pack') {
          res.writeHead(400, { 'content-type': 'text/plain' });
          return res.end('unexpected service\n');
        }
        const subcmd = subcmdFor(q);
        const adv = await withLock(`${owner}/${repo}`, async () => {
          await syncMirror(owner, repo);
          return advertise(mirrorFor(owner, repo), subcmd, env);
        });
        if (adv.code !== 0) {
          config.log(`proxy: advertise failed for ${owner}/${repo}: ${redact(adv.stderr).trim().slice(0, 200)}`);
          res.writeHead(500, { 'content-type': 'text/plain' });
          return res.end('advertise failed\n');
        }
        res.writeHead(200, { 'content-type': `application/x-${q}-advertisement`, 'cache-control': 'no-cache' });
        return res.end(Buffer.concat([pkt(`# service=${q}\n`), Buffer.from('0000'), adv.body]));
      }

      const body = await readBody(req);

      if (!isWrite()) {
        const served = await withLock(`${owner}/${repo}`, async () => {
          await syncMirror(owner, repo);
          return runService(mirrorFor(owner, repo), 'upload-pack', body, env);
        });
        res.writeHead(served.code === 0 ? 200 : 500, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
        return res.end(served.body);
      }

      // ── the write path ──────────────────────────────────────────────────────────────
      const result = await withLock(`${owner}/${repo}`, async () => {
        await syncMirror(owner, repo);
        const rr = await runService(mirrorFor(owner, repo), 'receive-pack', body, env);
        if (rr.code !== 0) {
          config.log(`✗ ${owner}/${repo}: gate rejected the push (${redact(rr.stderr).trim().slice(0, 160)})`);
          return { body: rr.body, forwarded: false };
        }
        try {
          await forward(owner, repo);
        } catch (e) {
          // The mirror accepted but upstream did not: the client must NOT be told it succeeded.
          config.log(`✗ ${owner}/${repo}: ${redact(e.message)}`);
          return { body: rr.body, forwarded: false, error: e.message };
        }
        config.log(`✓ ${owner}/${repo}: push accepted and forwarded`);
        return { body: rr.body, forwarded: true };
      });

      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
      return res.end(result.body);
    } catch (e) {
      config.log(`proxy error: ${redact(e.message)}`);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(redact(e.message) + '\n'); }
      else res.end();
    }
  });

  return { server, config, mirrorFor, syncMirror, routeFor, policyFor };
}

module.exports = { createProxy, pkt, redact, authedUrl };
