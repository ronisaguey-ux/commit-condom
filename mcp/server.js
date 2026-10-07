#!/usr/bin/env node
'use strict';
/**
 * commit-condom MCP server — the cooperative path.
 *
 * The proxy is the coercive backstop: anything that reaches it is checked whether or not the
 * agent cooperated. These tools are the other half — a way for an agent to *ask* for the right
 * shape before it gets rejected, which is the difference between a gate and a wall.
 *
 *   cc_plan       propose how to split the working tree into atomic, policy-sized commits
 *   cc_commit     commit a chosen set of paths with a chosen message, policy-checked first
 *   cc_check      evaluate a commit range and return the violations without pushing
 *   cc_status     branch, staged/unstaged counts, and the current policy in force
 *   cc_audit      the session ledger, hash-verified
 *
 * Zero dependencies. stdout is the JSON-RPC wire, so nothing here may print to it — the
 * console is redirected to stderr only when this file is the entry point.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { loadPolicy } = require('../src/config');
const P = require('../src/policy');
const L = require('../src/ledger');
const CC_BIN = path.join(__dirname, '..', 'bin', 'cc.js');

function git(repo, args, { allowFail = false } = {}) {
  try {
    // stderr is captured rather than inherited: a probe that is expected to fail (e.g. asking
    // whether a directory is a work tree) must not print "fatal:" into the server's log.
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

function repoOf(args) {
  return path.resolve(args.repo || process.cwd());
}

function requireRepo(args) {
  const repo = repoOf(args);
  const top = git(repo, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top) throw new Error(`not a git work tree: ${repo}`);
  return top.trim();
}

const TOOLS = [
  {
    name: 'cc_plan',
    description: 'Propose how to split the current working tree into atomic commits that satisfy the commit policy (max files per commit, chunking thresholds). Call this BEFORE staging a large change; it returns file groups and a suggested conventional message per group.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'Repository path (default: cwd)' } } },
  },
  {
    name: 'cc_commit',
    description: 'Stage exactly the given paths and commit them with the given message, after checking the result against the policy. Returns either the new commit or the policy violations with the exact fix. Use one call per atomic commit.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository path (default: cwd)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Paths to stage for THIS commit (stage only what belongs together)' },
        message: { type: 'string', description: 'Conventional commit message: "type(scope): what (why)"' },
      },
      required: ['paths', 'message'],
    },
  },
  {
    name: 'cc_check',
    description: 'Evaluate a commit range against the policy and return the violations without pushing. Defaults to the last commit.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        range: { type: 'string', description: 'A git range like "HEAD~3..HEAD" (default: the last commit)' },
      },
    },
  },
  {
    name: 'cc_status',
    description: 'Repository state at a glance: branch, staged vs unstaged files, whether the policy is being enforced, and the remaining session budget.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
  },
  {
    name: 'cc_audit',
    description: 'The session ledger: every commit that passed the gate, hash-chained. Returns whether the chain is intact (a broken chain means an entry was edited or removed).',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, limit: { type: 'number', description: 'How many recent entries (default 20)' } } },
  },
];

function callPlan(a) {
  const repo = requireRepo(a);
  return JSON.parse(execFileSync(process.execPath, [CC_BIN, 'plan', '--repo', repo], { encoding: 'utf8' }));
}

function callCommit(a) {
  const repo = requireRepo(a);
  const paths = (a.paths || []).map(String);
  if (!paths.length) throw new Error('paths must be a non-empty array — stage only what belongs in this one commit');
  const message = String(a.message || '').trim();
  if (!message) throw new Error('message is required');

  const { policy } = loadPolicy({ repoDir: repo });

  // Check the message before touching the index, so a bad message cannot leave the caller
  // with a half-staged tree to clean up.
  if (policy.require_conventional && !P.conventionalRegex(policy).test(message.split('\n')[0])) {
    return { committed: false, code: 'NOT_CONVENTIONAL',
      error: `"${message.split('\n')[0]}" is not a conventional commit.`,
      fix: `Use "type(scope): what (why)". Allowed types: ${(policy.allowed_types || []).join(', ')}.` };
  }
  if (paths.length > Number(policy.max_files_per_commit || 0)) {
    return { committed: false, code: 'TOO_MANY_FILES',
      error: `${paths.length} paths in one commit (max ${policy.max_files_per_commit}).`,
      fix: `Call cc_plan, then one cc_commit per group.` };
  }

  for (const p of paths) git(repo, ['add', '--', p]);
  git(repo, ['commit', '-q', '-m', message]);
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();

  // Record it only after it exists and passed, so the ledger reflects reality.
  const files = git(repo, ['show', '--numstat', '--format=', sha]).split('\n').filter(Boolean);
  const lines = files.reduce((n, l) => {
    const [ad, de] = l.split('\t');
    return n + (Number(ad) || 0) + (Number(de) || 0);
  }, 0);
  L.append(repo, { repo, sha, subject: message.split('\n')[0], files: files.length, lines });
  return { committed: true, sha, short: sha.slice(0, 8), files: files.length, lines, message: message.split('\n')[0] };
}

function callCheck(a) {
  const repo = requireRepo(a);
  const range = String(a.range || 'HEAD~1..HEAD');
  const [base, head] = range.includes('..') ? range.split('..') : ['HEAD~1', range];
  const { policy, source } = loadPolicy({ repoDir: repo });
  const commits = P.inspectCommits(repo, base, head, policy);
  const result = P.evaluate(commits, policy, { budget: policy.session_budget ? L.totals(repo) : undefined });
  return {
    ok: result.ok,
    stats: result.stats,
    policy_source: source,
    violations: result.violations,
    report: result.ok ? 'PASS — no policy violations.' : P.formatRejection(result),
  };
}

function callStatus(a) {
  const repo = requireRepo(a);
  const { policy, source } = loadPolicy({ repoDir: repo });
  const branch = (git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }) || '').trim();
  const porcelain = git(repo, ['status', '--porcelain'], { allowFail: true }) || '';
  const lines = porcelain.split('\n').filter(Boolean);
  const staged = lines.filter((l) => l[0] !== ' ' && l[0] !== '?').length;
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const budget = L.totals(repo);
  return {
    repo, branch, staged, untracked, modified: lines.length,
    policy_source: source,
    max_files_per_commit: policy.max_files_per_commit,
    max_diff_lines: policy.max_diff_lines,
    budget: { ...budget, limit: policy.session_budget },
  };
}

function callAudit(a) {
  const repo = requireRepo(a);
  const entries = L.readEntries(repo);
  const v = L.verify(repo);
  const limit = Math.max(1, Math.min(Number(a.limit) || 20, 500));
  return { verify: v, total: entries.length, entries: entries.slice(-limit) };
}

const HANDLERS = { cc_plan: callPlan, cc_commit: callCommit, cc_check: callCheck, cc_status: callStatus, cc_audit: callAudit };

// ── MCP plumbing ────────────────────────────────────────────────────────────────
// The console redirect and the stdin loop are attached only when this file is the entry
// point. Requiring it (a test, another module) must not hijack stdin or swallow output.
let buffer = '';
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message: String(message) } }); }

function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    return ok(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'commit-condom', version: '0.1.0' } });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const fn = HANDLERS[name];
    if (!fn) return fail(id, -32602, `unknown tool ${name}`);
    try {
      const out = fn((params && params.arguments) || {});
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: JSON.stringify({ error: String(e.message || e) }, null, 2) }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

if (require.main === module) {
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    console[level] = (...args) => { try { process.stderr.write(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch { /* stderr gone */ } };
  }
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try { handle(msg); } catch (e) { if (msg.id !== undefined) fail(msg.id, -32603, e.message); }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = { TOOLS, handle, callPlan, callCommit, callCheck, callStatus, callAudit, requireRepo };
