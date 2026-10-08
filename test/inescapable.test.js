#!/usr/bin/env node
'use strict';
/*
 * The inescapable-gate test.
 *
 * The scenario that used to fail open: the machine policy is deliberately PERMISSIVE (a strict
 * file cap on every repo would block ordinary work), so a repo that wants strict rules declares
 * them in .condom.json and a client-side hook reads them. `git push --no-verify` skips that hook,
 * and the proxy — which applies only the machine policy — then lets the monolith through.
 *
 * The fix: the proxy resolves a per-repo policy from a registry IT owns (<dataDir>/policies),
 * which a pusher cannot edit or delete with git. This proves, over a real git smart-HTTP push:
 *   - with the repo registered strict, a --no-verify monolith is BLOCKED and never reaches upstream
 *   - with the repo not registered (and a permissive machine policy), the same push is allowed,
 *     so the registry — not the machine policy — is what is doing the work.
 *
 * Hermetic: no network, no real token. "GitHub" is a local bare repo with the same layout.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-inescapable-'));
const GH = path.join(TMP, 'github');
const OWNER = 'acme', REPO = 'demo';
const UP = path.join(GH, OWNER, `${REPO}.git`);

const git = (cwd, args, opts = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', ...opts });

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok   ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 4).join('\n     ')); fail++; }
};

// ── fake GitHub + seed ──────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(UP), { recursive: true });
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', UP]);
const seed = path.join(TMP, 'seed');
execFileSync('git', ['init', '-q', '-b', 'main', seed]);
git(seed, ['config', 'user.email', 'a@b']); git(seed, ['config', 'user.name', 't']);
fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
git(seed, ['add', '.']); git(seed, ['commit', '-q', '-m', 'chore: seed (fixture)']);
git(seed, ['remote', 'add', 'origin', UP]); git(seed, ['push', '-q', 'origin', 'main']);

// The machine policy: permissive on purpose, so it is NOT what blocks anything below.
const PERMISSIVE = path.join(TMP, 'permissive.json');
fs.writeFileSync(PERMISSIVE, JSON.stringify({
  max_diff_lines: 999999,
  max_files_per_commit: 999,
  require_conventional: false,
  max_subject_length: 400,
  chunking: {},
  block_diff_patterns: [],
  session_budget: { max_commits: 9999, max_total_lines: 999999 },
}));
// The repo policy: strict.
const STRICT = path.join(TMP, 'strict.json');
fs.writeFileSync(STRICT, JSON.stringify(require('../policy.example.json')));

const DATA = path.join(TMP, 'data');
const PORT = 8960 + Math.floor(Math.random() * 30);

const proxy = spawn(process.execPath, [
  path.join(ROOT, 'bin', 'cc-proxy.js'),
  '--port', String(PORT), '--upstream', 'file://' + GH, '--data', DATA, '--policy', PERMISSIVE,
], { env: { ...process.env, CC_PAT: 'placeholder-token-for-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
let proxyOut = '';
proxy.stdout.on('data', (d) => { proxyOut += d.toString(); });
proxy.stderr.on('data', (d) => { proxyOut += d.toString(); });

const URL_ = `http://127.0.0.1:${PORT}/${OWNER}/${REPO}.git`;
const clone = path.join(TMP, 'clone');

function push(clone, { noVerify = false } = {}) {
  const args = ['-C', clone, 'push', ...(noVerify ? ['--no-verify'] : []), 'origin', 'main'];
  try { execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, out: '' }; }
  catch (e) { return { code: e.status || 1, out: String(e.stdout || '') + String(e.stderr || '') }; }
}

function monolith(files, subject) {
  for (const f of files) fs.writeFileSync(path.join(clone, f), 'x\n');
  git(clone, ['add', '.']);
  git(clone, ['commit', '-q', '-m', subject]);
}

function waitForListen(cb, tries = 120) {
  const iv = setInterval(() => {
    if (/listening on/.test(proxyOut)) { clearInterval(iv); cb(); }
    else if (tries-- <= 0) { clearInterval(iv); console.error('proxy never listened:\n' + proxyOut); finish(1); }
  }, 100);
}

function finish(code) {
  try { proxy.kill('SIGKILL'); } catch { /* gone */ }
  console.log('\n' + (pass + fail) + ' checks, ' + pass + ' passed, ' + fail + ' failed');
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(code);
}

