#!/usr/bin/env node
'use strict';
/**
 * cc — the command the hooks and the MCP call.
 *
 * Subcommands:
 *   pre-receive            hook entry (bare mirror): read "<old> <new> <ref>" on stdin
 *   pre-push               hook entry (working clone): fast, local feedback
 *   commit-msg <file>      hook entry: validate the message before the commit exists
 *   check --base X --head Y | --range X..Y
 *   plan                   propose how to split the working tree into atomic commits
 *   install-hooks --repo DIR [--bare]
 *   budget show | set --commits N --lines N | reset
 *   audit [--json]
 *
 * Exit codes: 0 pass · 1 policy violation · 2 usage/config error.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { loadPolicy } = require('../src/config');
const P = require('../src/policy');
const L = require('../src/ledger');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

function flag(name, def = undefined) {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
function out(s) { process.stdout.write(s + '\n'); }
function err(s) { process.stderr.write(s + '\n'); }

/** True when a namespace holds no refs — i.e. nothing is published there yet. */
function noRefs(repoDir, ns) {
  try {
    return execFileSync('git', ['-C', repoDir, 'for-each-ref', ns], { encoding: 'utf8' }).trim() === '';
  } catch {
    return false;   // if we cannot tell, do NOT assume the looser rule
  }
}

/** The policy a repo actually gets checked against, given whether it is brand new. */
function effectivePolicy(policy, isNewRepo) {
  if (!isNewRepo) return policy;
  const p = { ...policy };
  if (policy.new_repo_max_files != null) p.max_files_per_commit = policy.new_repo_max_files;
  if (policy.new_repo_max_lines != null) p.max_diff_lines = policy.new_repo_max_lines;
  // A bulk import is one commit by nature — the chunking rule ("N files need M commits") exists
  // to stop a monolith in a repo that HAS history, and has no history to protect on a first push.
  p.chunking = {};
  return p;
}

function gate(repoDir, base, head, ref, { isNewRepo = false, useRemoteBase = false } = {}) {
  const loaded = loadPolicy({ repoDir });
  const policy = effectivePolicy(loaded.policy, isNewRepo);
  const source = loaded.source;
  // A zero base means "a new ref". On the server the right base is `--not --all` (the mirror's
  // refs are the remote's). In a WORKING clone it must be `--not --remotes`: the local ref
  // already points at `head`, so `--not --all` excludes the very commits under review and the
  // check passes vacuously. That is the same hole the pre-push hook had, and it must not be
  // left open in `cc check` either.
  const commits = (useRemoteBase && P.ZERO_SHA.test(base || ''))
    ? P.inspectShas(repoDir, P.listNewCommits(repoDir, head), policy)
    : P.inspectCommits(repoDir, base, head, policy);
  const budget = policy.session_budget ? L.totals(repoDir) : undefined;
  const result = P.evaluate(commits, policy, { budget });
  if (!result.ok) {
    return { result, policy, source, commits, text: P.formatRejection(result), ok: false };
  }
  // Record what passed, so the budget advances and the audit chain grows.
  for (const c of commits) {
    L.append(repoDir, { repo: repoDir, ref: ref || '', sha: c.sha, subject: c.subject, files: c.files.length, lines: c.lines, violations: 0 });
  }
  return { result, policy, source, commits, text: '', ok: true };
}

// ── hook: pre-receive (the remote-side gate — the reason --no-verify cannot help) ──
function cmdPreReceive() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { input = ''; }
  const repoDir = process.cwd();
  const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 0;

  let rejected = false;
  const messages = [];
  for (const line of lines) {
    const [oldSha, newSha, ref] = line.split(/\s+/);
    if (!ref || !ref.startsWith('refs/heads/')) continue;            // only branches carry commits to review
    if (P.ZERO_SHA.test(newSha)) continue;                            // a deletion has nothing to check
    // A mirror with no branches yet is a brand-new repo: its first push is a bulk import.
    const isNewRepo = noRefs(repoDir, 'refs/heads/');
    const g = gate(repoDir, oldSha, newSha, ref, { isNewRepo });
    if (!g.ok) {
      rejected = true;
      messages.push(g.text);
    } else {
      const note = isNewRepo ? ' [new repo: bulk import allowed]' : '';
      messages.push(`commit-condom: ${g.result.stats.commits} commit(s) accepted on ${ref} (${g.result.stats.files} files, ${g.result.stats.lines} lines).${note}`);
    }
  }
  for (const m of messages) {
    // Each line becomes `remote:` on the client; git adds that prefix itself, so no prefix here.
    for (const l of m.split('\n')) out(l);
  }
  return rejected ? 1 : 0;
}

