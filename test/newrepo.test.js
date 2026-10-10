#!/usr/bin/env node
'use strict';
/*
 * New-repo behavior: the first push to a repository with nothing published gets a looser size
 * ceiling (a bulk import), while everything else — the secret scan, the conventional-commit
 * rule — still applies. Two halves, and the second is the one that matters: the loosening must
 * NOT leak into a repo that already has a remote, or it is just a bypass with extra steps.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CC = path.join(__dirname, '..', 'bin', 'cc.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok   ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); fail++; }
};

function mkrepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-newrepo-'));
  const g = (a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t.t']);
  g(['config', 'user.name', 't']);
  return { d, g };
}

function commitFiles(d, g, n) {
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), `content ${i}\n`);
  g(['add', '-A']);
  g(['commit', '-q', '-m', `feat: import ${n} files (bulk init)`]);
}

function runCheck(d) {
  try {
    return { code: 0, out: execFileSync('node', [CC, 'check', '--repo', d], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// ── a fresh repo with a 5-file commit (default cap is 2) passes ────────────────
t('a brand-new repo accepts a >2-file initial import', () => {
  const { d, g } = mkrepo();
  commitFiles(d, g, 5);
  const r = runCheck(d);
  assert.strictEqual(r.code, 0, 'expected PASS on a new repo, got:\n' + r.out);
  assert.match(r.out, /PASS/);
});

// ── the same commit is rejected once the repo has a remote (the loosening is scoped) ──
t('the SAME commit is rejected once the repo has a remote', () => {
  const { d, g } = mkrepo();
  commitFiles(d, g, 2);                 // a legal first commit
  // pretend a remote-tracking ref exists, as it would on any repo that has been pushed before
  g(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  // now add a 5-file commit on top — this must hit the normal, strict cap
  commitFiles(d, g, 5);
  const r = runCheck(d, {});
  assert.notStrictEqual(r.code, 0, 'expected FAIL on a repo with a remote, got PASS:\n' + r.out);
  assert.match(r.out, /max_files_per_commit|files/i);
});

// ── the secret scan still fires on a brand-new repo (loosening is size only) ────
t('a brand-new repo still blocks a leaked secret', () => {
  const { d, g } = mkrepo();
  fs.writeFileSync(path.join(d, 'creds.txt'), 'token = ghp_' + 'A'.repeat(30) + '\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'feat: add config (initial)']);
  const r = runCheck(d);
  assert.notStrictEqual(r.code, 0, 'expected the secret to be blocked:\n' + r.out);
});

console.log(`\n${pass + fail} checks, ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