waitForListen(() => {
  t('a client clones through the proxy', () => {
    execFileSync('git', ['clone', '-q', URL_, clone], { encoding: 'utf8' });
    assert.match(git(clone, ['log', '--oneline']), /seed/);
  });
  git(clone, ['config', 'user.email', 'a@b']); git(clone, ['config', 'user.name', 't']);

  // ── part 1: NOT registered → the permissive machine policy lets the monolith through ──
  t('unregistered repo + permissive machine policy: a monolith is allowed (so the registry is what blocks)', () => {
    monolith(['one.js', 'two.js', 'three.js'], 'lump it all in');
    const r = push(clone);
    assert.strictEqual(r.code, 0, 'expected the permissive machine policy to allow it: ' + r.out);
  });

  // ── part 2: register a STRICT policy the pusher cannot see or change ────────────────
  t('cc policy set registers the repo policy in the proxy-owned registry', () => {
    execFileSync(process.execPath, [path.join(ROOT, 'bin', 'cc.js'), 'policy', 'set', `${OWNER}/${REPO}`, STRICT, '--data', DATA], { encoding: 'utf8' });
    assert.ok(fs.existsSync(path.join(DATA, 'policies', `${OWNER}__${REPO}.json`)), 'the registry entry must exist');
  });

  t('the registry is outside the working tree — git cannot reach it', () => {
    // Nothing in the client clone points at the registry, and it is not a tracked file.
    const tracked = git(clone, ['ls-files']);
    assert.ok(!/policies/.test(tracked), 'the registry must not be a tracked file: ' + tracked);
    assert.ok(!fs.existsSync(path.join(clone, 'policies')), 'the registry is not in the clone');
  });

  // ── part 3: the decisive case — --no-verify must NOT escape ─────────────────────────
  t('a --no-verify monolith on a REGISTERED repo is BLOCKED by the proxy', () => {
    monolith(['four.js', 'five.js', 'six.js'], 'sneak this past with no verify');
    const r = push(clone, { noVerify: true });
    assert.notStrictEqual(r.code, 0, 'the push must fail even with --no-verify');
    assert.match(r.out, /commit-condom/, 'the rejection must name the gate: ' + r.out);
    assert.match(r.out, /TOO_MANY_FILES|NEEDS_SPLIT/, 'the specific violation must be named: ' + r.out);
  });

  t('the rejected --no-verify commit never reached upstream', () => {
    const log = git(UP, ['log', '--oneline', 'main']);
    assert.ok(!/sneak this past/.test(log), 'a rejected commit must not reach upstream: ' + log);
  });

  t('a strictly-compliant split from the same repo is accepted and forwarded', () => {
    git(clone, ['reset', '-q', '--mixed', 'HEAD~1']);
    git(clone, ['add', 'four.js', 'five.js']); git(clone, ['commit', '-q', '-m', 'feat(src): add four and five (need modules)']);
    git(clone, ['add', 'six.js']); git(clone, ['commit', '-q', '-m', 'feat(src): add six (need module)']);
    const r = push(clone);
    assert.strictEqual(r.code, 0, 'a compliant split must pass: ' + r.out);
    assert.match(git(UP, ['log', '--oneline', 'main']), /add six/);
  });

  t('the registry is removable by the operator, and then the gate relaxes again', () => {
    execFileSync(process.execPath, [path.join(ROOT, 'bin', 'cc.js'), 'policy', 'rm', `${OWNER}/${REPO}`, '--data', DATA], { encoding: 'utf8' });
    assert.ok(!fs.existsSync(path.join(DATA, 'policies', `${OWNER}__${REPO}.json`)), 'the entry should be gone');
    monolith(['seven.js', 'eight.js', 'nine.js'], 'lump again after unregister');
    const r = push(clone);
    assert.strictEqual(r.code, 0, 'with no registry entry the permissive machine policy applies: ' + r.out);
  });

  t('the test harness never leaked the token', () => {
    assert.ok(!proxyOut.includes('placeholder-token-for-test'), proxyOut.slice(0, 400));
  });

  finish(fail ? 1 : 0);
});

setTimeout(() => { console.log('TIMEOUT waiting for the proxy'); finish(1); }, 90000).unref();