// ── hook: pre-push (client side — fast feedback, and it also catches a bypass attempt early) ──
function cmdPrePush() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { input = ''; }
  const repoDir = process.cwd();
  let rejected = false;
  const messages = [];
  for (const line of input.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(/\s+/);
    const base = (!remoteSha || P.ZERO_SHA.test(remoteSha)) ? null : remoteSha;
    let commits;
    try {
      // A new remote ref must be compared against the REMOTE, not against local refs: the local
      // branch points at localSha, so `--not --all` would exclude the commits being pushed and
      // the gate would silently pass. `listNewCommits` uses `--not --remotes` for that case.
      commits = base
        ? P.inspectCommits(repoDir, base, localSha, loadPolicy({ repoDir }).policy)
        : P.inspectShas(repoDir, P.listNewCommits(repoDir, localSha), loadPolicy({ repoDir }).policy);
    } catch (e) {
      // Failing to inspect is NOT the same as passing. Say so loudly, and do not silently
      // treat an error as "no commits to check" — that is how a gate stops gating.
      err(`commit-condom: could not inspect ${localSha.slice(0, 8)} (${String(e.message || e).split('\n')[0]}).`);
      err('  A local hook cannot verify this push; the remote gate still applies.');
      continue;
    }
    const { policy: rawPolicy } = loadPolicy({ repoDir });
    // No remote-tracking refs yet = the first push to a new remote = a new repo's bulk import.
    const policy = effectivePolicy(rawPolicy, noRefs(repoDir, 'refs/remotes/'));
    const result = P.evaluate(commits, policy);
    if (!result.ok) { rejected = true; messages.push(P.formatRejection(result)); }
  }
  for (const m of messages) for (const l of m.split('\n')) err(l);
  return rejected ? 1 : 0;
}

// ── hook: commit-msg (catches the message at the cheapest possible moment) ──
function cmdCommitMsg() {
  const file = argv[1];
  if (!file) { err('cc commit-msg: need the message file path'); return 2; }
  const repoDir = process.cwd();
  const { policy } = loadPolicy({ repoDir });
  if (!policy.require_conventional) return 0;
  const subject = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
  if (!P.conventionalRegex(policy).test(subject)) {
    err(`commit-condom: "${subject}" is not a conventional commit.`);
    err(`Use "type(scope): what (why)". Allowed types: ${(policy.allowed_types || []).join(', ')}.`);
    return 1;
  }
  if (subject.length > Number(policy.max_subject_length || 0)) {
    err(`commit-condom: subject is ${subject.length} chars (max ${policy.max_subject_length}). Shorten it; put detail in the body.`);
    return 1;
  }
  return 0;
}

function cmdCheck() {
  const repoDir = path.resolve(flag('--repo', process.cwd()));
  const range = flag('--range');
  let base = flag('--base'), head = flag('--head');
  if (range) { const [a, b] = String(range).split('..'); base = a; head = b; }
  if (!head) head = 'HEAD';
  if (!base) {
    try { base = execFileSync('git', ['-C', repoDir, 'rev-parse', `${head}~1`], { encoding: 'utf8' }).trim(); }
    catch { base = '0'.repeat(40); }
  }
  const g = gate(repoDir, base, head, flag('--ref') || '',
    { isNewRepo: noRefs(repoDir, 'refs/remotes/'), useRemoteBase: true });
  out(`policy: ${g.source}`);
  out(`range: ${base.slice(0, 8)}..${String(head).slice(0, 8)}  ->  ${g.result.stats.commits} commit(s), ${g.result.stats.files} file(s), ${g.result.stats.lines} line(s)`);
  if (g.ok) { out('PASS — no policy violations.'); return 0; }
  err(g.text);
  return 1;
}

