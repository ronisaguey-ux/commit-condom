#!/usr/bin/env node
'use strict';
/**
 * cc-wire-machine — point this machine's git at the commit-condom proxy.
 *
 *   node bin/cc-wire-machine.js status    what is wired right now
 *   node bin/cc-wire-machine.js install   route github.com through the proxy, move the PAT
 *   node bin/cc-wire-machine.js revert    undo it, restoring the previous credential store
 *
 * install rewrites every https://github.com/ URL to the local proxy and removes the GitHub
 * token from ~/.git-credentials, so the PAT lives only in the proxy. It backs both files up
 * first. It does NOT enforce the commit policy on every repo — the machine policy is a
 * credential gateway plus a secret scan; strict rules stay opt-in per project.
 *
 * An ssh remote (git@github.com:...) is not an http URL and never reaches the proxy; `status`
 * reports any it finds.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const PROXY = 'http://127.0.0.1:8877/';
const GITHUB = ['https://github.com/', 'https://www.github.com/'];
const CRED = path.join(HOME, '.git-credentials');

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });

function rewrites() {
  try {
    return git('config', '--global', '--get-regexp', '^url\\.').trim().split('\n')
      .map((l) => l.replace(/^url\.(\S+)\.insteadof\s+/i, '$1 → '));
  } catch { return []; }
}

function credHasGithub() {
  try { return /github\.com/.test(fs.readFileSync(CRED, 'utf8')); } catch { return false; }
}

/** The real PAT, read from the file the proxy service loads. Never printed. */
function realPat() {
  try {
    const m = fs.readFileSync(path.join(HOME, '.config', 'commit-condom', 'pat.env'), 'utf8')
      .match(/(?:CC_PAT|GITHUB_PAT)\s*=\s*(\S+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}

/**
 * The security-relevant fact is not "is there a github credential" but "is the REAL PAT in it".
 * A dummy line looks the same at a glance, so compare against the actual token rather than
 * reporting mere presence.
 */
function credHasRealPat() {
  const real = realPat();
  if (!real) return false;
  try { return fs.readFileSync(CRED, 'utf8').includes(real); } catch { return false; }
}

function sshRemotes() {
  const found = [];
  const roots = [path.join(HOME, 'Roni_workspace')];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      const cfg = path.join(root, n, '.git', 'config');
      try {
        const t = fs.readFileSync(cfg, 'utf8');
        if (/git@github\.com:/.test(t)) found.push(path.join(root, n));
      } catch { /* not a repo */ }
    }
  }
  return found;
}

function cmdStatus() {
  const r = rewrites();
  const wired = r.some((x) => x.includes(PROXY.replace(/\/$/, '')));
  let svc = 'unknown';
  try { svc = execFileSync('systemctl', ['--user', 'is-active', 'commit-condom'], { encoding: 'utf8' }).trim(); }
  catch (e) { svc = String(e.stdout || '').trim() || 'inactive'; }
  const out = {
    proxy: PROXY,
    rewrites: r,
    github_through_proxy: wired,
    service: svc,
    credential_store_has_github: credHasGithub(),
    REAL_PAT_in_credential_store: credHasRealPat(),
    ssh_remotes_that_bypass: sshRemotes(),
  };
  console.log(JSON.stringify(out, null, 2));
  // Healthy: routed through the proxy, and the real PAT is NOT sitting in the agent's store.
  return wired && !credHasRealPat() ? 0 : 1;
}

function cmdInstall() {
  if (credHasRealPat()) {
    // Move the token into the proxy before removing it from the store, or the machine loses auth.
    const env = path.join(HOME, '.config', 'commit-condom', 'pat.env');
    if (!fs.existsSync(env)) {
      console.error(`refusing to install: ${env} does not exist, so moving the PAT would lock you out.`);
      console.error('Create it first (CC_PAT=... , mode 600) or run the proxy with the PAT set.');
      return 2;
    }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bk = path.join(HOME, `.commit-condom-backup-${ts}`);
  fs.mkdirSync(bk, { recursive: true, mode: 0o700 });
  for (const f of [path.join(HOME, '.gitconfig'), CRED]) {
    try { fs.copyFileSync(f, path.join(bk, path.basename(f))); } catch { /* absent */ }
  }
  for (const g of GITHUB) {
    try { git('config', '--global', '--unset-all', `url.${PROXY}.insteadOf`); } catch { /* none */ }
  }
  for (const g of GITHUB) git('config', '--global', '--add', `url.${PROXY}.insteadOf`, g);

  // Strip only github.com lines; another host's credential is left alone.
  const lines = fs.existsSync(CRED) ? fs.readFileSync(CRED, 'utf8').split('\n') : [];
  const kept = lines.filter((l) => l.trim() && !l.includes('github.com'));
  fs.writeFileSync(CRED, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });

  console.log(JSON.stringify({ backup: bk, rewrites: rewrites(), REAL_PAT_in_credential_store: credHasRealPat() }, null, 2));

  // Leave the agent a DUMMY token, so git has a credential to send and a direct push still fails.
  return cmdAgent();
}

/**
 * Give the agent a DUMMY PAT.
 *
 * The real token lives only in the proxy. The agent's credential store holds a token that is
 * deliberately not real, so:
 *   - going THROUGH the proxy works (the proxy ignores the client's credential and forwards with
 *     the real PAT), and every push is gated by the rules;
 *   - going DIRECTLY to GitHub fails — GitHub rejects a dummy, so the agent cannot step around
 *     the proxy by editing its remote.
 * One real token behind the gate, and nothing but a useless one in front of it.
 */
const DUMMY_DEFAULT = 'ghp_dummy_agent_token_not_real_000000000000';

function cmdAgent() {
  const i = process.argv.indexOf('--dummy');
  const token = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : DUMMY_DEFAULT;

  // Refuse if the real PAT is not behind the proxy, or a dummy would lock the agent out entirely.
  const patEnv = path.join(HOME, '.config', 'commit-condom', 'pat.env');
  if (!fs.existsSync(patEnv)) {
    console.error(`refusing: ${patEnv} does not exist — the proxy has no real PAT, so a dummy would lock the agent out of every push.`);
    return 2;
  }
  const real = realPat();
  if (real && token === real) {
    console.error('refusing: the dummy token is identical to the real PAT — that is not a dummy.');
    return 2;
  }

  const wired = rewrites().some((x) => x.includes(PROXY.replace(/\/$/, '')));
  if (!wired) {
    console.error('refusing: github.com is not rewritten to the proxy. Run `install` first.');
    return 2;
  }

  // Write the dummy for github.com only; any other host's credential is preserved.
  const lines = fs.existsSync(CRED) ? fs.readFileSync(CRED, 'utf8').split('\n') : [];
  const kept = lines.filter((l) => l.trim() && !l.includes('github.com'));
  kept.push(`https://x-access-token:${token}@github.com`);
  fs.writeFileSync(CRED, kept.join('\n') + '\n', { mode: 0o600 });

  const realLeaked = Boolean(real) && fs.readFileSync(CRED, 'utf8').includes(real);
  console.log(JSON.stringify({
    dummy_installed: true,
    dummy_token_hint: token.slice(0, 12) + '…',
    real_pat_in_agent_store: realLeaked,
    github_through_proxy: wired,
    note: 'The agent can push only through the proxy. A direct push to GitHub fails, because the dummy is not a real token.',
  }, null, 2));
  return realLeaked ? 1 : 0;
}

function cmdRevert() {
  for (const g of GITHUB) {
    try { git('config', '--global', '--unset-all', `url.${PROXY}.insteadOf`); } catch { /* none */ }
  }
  // newest backup wins
  const backups = fs.readdirSync(HOME).filter((d) => d.startsWith('.commit-condom-backup-')).sort();
  const latest = backups.length ? path.join(HOME, backups[backups.length - 1]) : null;
  let restored = false;
  if (latest && fs.existsSync(path.join(latest, 'git-credentials'))) {
    fs.copyFileSync(path.join(latest, 'git-credentials'), CRED);
    fs.chmodSync(CRED, 0o600);
    restored = true;
  }
  console.log(JSON.stringify({ rewrites: rewrites(), credential_store_restored_from: restored ? latest : null }, null, 2));
  return 0;
}

const cmd = process.argv[2] || 'status';
const table = { status: cmdStatus, install: cmdInstall, revert: cmdRevert, agent: cmdAgent };
const fn = table[cmd];
if (!fn) { console.error('usage: cc-wire-machine <status|install|agent|revert>'); process.exit(2); }
process.exit(fn() || 0);
