'use strict';
/**
 * The session ledger — an append-only, hash-chained record of every commit that passed the
 * gate.
 *
 * Two jobs:
 *   1. give the session budget something to count (commits and changed lines so far)
 *   2. let `git_audit` prove the agent has not drifted — each entry commits to the one
 *      before it, so a deleted or edited line breaks the chain and verify() says so
 *
 * The file is JSONL so it can be appended without rewriting and read with `tail`, and so a
 * partial write can only ever damage the last line.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function ledgerPath(repoDir) {
  return path.join(repoDir, '.condom', 'ledger.jsonl');
}

function readEntries(repoDir) {
  const file = ledgerPath(repoDir);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line is ignored, not fatal */ }
  }
  return out;
}

/** The hash an entry commits to: its own fields plus the previous entry's hash. */
function computeHash(prevHash, entry) {
  const canonical = JSON.stringify({
    seq: entry.seq, at: entry.at, session: entry.session, repo: entry.repo, ref: entry.ref,
    sha: entry.sha, subject: entry.subject, files: entry.files, lines: entry.lines,
    violations: entry.violations || 0,
  });
  return sha256(prevHash + '\n' + canonical);
}

function append(repoDir, rec) {
  const file = ledgerPath(repoDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = readEntries(repoDir);
  const prev = entries.length ? entries[entries.length - 1] : null;
  const prevHash = prev ? prev.hash : 'genesis';
  const entry = {
    seq: entries.length + 1,
    at: new Date().toISOString(),
    session: rec.session || process.env.CC_SESSION || 'default',
    repo: rec.repo || '',
    ref: rec.ref || '',
    sha: rec.sha || '',
    subject: rec.subject || '',
    files: rec.files || 0,
    lines: rec.lines || 0,
    violations: rec.violations || 0,
    prev: prevHash,
  };
  entry.hash = computeHash(prevHash, entry);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

/** Walk the chain and report the first entry that does not hash to its stored value. */
function verify(repoDir) {
  const entries = readEntries(repoDir);
  let prevHash = 'genesis';
  for (const e of entries) {
    const expect = computeHash(prevHash, e);
    if (e.prev !== prevHash) return { ok: false, broken_at: e.seq, why: 'prev link does not match the previous entry' };
    if (e.hash !== expect) return { ok: false, broken_at: e.seq, why: 'entry hash does not match its contents' };
    prevHash = e.hash;
  }
  return { ok: true, entries: entries.length, head: prevHash };
}

/** Totals for one session, for the budget check. */
function totals(repoDir, session) {
  const want = session || process.env.CC_SESSION || 'default';
  let commits = 0, lines = 0;
  for (const e of readEntries(repoDir)) {
    if (e.session !== want) continue;
    commits += 1;
    lines += Number(e.lines) || 0;
  }
  return { session: want, commits, lines };
}

module.exports = { ledgerPath, readEntries, append, verify, totals, computeHash };