/** Propose a chunking plan: group the changed files into atomic, policy-sized commits. */
function cmdPlan() {
  const repoDir = path.resolve(flag('--repo', process.cwd()));
  const { policy } = loadPolicy({ repoDir });
  const maxFiles = Math.max(1, Number(policy.max_files_per_commit || 1));
  let status;
  try { status = execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], { encoding: 'utf8' }); }
  catch (e) { err(`cc plan: not a git work tree (${e.message})`); return 2; }
  const files = status.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^\S+\s+/, '').replace(/^.* -> /, ''))
    // Never plan the gate's own files: the policy and the ledger are configuration, not the
    // change being described, and an agent staging them would be committing its own rulebook.
    .filter((f) => f && f !== '.condom.json' && !f.startsWith('.condom/') && f !== 'condom.json');
  if (!files.length) { out('Nothing to plan: working tree is clean.'); return 0; }

  // Group by the top-level area (e.g. src/ vs test/ vs docs), then split any group that
  // exceeds the per-commit file cap. That is the split a reviewer would make anyway.
  const groups = new Map();
  for (const f of files) {
    const key = f.includes('/') ? f.split('/').slice(0, /^(src|test|tests|docs|bin|mcp|hooks)$/.test(f.split('/')[0]) ? 2 : 1).join('/') : f;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const plan = [];
  for (const [area, group] of groups) {
    for (let i = 0; i < group.length; i += maxFiles) {
      const chunk = group.slice(i, i + maxFiles);
      const type = /test/i.test(area) ? 'test' : /doc|readme/i.test(area) ? 'docs' : 'feat';
      plan.push({ files: chunk, message: `${type}(${area.replace(/[^\w-]/g, '-').toLowerCase()}): <what changed> (<why it was needed>)` });
    }
  }
  out(JSON.stringify({ files: files.length, max_files_per_commit: maxFiles, commits: plan.length, plan }, null, 2));
  return 0;
}

function cmdInstallHooks() {
  const repoDir = path.resolve(flag('--repo', process.cwd()));
  const bare = !!flag('--bare');
  const self = path.resolve(__filename);
  const node = process.execPath;
  const hooksDir = path.join(repoDir, bare ? 'hooks' : '.git/hooks');
  if (!fs.existsSync(repoDir)) { err(`cc install-hooks: no such repo ${repoDir}`); return 2; }
  fs.mkdirSync(hooksDir, { recursive: true });
  const write = (name, body) => {
    const p = path.join(hooksDir, name);
    fs.writeFileSync(p, body, { mode: 0o755 });
    return p;
  };
  const written = [];
  if (bare) {
    written.push(write('pre-receive', `#!/bin/sh\n# commit-condom: the remote-side gate. Runs on the mirror, before refs move.\nexec "${node}" "${self}" pre-receive\n`));
  } else {
    written.push(write('commit-msg', `#!/bin/sh\n# commit-condom: message format at the cheapest moment.\nexec "${node}" "${self}" commit-msg "$1"\n`));
    written.push(write('pre-push', `#!/bin/sh\n# commit-condom: local fast feedback. The remote gate is authoritative.\nexec "${node}" "${self}" pre-push\n`));
  }
  out(JSON.stringify({ installed: written, bare, note: 'The pre-receive hook on the mirror is the authoritative gate; these are its fast local mirror.' }, null, 2));
  return 0;
}

function cmdBudget() {
  const repoDir = path.resolve(flag('--repo', process.cwd()));
  const sub = argv[1] || 'show';
  const state = path.join(repoDir, '.condom', 'budget.json');
  if (sub === 'show') {
    const t = L.totals(repoDir);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(state, 'utf8')); } catch { /* none set */ }
    const { policy } = loadPolicy({ repoDir });
    out(JSON.stringify({ ...t, policy: policy.session_budget, override: cfg }, null, 2));
    return 0;
  }
  if (sub === 'set') {
    const cfg = {};
    if (flag('--commits') !== undefined) cfg.max_commits = Number(flag('--commits'));
    if (flag('--lines') !== undefined) cfg.max_total_lines = Number(flag('--lines'));
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, JSON.stringify(cfg, null, 2));
    out(`budget override saved: ${JSON.stringify(cfg)}`);
    return 0;
  }
  if (sub === 'reset') {
    try { fs.unlinkSync(state); } catch { /* nothing to reset */ }
    out('budget override cleared (policy defaults apply again)');
    return 0;
  }
  err('cc budget: show | set --commits N --lines N | reset');
  return 2;
}

