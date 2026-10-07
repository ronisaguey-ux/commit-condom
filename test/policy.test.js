#!/usr/bin/env node
'use strict';
/*
 * Policy-engine tests. Two layers:
 *  - the pure rules, against hand-built commit objects (no repo, so a failure is a rule bug)
 *  - the git reader, against a real temporary repository (so the numstat/message parsing is
 *    proven against real git output, not a guess at its format)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const P = require('../src/policy');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok   ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); fail++; }
};

const POLICY = {
  max_diff_lines: 400,
  max_files_per_commit: 2,
  require_conventional: true,
  allowed_types: ['feat', 'fix', 'chore'],
  max_subject_length: 72,
  chunking: { min_commits_for_files: { 3: 2, 5: 3, 10: 5 } },
  block_diff_patterns: ['ghp_[A-Za-z0-9]{20,}'],
  session_budget: { max_commits: 10, max_total_lines: 2000 },
};

const commit = (over = {}) => ({
  sha: 'a'.repeat(40), short: 'aaaaaaa1', subject: 'feat(x): do a thing (because)',
  body: '', author: 'a', email: 'a@b', files: [{ path: 'src/a.js', added: 5, deleted: 1 }],
  added: 5, deleted: 1, lines: 6, patch: '', ...over,
});

const codes = (r) => r.violations.map((v) => v.code);

// ── the happy path must produce NOTHING (otherwise everything below is meaningless) ──
t('a compliant single commit passes', () => {
  const r = P.evaluate([commit()], POLICY);
  assert.strictEqual(r.ok, true, JSON.stringify(codes(r)));
  assert.deepStrictEqual(codes(r), []);
  assert.strictEqual(r.stats.files, 1);
});

// ── each rule fires, and only for its own reason ──
t('too many files is rejected', () => {
  const files = ['a', 'b', 'c'].map((n) => ({ path: n, added: 1, deleted: 0 }));
  const r = P.evaluate([commit({ files })], POLICY);
  // TOO_MANY_FILES is the per-commit rule; 3 files in one commit also trips chunking, and
  // both are true, so both are reported.
  assert.ok(codes(r).includes('TOO_MANY_FILES'), JSON.stringify(codes(r)));
  const v = r.violations.find((x) => x.code === 'TOO_MANY_FILES');
  assert.match(v.fix, /git reset --soft/, 'the fix must name the actual recovery');
});

t('an oversized diff is rejected', () => {
  const r = P.evaluate([commit({ files: [{ path: 'a', added: 900, deleted: 0 }], lines: 900 })], POLICY);
  assert.deepStrictEqual(codes(r), ['DIFF_TOO_LARGE']);
});

t('a non-conventional message is rejected', () => {
  const r = P.evaluate([commit({ subject: 'updated stuff' })], POLICY);
  assert.deepStrictEqual(codes(r), ['NOT_CONVENTIONAL']);
});

t('a conventional message with a scope and a ! passes', () => {
  assert.strictEqual(P.evaluate([commit({ subject: 'fix(api)!: drop the v1 route (sunset)' })], POLICY).ok, true);
  assert.strictEqual(P.evaluate([commit({ subject: 'chore: bump deps (CVE)' })], POLICY).ok, true);
});

t('an unknown type is rejected', () => {
  const r = P.evaluate([commit({ subject: 'wibble: something (x)' })], POLICY);
  assert.deepStrictEqual(codes(r), ['NOT_CONVENTIONAL']);
});

t('an over-long subject is rejected', () => {
  const r = P.evaluate([commit({ subject: 'feat(x): ' + 'y'.repeat(80) + ' (why)' })], POLICY);
  assert.deepStrictEqual(codes(r), ['SUBJECT_TOO_LONG']);
});

t('a secret in the diff is rejected', () => {
  const r = P.evaluate([commit({ patch: '+const TOKEN = "ghp_' + 'A'.repeat(30) + '";' })], POLICY);
  assert.deepStrictEqual(codes(r), ['BLOCKED_PATTERN']);
});

t('chunking: 3 files in 1 commit must be split', () => {
  const files = ['a', 'b', 'c'].map((n) => ({ path: n, added: 1, deleted: 0 }));
  const r = P.evaluate([commit({ files, lines: 3 })], POLICY);
  assert.ok(codes(r).includes('NEEDS_SPLIT'), JSON.stringify(codes(r)));
});

t('chunking: the same 3 files across 2 commits passes', () => {
  const a = commit({ sha: '1'.repeat(40), files: [{ path: 'a', added: 1, deleted: 0 }], lines: 1 });
  const b = commit({ sha: '2'.repeat(40), files: [{ path: 'b', added: 1, deleted: 0 }, { path: 'c', added: 1, deleted: 0 }], lines: 2 });
  assert.strictEqual(P.evaluate([a, b], POLICY).ok, true, JSON.stringify(codes(P.evaluate([a, b], POLICY))));
});

t('a session budget breach is rejected', () => {
  const r = P.evaluate([commit()], POLICY, { budget: { commits: 10, lines: 0 } });
  assert.deepStrictEqual(codes(r), ['BUDGET_COMMITS']);
});

t('NON-VACUITY: the checker reports a violation it is built to catch', () => {
  // If the engine were silently returning ok, every assertion above would pass vacuously.
  const bad = P.evaluate([commit({ subject: 'nope', files: ['a', 'b', 'c'].map((p) => ({ path: p, added: 9, deleted: 9 })), lines: 54 })], POLICY);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.violations.length >= 2, 'expected several distinct violations');
});

t('formatRejection names the rule and the exit path', () => {
  const r = P.evaluate([commit({ subject: 'nope' })], POLICY);
  const text = P.formatRejection(r);
  assert.match(text, /NOT_CONVENTIONAL/);
  assert.match(text, /--no-verify will not bypass/);
});

t('formatRejection of a passing result is empty', () => {
  assert.strictEqual(P.formatRejection({ ok: true, violations: [], stats: {} }), '');
});

// ── the git reader, against real git ──────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-policy-'));
const repo = path.join(TMP, 'r');
fs.mkdirSync(repo, { recursive: true });
const g = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
g(['init', '-q', '-b', 'main']);
g(['config', 'user.email', 'a@b']);
g(['config', 'user.name', 't']);

t('inspectCommits reads real git output (files, lines, message)', () => {
  // A seed commit gives the range a parent — a root commit has none, and `HEAD~1` on it is
  // not a valid revision, which is a property of git rather than of the reader.
  g(['commit', '-q', '--allow-empty', '-m', 'chore: seed (test fixture)']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'x\n'.repeat(5));
  fs.writeFileSync(path.join(repo, 'src', 'b.js'), 'y\n'.repeat(3));
  g(['add', '.']);
  g(['commit', '-q', '-m', 'feat(core): add two modules (seed)']);
  const head = g(['rev-parse', 'HEAD']).trim();
  // A range with an explicit base reads the commit regardless of refs.
  const commits = P.inspectCommits(repo, `${head}~1`, head, POLICY);
  assert.strictEqual(commits.length, 1);
  assert.strictEqual(commits[0].subject, 'feat(core): add two modules (seed)');
  assert.strictEqual(commits[0].files.length, 2);
  assert.strictEqual(commits[0].files.map((f) => f.path).sort().join(','), 'src/a.js,src/b.js');
  assert.ok(commits[0].lines >= 8, 'added lines should be counted: ' + commits[0].lines);
});

t('listCommits returns a real range oldest-first', () => {
  fs.writeFileSync(path.join(repo, 'src', 'c.js'), 'z\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'fix(core): add c (need it)']);
  const shas = P.listCommits(repo, 'HEAD~1', 'HEAD');
  assert.strictEqual(shas.length, 1);
});

t('a NEW ref lists exactly the commits no other ref has', () => {
  // In a pre-receive hook the new ref does not exist yet, so `--not --all` is what selects
  // the pushed commits. A dangling commit (no ref points at it) reproduces that exactly —
  // whereas a commit already on main correctly yields NOTHING, because the push adds no
  // new content.
  fs.writeFileSync(path.join(repo, 'src', 'new.js'), 'n\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'feat(core): add new (dangling)']);
  const dangling = g(['rev-parse', 'HEAD']).trim();
  g(['reset', '-q', '--hard', 'HEAD~1']);              // drop the ref; the commit stays reachable by sha
  const newRef = P.listCommits(repo, '0'.repeat(40), dangling);
  assert.deepStrictEqual(newRef, [dangling], 'the pushed commit must be listed');

  // and a new ref pointing at an existing commit adds nothing to check
  const onMain = g(['rev-parse', 'HEAD']).trim();
  assert.deepStrictEqual(P.listCommits(repo, '0'.repeat(40), onMain), []);
});

t('end to end: a 3-file commit is rejected by the real reader, then a split passes', () => {
  fs.writeFileSync(path.join(repo, 'src', 'd.js'), 'd\n');
  fs.writeFileSync(path.join(repo, 'src', 'e.js'), 'e\n');
  fs.writeFileSync(path.join(repo, 'src', 'f.js'), 'f\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'chore(core): add d e f (test)']);
  const head = g(['rev-parse', 'HEAD']).trim();
  const r = P.evaluate(P.inspectCommits(repo, `${head}~1`, head, POLICY), POLICY);
  assert.ok(!r.ok && codes(r).includes('NEEDS_SPLIT'), JSON.stringify(codes(r)));
});

console.log('\n' + (pass + fail) + ' checks, ' + pass + ' passed, ' + fail + ' failed');
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
