'use strict';
/**
 * gitleaks — the OPTIONAL second secret gate.
 *
 * Why a second gate at all: `block_diff_patterns` is a hand-maintained regex list. It is fast
 * and it is predictable, but it only catches the key shapes somebody thought to write down.
 * gitleaks ships ~200 maintained rules with entropy heuristics, so it catches the formats
 * nobody here remembered (Stripe webhook secrets, SendGrid, private-key variants, generic
 * high-entropy strings). The regex gate stays the default because it needs no external binary
 * and cannot change behaviour under you; gitleaks is opt-in per policy or per environment.
 *
 * It is deliberately NOT a replacement. Both gates run, and either one can block.
 *
 * Enable it one of three ways (first one wins):
 *   env CC_GITLEAKS=1                      force on   (CC_GITLEAKS=0 forces off)
 *   policy.gitleaks.enabled = true         per repo / per machine policy
 *   (absent)                               off
 *
 * Config, all optional:
 *   policy.gitleaks.binary   path or name of the binary          (default "gitleaks")
 *   policy.gitleaks.config   gitleaks TOML config (allowlists)   (default: gitleaks' own,
 *                                                                 or <repo>/.gitleaks.toml)
 *   policy.gitleaks.timeout  seconds before the scan is abandoned (default 120)
 *   policy.gitleaks.extra_args  array of extra CLI args, e.g. ["--max-decode-depth","0"]
 *
 * FAIL CLOSED. If the gate is enabled and the binary is missing, or the scan errors, or its
 * output cannot be parsed, that is a violation — never a silent pass. An enabled gate that
 * skips itself is worse than no gate, because the policy claims a protection it does not have.
 */

const { spawnSync } = require('child_process');

const DEFAULTS = {
  enabled: false,
  binary: 'gitleaks',
  config: '',
  timeout: 120,
  extra_args: [],
};

/** Resolve the settings for one repo, env overriding policy in both directions. */
function settings(policy = {}) {
  const g = (policy && policy.gitleaks) || {};
  const s = { ...DEFAULTS, ...g };
  if (process.env.CC_GITLEAKS === '1') s.enabled = true;
  else if (process.env.CC_GITLEAKS === '0') s.enabled = false;
  else s.enabled = g.enabled === true;
  return s;
}

function enabled(policy = {}) {
  return settings(policy).enabled;
}

/** `git log` range for one gate call: an explicit base..head, or "new commits on head". */
function logOpts(base, head) {
  const b = String(base || '');
  const h = String(head || 'HEAD');
  if (!b || /^0+$/.test(b)) return `${h} --not --all`;
  return `${b}..${h}`;
}

/**
 * Why the requested range cannot be scanned, or '' when it is fine.
 *
 * A range git cannot resolve yields an empty scan, and gitleaks reports success for it, so this
 * runs first. An empty range (base == head) is legitimate and allowed.
 */
