#!/usr/bin/env node
'use strict';
/**
 * cc-proxy — start the gate.
 *
 * The real PAT is read from the environment (CC_PAT or GITHUB_PAT) or from a file given by
 * CC_PAT_FILE. It is never printed, never written into a repo config, and never handed to the
 * agent; the agent's remote simply points here.
 *
 *   CC_PAT=ghp_xxx node bin/cc-proxy.js --port 8877 --policy ./policy.example.json
 *
 * then, in the agent's clone:
 *   git remote set-url origin http://127.0.0.1:8877/<owner>/<repo>.git
 */

const fs = require('fs');
const path = require('path');
const { createProxy } = require('../src/proxy');

function flag(name, def) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const token = process.env.CC_PAT || process.env.GITHUB_PAT
  || (process.env.CC_PAT_FILE ? fs.readFileSync(process.env.CC_PAT_FILE, 'utf8').trim() : '');

if (!token) {
  process.stderr.write('cc-proxy: no upstream token. Set CC_PAT (or GITHUB_PAT / CC_PAT_FILE).\n');
  process.exit(2);
}

const port = Number(flag('--port', process.env.CC_PORT || 8877));
const host = flag('--host', process.env.CC_HOST || '127.0.0.1');
const upstream = flag('--upstream', process.env.CC_UPSTREAM || 'https://github.com');
const dataDir = flag('--data', process.env.CC_DATA || path.join(require('os').homedir(), '.commit-condom'));
const policyPath = flag('--policy', process.env.CC_POLICY || '')
  ? path.resolve(String(flag('--policy', process.env.CC_POLICY))) : '';

const { server, config } = createProxy({ upstream, token, dataDir, policyPath });

server.listen(port, host, () => {
  process.stdout.write(
    `commit-condom proxy listening on http://${host}:${port}\n`
    + `  upstream: ${upstream}\n`
    + `  policy:   ${policyPath || '(repo default / built-in)'}\n`
    + `  mirrors:  ${path.join(dataDir, 'mirrors')}\n`
    + `  point a remote here:  git remote set-url origin http://${host}:${port}/<owner>/<repo>.git\n`
  );
});

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
