#!/usr/bin/env node
'use strict';
/*
 * cc-wire-machine agent — the dummy-PAT handoff.
 *
 * The model: the real PAT lives only in the proxy; every agent gets a token that is deliberately
 * not real. Through the proxy it works (the proxy forwards with the real PAT) and is gated;
 * straight to GitHub it fails, so the proxy cannot be stepped around.
 *
 * Hermetic: HOME points at a temp dir, so this never touches the real ~/.gitconfig or
 * ~/.git-credentials.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'cc-wire-machine.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wire-'));
const REAL = 'ghp_REALrealrealrealrealrealrealreal1234';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok   ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); fail++; }
};

const run = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

const CRED = path.join(HOME, '.git-credentials');
const readCred = () => (fs.existsSync(CRED) ? fs.readFileSync(CRED, 'utf8') : '');

try {
  fs.mkdirSync(path.join(HOME, '.config', 'commit-condom'), { recursive: true });

  // ── refuse with no real PAT behind the proxy ─────────────────────────────────
  t('refuses to install a dummy when the proxy has no real PAT', () => {
    const r = run(['agent']);
    assert.strictEqual(r.code, 2, 'must refuse: ' + r.out);
    assert.match(r.out, /does not exist/);
  });

  // ── set up: the real PAT is in the store, as it would be before wiring ───────
  fs.writeFileSync(path.join(HOME, '.config', 'commit-condom', 'pat.env'), `CC_PAT=${REAL}\n`, { mode: 0o600 });
  fs.writeFileSync(CRED, `https://x-access-token:${REAL}@github.com\n`, { mode: 0o600 });

  t('status reports the real PAT sitting in the store (the thing we are removing)', () => {
    const r = run(['status']);
    assert.match(r.out, /"REAL_PAT_in_credential_store": true/);
  });

  // ── install: wires the rewrite, strips the real PAT, installs a dummy ────────
  t('install removes the real PAT from the store and leaves a dummy', () => {
    const r = run(['install']);
    assert.strictEqual(r.code, 0, r.out);
    const cred = readCred();
    assert.ok(!cred.includes(REAL), 'the real PAT must be gone: ' + cred);
    assert.match(cred, /github\.com/, 'a github credential must remain for the agent to send');
    assert.match(cred, /ghp_dummy_agent_token_not_real/, 'the dummy must be the one left');
  });

  t('after install, status reports the real PAT is NOT in the store', () => {
    const r = run(['status']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /"REAL_PAT_in_credential_store": false/);
    assert.match(r.out, /"github_through_proxy": true/);
  });

  t('the rewrite routes github.com through the proxy', () => {
    const gc = fs.readFileSync(path.join(HOME, '.gitconfig'), 'utf8');
    assert.match(gc, /insteadof = https:\/\/github\.com\//i);
    assert.match(gc, /127\.0\.0\.1:8877/);
  });

  // ── refuse a "dummy" that is actually the real PAT ──────────────────────────
  t('refuses a dummy identical to the real PAT', () => {
    const r = run(['agent', '--dummy', REAL]);
    assert.strictEqual(r.code, 2, 'must refuse: ' + r.out);
    assert.match(r.out, /identical to the real PAT/);
  });

  t('a custom dummy is accepted and the real PAT stays out of the store', () => {
    const r = run(['agent', '--dummy', 'ghp_my_own_dummy_abc123']);
    assert.strictEqual(r.code, 0, r.out);
    const cred = readCred();
    assert.match(cred, /ghp_my_own_dummy_abc123/);
    assert.ok(!cred.includes(REAL), 'still no real PAT: ' + cred);
  });

  t('the real PAT never appears in any agent-readable output', () => {
    for (const args of [['status'], ['agent']]) {
      const r = run(args);
      assert.ok(!r.out.includes(REAL), `${args.join(' ')} leaked the real PAT`);
    }
  });
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