function rangeProblem(repoDir, base, head) {
  const git = (args) => spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', timeout: 30000 });
  const rev = (ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const h = rev(String(head || 'HEAD'));
  if (h.status !== 0) return `head "${head}" is not a commit in ${repoDir}.`;
  const b = String(base || '');
  if (b && !/^0+$/.test(b)) {
    if (rev(b).status !== 0) return `base "${b}" is not a commit in ${repoDir} (is this a root commit?).`;
  }
  const count = git(['rev-list', '--count', `${logOpts(base, head)}`]);
  if (count.status !== 0) return `git cannot list the commits in range ${logOpts(base, head)}.`;
  return '';
}

function unavailable(detail) {
  return {
    code: 'GITLEAKS_UNAVAILABLE',
    sha: '',
    detail,
    fix: 'Install gitleaks (https://github.com/gitleaks/gitleaks) or unset policy.gitleaks.enabled / '
      + 'CC_GITLEAKS. This fails closed on purpose: an enabled gate that cannot run must not pass.',
  };
}

/** Turn one gitleaks finding into a policy-shaped violation. */
function violationFromFinding(f, range) {
  const file = f.File || f.file || '?';
  const line = f.StartLine || f.startLine || 0;
  const rule = f.RuleID || f.ruleId || 'unknown-rule';
  const desc = f.Description || f.description || 'secret detected';
  // Never echo the secret itself. gitleaks is run with --redact, and the Match field is dropped
  // here regardless, so a detector finding cannot leak the very value it found.
  return {
    code: 'GITLEAKS_SECRET',
    sha: '',
    detail: `${file}${line ? `:${line}` : ''} looks like a secret (${rule}: ${desc}) in ${range}.`,
    fix: 'Remove it from the commit and rotate the credential. If it is a false positive, add an '
      + 'allowlist entry to the gitleaks config named in policy.gitleaks.config, or a '
      + '`gitleaks:allow` comment on that line — do not disable the gate.',
  };
}

/**
 * Scan a commit range (or the index) for secrets.
 *
 * Returns { enabled, ok, violations, note }. `ok` is true when the gate is off, or when it ran
 * and found nothing. Any inability to run reports ok:false with a GITLEAKS_UNAVAILABLE violation.
 */
function scan(repoDir, { base = '', head = 'HEAD', staged = false, policy = {} } = {}) {
  const s = settings(policy);
  if (!s.enabled) return { enabled: false, ok: true, violations: [], note: 'gitleaks: off' };

  // gitleaks exits 0 and reports nothing for a log range git cannot resolve (a root commit's
  // `sha~1`, a sha from another clone). Scanning an empty range is indistinguishable from
  // scanning a clean one, so the range is resolved here first. Same fail-closed rule.
  if (!staged) {
    const check = rangeProblem(repoDir, base, head);
    if (check) return { enabled: true, ok: false, violations: [unavailable(check)], note: 'gitleaks: bad range' };
  }

  const args = ['git', repoDir, '--no-banner', '--redact', '--exit-code', '0', '-f', 'json', '-r', '-'];
  if (staged) args.push('--staged');
  else args.push(`--log-opts=${logOpts(base, head)}`);
  if (s.config) args.push('-c', String(s.config));
  for (const a of s.extra_args || []) args.push(String(a));

  const res = spawnSync(String(s.binary), args, {
    encoding: 'utf8',
    timeout: Math.max(1, Number(s.timeout) || 120) * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error && res.error.code === 'ENOENT') {
    return { enabled: true, ok: false, violations: [unavailable(`gitleaks is enabled but "${s.binary}" is not on PATH.`)], note: 'gitleaks: missing' };
  }
  if (res.error && res.error.code === 'ETIMEDOUT') {
    return { enabled: true, ok: false, violations: [unavailable(`gitleaks did not finish within ${s.timeout}s.`)], note: 'gitleaks: timeout' };
  }
  if (res.error) {
    return { enabled: true, ok: false, violations: [unavailable(`gitleaks could not run: ${res.error.message}`)], note: 'gitleaks: error' };
  }
  // 0 = clean, 1 = leaks found (we ask for --exit-code 0, so this stays 0), anything else = broken.
  if (res.status !== 0) {
    const why = String(res.stderr || res.stdout || '').split('\n').filter(Boolean).slice(-2).join(' ');
    return { enabled: true, ok: false, violations: [unavailable(`gitleaks exited ${res.status}${why ? `: ${why}` : ''}.`)], note: 'gitleaks: error' };
  }

  let findings = [];
  const raw = String(res.stdout || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      findings = Array.isArray(parsed) ? parsed : [];
    } catch {
      return { enabled: true, ok: false, violations: [unavailable('gitleaks returned output that is not JSON; refusing to treat that as a pass.')], note: 'gitleaks: unparsable' };
    }
  }

  const range = staged ? 'the staged index' : logOpts(base, head);
  const violations = findings.map((f) => violationFromFinding(f, range));
  return {
    enabled: true,
    ok: violations.length === 0,
    violations,
    note: `gitleaks: ${violations.length} finding(s)`,
  };
}

module.exports = { scan, settings, enabled, logOpts };
