#!/usr/bin/env node
'use strict';
/*
 * MCP tool tests against a real repository. These prove the COOPERATIVE path works: an agent
 * that asks cc_plan / cc_commit gets the right shape without ever being rejected.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const M = require('../mcp/server');
const L = require('../src/ledger');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-'));
const repo = path.join(TMP, 'r');
fs.mkdirSync(repo, { recursive: true });
const g = (a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
g(['init', '-q', '-b', 'main']);
g(['config', 'user.email', 'a@b']);
g(['config', 'user.name', 't']);
fs.writeFileSync(path.join(repo, '.condom.json'), JSON.stringify(require('../policy.example.json')));
g(['commit', '-q', '--allow-empty', '-m', 'chore: seed (fixture)']);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok   ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n').slice(0, 3).join('\n     ')); fail++; }
};

t('cc_status reports the branch and the policy in force', () => {
  const s = M.callStatus({ repo });
  assert.strictEqual(s.branch, 'main');
  assert.strictEqual(s.max_files_per_commit, 2);
  assert.strictEqual(s.policy_source, path.join(repo, '.condom.json'));
});

t('cc_plan groups a dirty tree into policy-sized commits', () => {
  for (const f of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(repo, `src_${f}.js`), 'x\n');
  const plan = M.callPlan({ repo });
  assert.strictEqual(plan.files, 4);
  assert.ok(plan.commits >= 2, 'four files with a cap of 2 must plan at least two commits: ' + JSON.stringify(plan));
  assert.ok(plan.plan.every((c) => c.files.length <= 2));
});

t('cc_commit REFUSES too many paths', () => {
  const r = M.callCommit({ repo, paths: ['src_a.js', 'src_b.js', 'src_c.js'], message: 'feat(x): add three (test)' });
  assert.strictEqual(r.committed, false);
  assert.strictEqual(r.code, 'TOO_MANY_FILES');
  assert.match(r.fix, /cc_plan/);
});

t('cc_commit REFUSES a non-conventional message', () => {
  const r = M.callCommit({ repo, paths: ['src_a.js'], message: 'added some stuff' });
  assert.strictEqual(r.committed, false);
  assert.strictEqual(r.code, 'NOT_CONVENTIONAL');
});

t('cc_commit accepts a valid atomic commit and records it', () => {
  const r = M.callCommit({ repo, paths: ['src_a.js', 'src_b.js'], message: 'feat(src): add a and b (need modules)' });
  assert.strictEqual(r.committed, true, JSON.stringify(r));
  assert.match(r.sha, /^[0-9a-f]{40}$/);
  assert.strictEqual(r.files, 2);
  const log = g(['log', '--oneline', '-1']);
  assert.match(log, /feat\(src\): add a and b/);
});

t('cc_check passes the commit it just made', () => {
  const r = M.callCheck({ repo, range: 'HEAD~1..HEAD' });
  assert.strictEqual(r.ok, true, JSON.stringify(r.violations));
});

t('cc_check reports the violations on a bad commit', () => {
  fs.writeFileSync(path.join(repo, 'big.js'), 'y\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'nope']);
  const r = M.callCheck({ repo, range: 'HEAD~1..HEAD' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === 'NOT_CONVENTIONAL'), JSON.stringify(r.violations));
  assert.match(r.report, /commit-condom blocked/);
});

t('cc_audit returns an intact chain with the accepted commit in it', () => {
  const a = M.callAudit({ repo });
  assert.strictEqual(a.verify.ok, true, JSON.stringify(a.verify));
  assert.ok(a.total >= 1);
  assert.ok(a.entries.some((e) => /feat\(src\): add a and b/.test(e.subject)), JSON.stringify(a.entries));
});

t('the ledger chain breaks if an entry is edited', () => {
  const f = L.ledgerPath(repo);
  const orig = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, orig.replace(/"files":2/, '"files":99'));
  assert.strictEqual(L.verify(repo).ok, false, 'an edited entry must break the chain');
  fs.writeFileSync(f, orig);
  assert.strictEqual(L.verify(repo).ok, true, 'restoring it must repair the chain');
});

t('cc_commit refuses outside a git work tree', () => {
  let threw = false;
  try { M.callCommit({ repo: TMP, paths: ['x'], message: 'feat(x): y (z)' }); } catch { threw = true; }
  assert.strictEqual(threw, true);
});

console.log('\n' + (pass + fail) + ' checks, ' + pass + ' passed, ' + fail + ' failed');
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
