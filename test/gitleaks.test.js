'use strict';
/**
 * gitleaks second gate — behaviour that matters.
 *
 * The gate is optional, so the first thing every test proves is which state it is in: off means
 * off (no violations, no binary needed), and on means it actually blocks. A secret gate that
 * silently passes is the exact failure mode this file exists to prevent, so the last case is the
 * one that matters most: enabled + broken binary must FAIL CLOSED.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const G = require('../src/gitleaks');
const P = require('../src/policy');

const CC = path.resolve(__dirname, '..', 'bin', 'cc.js');
let pass = 0;
let fail = 0;

function ok(name, fn) {
  try { fn(); console.log(`ok   ${name}`); pass += 1; } catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); fail += 1; }
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gitleaks-'));
  execFileSync('git', ['init', '-q', dir]);
  const run = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  // A base commit, so every fixture commit has a parent: `sha~1` on a root commit does not
  // resolve, and an unresolvable range is exactly what the gate must refuse rather than scan.
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  run('add', 'base.txt');
  run('commit', '-qm', 'chore(test): base');
  return { dir, run };
}

function commit(dir, file, content, message = 'feat(test): fixture') {
  fs.writeFileSync(path.join(dir, file), content);
  execFileSync('git', ['-C', dir, 'add', file]);
  execFileSync('git', ['-C', dir, 'commit', '-qm', message]);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

// A generic high-entropy assignment, which gitleaks' generic-api-key rule flags and the
// built-in hand-written patterns do NOT (it is not an sk-/ghp_/AKIA shape). That asymmetry is
// the whole argument for a second gate.
const LEAK = 'const api_key = "3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c";\n';

ok('off by default: enabled() is false with no policy and no env', () => {
  delete process.env.CC_GITLEAKS;
  assert.strictEqual(G.enabled({}), false);
  assert.strictEqual(G.enabled({ gitleaks: {} }), false);
});

ok('off by default: a leaking commit records no gitleaks violation', () => {
  delete process.env.CC_GITLEAKS;
  const { dir } = repo();
  const sha = commit(dir, 'leak.js', LEAK);
  const r = G.scan(dir, { base: `${sha}~1`, head: sha, policy: {} });
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.violations, []);
});

ok('policy.gitleaks.enabled blocks a secret the regex gate would miss', () => {
  const { dir } = repo();
  const sha = commit(dir, 'leak.js', LEAK);
  const policy = { gitleaks: { enabled: true } };
  const r = G.scan(dir, { base: `${sha}~1`, head: sha, policy });
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations[0].code, 'GITLEAKS_SECRET');
  assert.match(r.violations[0].detail, /leak\.js:1/);
  assert.match(r.violations[0].detail, /generic-api-key/);
});

ok('a clean commit passes with the gate on', () => {
  const { dir } = repo();
  const sha = commit(dir, 'clean.js', 'export const add = (a, b) => a + b;\n');
  const r = G.scan(dir, { base: `${sha}~1`, head: sha, policy: { gitleaks: { enabled: true } } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.violations));
  assert.strictEqual(r.violations.length, 0);
});

ok('the finding never echoes the secret itself', () => {
  const { dir } = repo();
  const sha = commit(dir, 'leak.js', LEAK);
  const r = G.scan(dir, { base: `${sha}~1`, head: sha, policy: { gitleaks: { enabled: true } } });
  assert.ok(!JSON.stringify(r.violations).includes('3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'));
});

ok('enabled + missing binary FAILS CLOSED, it does not pass', () => {
  const { dir } = repo();
  const sha = commit(dir, 'clean.js', 'const x = 1;\n');
  const r = G.scan(dir, {
    base: `${sha}~1`, head: sha,
    policy: { gitleaks: { enabled: true, binary: '/nonexistent/gitleaks' } },
  });
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations[0].code, 'GITLEAKS_UNAVAILABLE');
});

ok('CC_GITLEAKS=1 forces the gate on, CC_GITLEAKS=0 forces it off', () => {
  process.env.CC_GITLEAKS = '1';
  assert.strictEqual(G.enabled({}), true);
  assert.strictEqual(G.enabled({ gitleaks: { enabled: false } }), true);
  process.env.CC_GITLEAKS = '0';
  assert.strictEqual(G.enabled({ gitleaks: { enabled: true } }), false);
  delete process.env.CC_GITLEAKS;
});

ok('cc check reports the gitleaks violation and exits 1 (end to end)', () => {
  const { dir } = repo();
  const sha = commit(dir, 'leak.js', LEAK);
  fs.writeFileSync(path.join(dir, '.condom.json'), JSON.stringify({ gitleaks: { enabled: true } }));
  let status = 0;
  let output = '';
  try {
    execFileSync(process.execPath, [CC, 'check', '--repo', dir, '--range', `${sha}~1..${sha}`], {
      encoding: 'utf8', env: { ...process.env, CC_NO_MACHINE_POLICY: '1' },
    });
  } catch (e) {
    status = e.status;
    output = `${e.stdout || ''}${e.stderr || ''}`;
  }
  assert.strictEqual(status, 1, 'a leaking commit must be rejected');
  assert.match(output, /GITLEAKS_SECRET/);
});

ok('cc check passes the same range once the gate is off again', () => {
  const { dir } = repo();
  const sha = commit(dir, 'leak.js', LEAK);
  fs.writeFileSync(path.join(dir, '.condom.json'), JSON.stringify({ max_files_per_commit: 2 }));
  execFileSync(process.execPath, [CC, 'check', '--repo', dir, '--range', `${sha}~1..${sha}`], {
    encoding: 'utf8', env: { ...process.env, CC_NO_MACHINE_POLICY: '1', CC_GITLEAKS: '0' },
  });
});

ok('staged scan mode sees the index before the commit exists', () => {
  const { dir } = repo();
  fs.writeFileSync(path.join(dir, 'staged.js'), LEAK);
  execFileSync('git', ['-C', dir, 'add', 'staged.js']);
  const r = G.scan(dir, { staged: true, policy: { gitleaks: { enabled: true } } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations[0].code, 'GITLEAKS_SECRET');
});

ok('logOpts asks for new commits on a zero base, never an empty range', () => {
  assert.strictEqual(G.logOpts('0'.repeat(40), 'abc'), 'abc --not --all');
  assert.strictEqual(G.logOpts('', 'abc'), 'abc --not --all');
  assert.strictEqual(G.logOpts('aaa', 'bbb'), 'aaa..bbb');
});

console.log(`\n${pass + fail} checks, ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
