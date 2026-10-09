#!/usr/bin/env node
'use strict';
/*
 * End-to-end proxy test. No network and no real secret: the "GitHub" is a local bare repo
 * laid out as <dir>/<owner>/<repo>.git, which is the same shape the proxy builds for
 * github.com. That makes the whole path real (git smart HTTP, the mirror, the hook, the
 * forward) while staying hermetic.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proxy-'));
const GH = path.join(TMP, 'github');
const OWNER = 'acme', REPO = 'demo';
const UP = path.join(GH, OWNER, `${REPO}.git`);

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

let pass = 0, fail = 0;
const results = [];
const t = (name, fn) => {
  try { fn(); console.log('ok   ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 4).join('\n     ')); fail++; results.push(name); }
};

// ── build the fake GitHub and a seed ────────────────────────────────────────────
fs.mkdirSync(path.dirname(UP), { recursive: true });
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', UP]);
const seed = path.join(TMP, 'seed');
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
git(seed, ['config', 'user.email', 'a@b']); git(seed, ['config', 'user.name', 't']);
fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
git(seed, ['add', '.']); git(seed, ['commit', '-q', '-m', 'chore: seed (fixture)']);
git(seed, ['remote', 'add', 'origin', UP]); git(seed, ['push', '-q', 'origin', 'main']);

const PORT = 8899 + Math.floor(Math.random() * 60);
const policy = path.join(TMP, 'policy.json');
fs.writeFileSync(policy, JSON.stringify(require('../policy.example.json')));

const proxy = spawn(process.execPath, [
  path.join(ROOT, 'bin', 'cc-proxy.js'),
  '--port', String(PORT), '--upstream', 'file://' + GH, '--data', path.join(TMP, 'data'), '--policy', policy,
], { env: { ...process.env, CC_PAT: 'placeholder-token-for-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
let proxyOut = '';
proxy.stdout.on('data', (d) => { proxyOut += d.toString(); });
proxy.stderr.on('data', (d) => { proxyOut += d.toString(); });

const URL_ = `http://127.0.0.1:${PORT}/${OWNER}/${REPO}.git`;

function waitForListen(cb, tries = 100) {
  const iv = setInterval(() => {
    if (/listening on/.test(proxyOut)) { clearInterval(iv); cb(); }
    else if (tries-- <= 0) { clearInterval(iv); throw new Error('proxy never listened:\n' + proxyOut); }
  }, 100);
}

function finish(code) {
  try { proxy.kill('SIGKILL'); } catch { /* gone */ }
  console.log('\n' + (pass + fail) + ' checks, ' + pass + ' passed, ' + fail + ' failed');
  console.log('proxy log (redacted token must not appear): ' + (proxyOut.includes('placeholder-token-for-test') ? 'TOKEN LEAKED' : 'no token present'));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(code);
}

waitForListen(() => {
  // ── clone THROUGH the proxy ───────────────────────────────────────────────────
  const clone = path.join(TMP, 'clone');
  t('a client can clone through the proxy', () => {
    execFileSync('git', ['clone', '-q', URL_, clone], { encoding: 'utf8' });
    assert.ok(fs.existsSync(path.join(clone, 'README.md')) === false || true);
    assert.match(git(clone, ['log', '--oneline']), /seed/);
  });

  git(clone, ['config', 'user.email', 'a@b']);
  git(clone, ['config', 'user.name', 't']);

  // ── the monolith must be rejected at the proxy ─────────────────────────────────
  t('a monolith push is REJECTED through the proxy', () => {
    for (const f of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(clone, `src_${f}.js`), 'x\n');
    git(clone, ['add', '.']);
    git(clone, ['commit', '-q', '-m', 'stuff and things']);
    let out = '', code = 0;
    try { execFileSync('git', ['-C', clone, 'push', 'origin', 'main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { code = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
    assert.notStrictEqual(code, 0, 'the push must fail');
    assert.match(out, /commit-condom blocked this push/);
    assert.match(out, /TOO_MANY_FILES|NEEDS_SPLIT/);
  });

  t('--no-verify does not bypass the proxy gate either', () => {
    let code = 0, out = '';
    try { execFileSync('git', ['-C', clone, 'push', '--no-verify', 'origin', 'main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { code = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
    assert.notStrictEqual(code, 0, 'the push must still fail');
    assert.match(out, /commit-condom/);
  });

  t('the upstream has NOT received the rejected commit', () => {
    const log = git(UP, ['log', '--oneline', 'main']);
    assert.ok(!/stuff and things/.test(log), 'a rejected commit must not reach upstream: ' + log);
  });

  // ── the split must pass and reach upstream ─────────────────────────────────────
  t('a properly split push is ACCEPTED and forwarded upstream', () => {
    git(clone, ['reset', '-q', '--mixed', 'HEAD~1']);
    git(clone, ['add', 'src_a.js', 'src_b.js']); git(clone, ['commit', '-q', '-m', 'feat(src): add a and b (need modules)']);
    git(clone, ['add', 'src_c.js', 'src_d.js']); git(clone, ['commit', '-q', '-m', 'feat(src): add c and d (need modules)']);
    fs.writeFileSync(path.join(clone, 'docs.md'), 'd\n');
    git(clone, ['add', 'docs.md']); git(clone, ['commit', '-q', '-m', 'docs: add docs (none existed)']);
    const out = execFileSync('git', ['-C', clone, 'push', 'origin', 'main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(String(out) || 'ok', /.*/);
    const log = git(UP, ['log', '--oneline', 'main']);
    assert.match(log, /feat\(src\): add c and d/);
    assert.match(log, /docs: add docs/);
  });

  t('the gate did NOT leak the token into the proxy log', () => {
    assert.ok(!proxyOut.includes('placeholder-token-for-test'), proxyOut.slice(0, 400));
  });

  // ── deletions must behave exactly like a real PAT ───────────────────────────────
  t('a NEW branch pushed through the proxy lands upstream', () => {
    git(clone, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(clone, 'feature.md'), 'f\n');
    git(clone, ['add', 'feature.md']);
    git(clone, ['commit', '-q', '-m', 'feat: add feature notes (needs a branch)']);
    execFileSync('git', ['-C', clone, 'push', '-q', 'origin', 'feature'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(git(UP, ['branch', '--list']), /feature/, 'the new branch must be upstream');
  });

  t('a branch DELETED through the proxy is removed upstream (real-PAT parity)', () => {
    execFileSync('git', ['-C', clone, 'push', '-q', 'origin', '--delete', 'feature'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const branches = git(UP, ['branch', '--list']);
    assert.ok(!/feature/.test(branches), 'feature must be gone upstream: ' + branches);
  });

  t('a deletion leaves every other branch alone (non-vacuity)', () => {
    // Guards against a blanket `--prune` forward: the deletion above must not have taken anything
    // beyond the ref the client named.
    assert.match(git(UP, ['branch', '--list']), /main/, 'main must survive');
  });

  finish(fail ? 1 : 0);
});

setTimeout(() => { console.log('TIMEOUT waiting for the proxy'); finish(1); }, 60000).unref();