function cmdAudit() {
  const repoDir = path.resolve(flag('--repo', process.cwd()));
  const entries = L.readEntries(repoDir);
  const v = L.verify(repoDir);
  if (flag('--json')) { out(JSON.stringify({ verify: v, entries }, null, 2)); return v.ok ? 0 : 1; }
  out(`ledger: ${L.ledgerPath(repoDir)}`);
  out(`entries: ${entries.length}  chain: ${v.ok ? 'INTACT' : `BROKEN at #${v.broken_at} (${v.why})`}`);
  for (const e of entries.slice(-20)) {
    out(`  #${e.seq} ${e.at} ${String(e.sha).slice(0, 8)} ${e.files}f/${e.lines}L  ${e.subject}`);
  }
  return v.ok ? 0 : 1;
}

function cmdPolicy() {
  // argv[0] is the command ('policy'); the subcommand starts at argv[1].
  const sub = (argv[1] || '').trim();
  const dataDir = path.resolve(flag('--data', process.env.CC_DATA || path.join(require('os').homedir(), '.commit-condom')));
  const dir = path.join(dataDir, 'policies');
  const key = (s) => String(s).replace(/^\/+|\/+$/g, '').replace(/\//g, '__').replace(/\.git$/, '');

  if (sub === 'ls' || sub === '') {
    let names = []; try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { /* none */ }
    out(`policy registry: ${dir}`);
    if (!names.length) out('  (empty — every repo uses the machine policy, or the built-in defaults)');
    for (const n of names) out(`  ${n.replace(/__/g, '/').replace(/\.json$/, '')}`);
    return 0;
  }
  if (sub === 'set') {
    const repo = argv[2]; const file = argv[3];
    if (!repo || !file) { err('cc policy set <owner/repo> <policy.json> [--data DIR]'); return 2; }
    if (!fs.existsSync(file)) { err(`cc policy set: ${file} does not exist`); return 2; }
    try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { err(`cc policy set: ${file} is not valid JSON: ${e.message}`); return 2; }
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${key(repo)}.json`);
    fs.copyFileSync(file, dest);
    out(`registered ${repo} -> ${dest}`);
    out('the proxy picks this up on the next push; a pusher cannot edit or delete it with git.');
    return 0;
  }
  if (sub === 'rm') {
    const repo = argv[2];
    if (!repo) { err('cc policy rm <owner/repo> [--data DIR]'); return 2; }
    const dest = path.join(dir, `${key(repo)}.json`);
    if (!fs.existsSync(dest)) { err(`cc policy rm: ${repo} is not registered`); return 2; }
    fs.rmSync(dest); out(`removed ${repo}`); return 0;
  }
  err(`cc policy: unknown subcommand '${sub}' — use ls | set | rm`);
  return 2;
}

function cmdHelp() {
  out(`cc — commit-condom

  pre-receive | pre-push | commit-msg      hook entry points (called by the installed hooks)
  check [--base X --head Y] [--range X..Y] [--repo DIR]   evaluate a range
  plan [--repo DIR]                        propose atomic commits for the working tree
  install-hooks --repo DIR [--bare]        install the hooks
  policy ls|set|rm [--data DIR]            the proxy's per-repo policy registry (unescapable)
  budget show|set --commits N --lines N|reset
  audit [--json]                           show and verify the ledger chain
`);
  return 0;
}

const table = {
  'pre-receive': cmdPreReceive, 'pre-push': cmdPrePush, 'commit-msg': cmdCommitMsg,
  check: cmdCheck, plan: cmdPlan, 'install-hooks': cmdInstallHooks, policy: cmdPolicy,
  budget: cmdBudget, audit: cmdAudit, help: cmdHelp,
};
const fn = table[cmd];
const code = fn ? fn() : (err(`cc: unknown command '${cmd}' — run 'cc help'`), 2);
process.exit(code || 0);
