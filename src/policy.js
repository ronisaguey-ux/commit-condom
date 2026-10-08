'use strict';
/**
 * The policy engine — pure rules over commit metadata.
 *
 * Everything here is a pure function of (commit list, policy). Reading git is isolated in
 * inspectCommits() so the rules can be unit-tested against hand-built commit objects
 * without a repository, which is what makes a rule that "cannot fail" detectable.
 *
 * A violation carries a CODE, the offending commit, a one-line DETAIL and a FIX that names
 * the exact commands to comply. The fix matters as much as the rejection: an agent that is
 * told only "rejected" will retry the same monolith. The message the proxy sends is built
 * from these and reaches the client as `remote:` lines.
 */

const { execFileSync } = require('child_process');

const ZERO_SHA = /^0{40,64}$/;

function git(repoDir, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer });
}

/** Subject line and body of a commit, without running a pager or honouring user config. */
function readMessage(repoDir, sha) {
  const raw = git(repoDir, ['show', '-s', '--format=%s%n%n%n%b', sha]);
  const parts = raw.split('\n\n\n');
  return { subject: (parts[0] || '').trim(), body: (parts[1] || '').trim() };
}

/** Per-commit file and line counts. Binary files count as 0 lines but as a file. */
function readNumstat(repoDir, sha) {
  const out = git(repoDir, ['diff-tree', '--no-commit-id', '--numstat', '-r', '-M', '--root', sha]);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    const p = rest.join('\t');
    if (!p) continue;
    const a = add === '-' ? 0 : Number(add) || 0;
    const d = del === '-' ? 0 : Number(del) || 0;
    files.push({ path: p, added: a, deleted: d, binary: add === '-' });
  }
  return files;
}

/** The paginated diff body of one commit, for the secret/pattern scan. Capped so a huge
 *  commit cannot exhaust memory — a commit that big is rejected for size anyway. */
function readPatch(repoDir, sha, cap = 2 * 1024 * 1024) {
  const out = git(repoDir, ['show', '--format=', '--unified=0', '--no-color', sha]);
  return out.length > cap ? out.slice(0, cap) : out;
}

/**
 * The commits a push would introduce.
 *
 * A new ref (old is all-zeroes) is resolved with `--not --all`: in a pre-receive hook the
 * ref is not yet updated, so everything not reachable from any other ref is exactly what
 * this push adds. An update is the plain old..new range. `--reverse` gives oldest-first,
 * which is the order a human reads a change set in.
 */
