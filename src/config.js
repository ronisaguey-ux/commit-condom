'use strict';
/**
 * Policy loading.
 *
 * Resolution order, first hit wins:
 *   1. an explicit path argument
 *   2. $CC_POLICY
 *   3. <repoDir>/.condom.json
 *   4. <repoDir>/.git/condom.json
 *   5. the built-in defaults below
 *
 * Unknown keys are kept, not dropped, so a typo in one rule does not silently disable
 * another. Missing keys fall back to the default, so a partial file is valid.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  max_diff_lines: 400,
  max_files_per_commit: 2,
  // A brand-new repository's first push is a legitimate bulk import, not a monolith to split:
  // there is no history to keep clean yet. These limits replace the per-commit ones while the
  // repo has nothing published. The secret scan and the conventional-commit rule still apply —
  // only the size ceiling relaxes.
  new_repo_max_files: 150,
  new_repo_max_lines: 15000,
  require_conventional: true,
  allowed_types: ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf', 'build', 'ci', 'style', 'revert'],
  max_subject_length: 72,
  // Files in the whole push -> the minimum number of commits. Read as "if the push touches
  // at least N files, it must be split into at least M commits".
  chunking: { min_commits_for_files: { 3: 2, 5: 3, 10: 5 } },
  block_diff_patterns: [
    '(?i)(ghp_[A-Za-z0-9]{20,})',
    '(?i)(sk-[A-Za-z0-9]{20,})',
    '(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----',
  ],
  session_budget: { max_commits: 10, max_total_lines: 2000 },
};

function _candidatePaths(repoDir, explicit) {
  const out = [];
  if (explicit) out.push(explicit);
  if (process.env.CC_POLICY) out.push(process.env.CC_POLICY);
  if (repoDir) {
    out.push(path.join(repoDir, '.condom.json'));
    out.push(path.join(repoDir, '.git', 'condom.json'));
    // A bare mirror has no worktree, so the proxy drops the policy beside the repo instead.
    out.push(path.join(repoDir, 'condom.json'));
  }
  return out;
}

function loadPolicy({ repoDir, policyPath } = {}) {
  for (const p of _candidatePaths(repoDir, policyPath)) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      return { policy: { ...DEFAULTS, ...parsed }, source: p };
    } catch (e) {
      if (e.code === 'ENOENT') continue;      // not present — try the next candidate
      if (e instanceof SyntaxError) throw new Error(`invalid policy JSON in ${p}: ${e.message}`);
      throw e;
    }
  }
  return { policy: { ...DEFAULTS }, source: '(built-in defaults)' };
}

module.exports = { loadPolicy, DEFAULTS };