function listCommits(repoDir, oldSha, newSha) {
  const range = ZERO_SHA.test(oldSha || '') ? [newSha, '--not', '--all'] : [`${oldSha}..${newSha}`];
  const out = git(repoDir, ['rev-list', '--reverse', ...range]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Commits a NEW remote ref will introduce, from a working clone.
 *
 * A client pre-push hook cannot use `--not --all` the way a server pre-receive hook can: the
 * local branch ref already points at `newSha`, so `newSha --not --all` excludes the very
 * commits being pushed and returns EMPTY. That is a silent hole — the gate then passes
 * everything. `--not --remotes` is the correct base for a push: it drops only what the remote
 * already has. With no remote-tracking refs at all, it lists the whole branch history, which
 * is what a first push should check.
 */
function listNewCommits(repoDir, newSha) {
  const out = git(repoDir, ['rev-list', '--reverse', newSha, '--not', '--remotes']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Turn a list of shas into the commit records the rules read. */
function inspectShas(repoDir, shas, policy = {}) {
  return shas.map((sha) => {
    const { subject, body } = readMessage(repoDir, sha);
    const files = readNumstat(repoDir, sha);
    const added = files.reduce((n, f) => n + f.added, 0);
    const deleted = files.reduce((n, f) => n + f.deleted, 0);
    const meta = git(repoDir, ['show', '-s', '--format=%an%x00%ae', sha]).split('\x00');
    const commit = {
      sha,
      short: sha.slice(0, 8),
      subject,
      body,
      author: meta[0] || '',
      email: meta[1] || '',
      files,
      added,
      deleted,
      lines: added + deleted,
    };
    // The patch is only needed when a pattern rule is configured; skipping it keeps a
    // large push cheap when it is not.
    if ((policy.block_diff_patterns || []).length) commit.patch = readPatch(repoDir, sha);
    return commit;
  });
}

/** Gather everything the rules need for one range, in one pass. */
function inspectCommits(repoDir, oldSha, newSha, policy = {}) {
  return inspectShas(repoDir, listCommits(repoDir, oldSha, newSha), policy);
}

function conventionalRegex(policy) {
  const types = (policy.allowed_types && policy.allowed_types.length)
    ? policy.allowed_types.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    : '[a-z]+';
  // type(scope)!: subject — scope optional, ! marks a breaking change.
  return new RegExp(`^(${types})(\\([^)]+\\))?!?: .+`);
}

/**
 * Evaluate a set of commits against the policy.
 * Returns { ok, violations, stats }. `budget` is { commits, lines } already used this
 * session (see ledger.js); pass it to enforce session_budget.
 */
function evaluate(commits, policy = {}, { budget } = {}) {
  const violations = [];
  const maxFiles = Number(policy.max_files_per_commit ?? 0);
  const maxLines = Number(policy.max_diff_lines ?? 0);
  const re = policy.require_conventional ? conventionalRegex(policy) : null;

  for (const c of commits) {
    const who = `${c.short} "${c.subject || '(no message)'}"`;

    if (maxFiles > 0 && c.files.length > maxFiles) {
      const sample = c.files.slice(0, maxFiles).map((f) => f.path);
      const restFiles = c.files.slice(maxFiles).map((f) => f.path);
      violations.push({
        code: 'TOO_MANY_FILES',
        sha: c.short,
        detail: `${who} touches ${c.files.length} files (max ${maxFiles}).`,
        fix: `Split it into atomic commits. For example:\n`
          + `    git reset --soft HEAD~1\n`
          + `    git add ${sample.join(' ')}\n`
          + `    git commit -m "${firstType(c, policy)}(<scope>): <what> (<why>)"\n`
          + `    git add ${restFiles.slice(0, maxFiles).join(' ') || '<next group>'}\n`
          + `    git commit -m "${firstType(c, policy)}(<scope>): <what> (<why>)"`,
      });
    }

    if (maxLines > 0 && c.lines > maxLines) {
      violations.push({
        code: 'DIFF_TOO_LARGE',
        sha: c.short,
        detail: `${who} is ${c.lines} changed lines (max ${maxLines}).`,
        fix: `Break the change into smaller steps that each stand on their own — e.g. a `
          + `refactor commit, then the behaviour commit. Commit part of the file with `
          + `\`git add -p <file>\` to stage only some hunks.`,
      });
    }

    if (re && !re.test(c.subject)) {
      violations.push({
        code: 'NOT_CONVENTIONAL',
        sha: c.short,
        detail: `${who} is not a conventional commit message.`,
        fix: `Use "type(scope): what (why)", e.g. `
          + `\`git commit --amend -m "fix(proxy): reject oversized pushes (agents retried monoliths)"\`. `
          + `Allowed types: ${(policy.allowed_types || []).join(', ')}.`,
      });
    }

    const maxSubj = Number(policy.max_subject_length ?? 0);
    if (maxSubj > 0 && c.subject.length > maxSubj) {
      violations.push({
        code: 'SUBJECT_TOO_LONG',
        sha: c.short,
        detail: `${who} has a ${c.subject.length}-char subject (max ${maxSubj}).`,
        fix: `Shorten the first line and move the detail into the body.`,
      });
    }

    for (const pat of policy.block_diff_patterns || []) {
      let rx;
      try { rx = new RegExp(pat); } catch { continue; }
      const hit = rx.exec(c.patch || '');
      if (hit) {
        const what = hit[0].length > 40 ? hit[0].slice(0, 40) + '…' : hit[0];
        violations.push({
          code: 'BLOCKED_PATTERN',
          sha: c.short,
          detail: `${who} contains what looks like a secret or forbidden value: ${what}`,
          fix: `Remove it from the commit and rotate the credential. If it is a test `
            + `fixture, change the literal so it cannot match a real key.`,
        });
      }
    }
  }

  // Chunking: the push as a whole must be split when it touches many files.
  const totalFiles = new Set(commits.flatMap((c) => c.files.map((f) => f.path))).size;
  const rules = (policy.chunking && policy.chunking.min_commits_for_files) || {};
  const thresholds = Object.keys(rules).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => b - a);
  for (const threshold of thresholds) {
    if (totalFiles >= threshold) {
      const need = Number(rules[threshold]);
      if (commits.length < need) {
        violations.push({
          code: 'NEEDS_SPLIT',
          sha: '',
          detail: `This push changes ${totalFiles} files in ${commits.length} commit${commits.length === 1 ? '' : 's'}; `
            + `policy requires at least ${need} commits for ${threshold}+ files.`,
          fix: `Group the files by concern and commit each group separately `
            + `(\`git reset --soft <base>\` then stage one group at a time). `
            + `Aim for ${need} or more reviewable commits.`,
        });
      }
      break; // the highest matching threshold is the binding one
    }
  }

  if (budget) {
    const maxCommits = Number(policy.session_budget?.max_commits ?? 0);
    const maxTotal = Number(policy.session_budget?.max_total_lines ?? 0);
    const usedCommits = (budget.commits || 0) + commits.length;
    const usedLines = (budget.lines || 0) + commits.reduce((n, c) => n + c.lines, 0);
    if (maxCommits > 0 && usedCommits > maxCommits) {
      violations.push({
        code: 'BUDGET_COMMITS',
        sha: '',
        detail: `This would bring the session to ${usedCommits} commits (budget ${maxCommits}).`,
        fix: `Stop and report. A human can raise the budget with \`cc budget set --commits <n>\`.`,
      });
    }
    if (maxTotal > 0 && usedLines > maxTotal) {
      violations.push({
        code: 'BUDGET_LINES',
        sha: '',
        detail: `This would bring the session to ${usedLines} changed lines (budget ${maxTotal}).`,
        fix: `Stop and report. A human can raise the budget with \`cc budget set --lines <n>\`.`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    stats: {
      commits: commits.length,
      files: totalFiles,
      lines: commits.reduce((n, c) => n + c.lines, 0),
    },
  };
}

/** A sensible type for a suggested replacement message, taken from the original. */
function firstType(commit, policy) {
  const m = /^([a-z]+)(\(|:|!)/.exec(commit.subject || '');
  const allowed = policy.allowed_types || [];
  if (m && (!allowed.length || allowed.includes(m[1]))) return m[1];
  return allowed[0] || 'chore';
}

/**
 * Render violations as the text git forwards to the client (each line becomes `remote:`).
 * Kept to a bounded size: a wall of text over the sideband is worse than a clear summary.
 */
function formatRejection(result, { maxChars = 6000 } = {}) {
  if (result.ok) return '';
  const lines = [];
  lines.push(`commit-condom blocked this push: ${result.violations.length} policy violation${result.violations.length === 1 ? '' : 's'}.`);
  lines.push('');
  lines.push(`push summary: ${result.stats.commits} commit(s), ${result.stats.files} file(s), ${result.stats.lines} line(s).`);
  lines.push('');
  result.violations.forEach((v, i) => {
    lines.push(`${i + 1}. [${v.code}] ${v.detail}`);
    if (v.fix) lines.push(`   fix: ${v.fix}`);
    lines.push('');
  });
  lines.push('This is enforced at the remote, not by a client hook — re-running with --no-verify will not bypass it.');
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n… (truncated)';
  return text;
}

module.exports = {
  ZERO_SHA,
  git,
  listCommits,
  listNewCommits,
  inspectCommits,
  inspectShas,
  evaluate,
  formatRejection,
  conventionalRegex,
  firstType,
};
