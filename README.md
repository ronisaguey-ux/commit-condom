# commit-condom

A push gate for coding agents. The agent holds a placeholder credential, the proxy holds the
real one, and every push is inspected for chunk size, file count, message format and session
budget **before** it can reach the remote.

The name is the design: the agent never touches the real token, and nothing gets through
uninspected.

```
[ agent / MCP client ]
        |  uses a placeholder token, points its remote here
        v
[ commit-condom proxy ]  --- the gate ---
        |   1. serves the mirror (sync from upstream with the real PAT)
        |   2. receive-pack, whose pre-receive hook runs the policy engine
        |   3. only if the hook accepts, forward upstream with the real PAT
        v
[ github.com ]
```

## Why a proxy and not just a hook

A client-side hook is advice. `git commit --no-verify`, `git push --no-verify`, `-c
core.hooksPath=/dev/null`, or a git binary replaced by a wrapper will each skip it, and an agent
that is stuck will eventually find one of them.

The gate here is `pre-receive` **on the mirror the proxy owns**, which means it runs on the
server side of the push. The client cannot skip it, because the client is not the one running
it. Verified in the test suite: a monolith push is rejected, and `--no-verify` changes nothing.

## What it enforces

Rules come from a per-repo policy, or from `--policy`. All of them are optional; unset means off.

| Rule | Example | What the agent is told |
|---|---|---|
| `max_files_per_commit` | `2` | which files to group, and the exact `git reset --soft` recovery |
| `max_diff_lines` | `400` | to split by concern, or use `git add -p` |
| `require_conventional` | `true` | `type(scope): what (why)`, with the allowed types |
| `max_subject_length` | `72` | to move detail into the body |
| `chunking.min_commits_for_files` | `{"3":2,"5":3,"10":5}` | how many commits the push needs |
| `block_diff_patterns` | secret regexes | that a credential must be removed and rotated |
| `session_budget` | `{max_commits, max_total_lines}` | that the session is out of budget and a human must raise it |

Every rejection carries a **fix**, not just a verdict. An agent told only "rejected" retries the
same monolith; an agent told `git add a.js b.js && git commit -m ...` usually complies.

## Making the policy unskipable

A per-repo `.condom.json` is read by a *client* hook, so `push --no-verify` skips it. To make a
repo's rules apply no matter what the pusher does, register them with the proxy instead:

```sh
cc policy set <owner>/<repo> ./my-strict-policy.json   # stored in the proxy's own data dir
cc policy ls                                            # what is registered
cc policy rm <owner>/<repo>                             # back to the machine policy
```

The registry lives outside any working tree (`~/.commit-condom/policies/`), so a push cannot edit,
weaken or delete it — and the proxy reads it, not the incoming commit.

## The simple version: a dummy PAT for agents

The registry is for per-repo overrides. The everyday model is smaller than that:

1. **The real PAT lives only in the proxy.** `~/.config/commit-condom/pat.env`, mode 600, loaded
   by the service. Nothing else holds it.
2. **The proxy applies the rules** from `~/.config/commit-condom/policy.json` to every push.
3. **Every agent gets a dummy PAT** — a token that is deliberately not real:

   ```sh
   node bin/cc-wire-machine.js agent            # writes the dummy into ~/.git-credentials
   ```

   Git sends the dummy to the proxy, which ignores the client's credential and forwards with the
   real PAT. Every push is gated.

That last step is what closes the `--no-verify` hole for good, because the agent has no working
token of its own. Editing its remote to point at GitHub does not help — GitHub rejects the dummy:

```
$ git push https://github.com/owner/repo.git        # with the dummy
remote: Invalid username or token. Password authentication is not supported for Git operations.
fatal: Authentication failed
```

So the only way an agent can push is through the proxy, and the proxy enforces the rules. Verified
live and in `test/wire.test.js` and `test/inescapable.test.js`.

**Residual, stated plainly:** the real PAT file is mode 600 owned by the same user the agent runs
as. An agent that reads arbitrary local files despite instructions could still find it. Keeping
the token truly out of reach means running the proxy as a different user (or on a different
machine) than the agent. This design removes the `--no-verify` bypass and the client-hook hole;
it does not replace an account boundary.

## Install

```sh
git clone https://github.com/ronisaguey-ux/commit-condom && cd commit-condom
# 1. the gate (holds the real PAT — never give this to the agent)
CC_PAT=ghp_your_real_token node bin/cc-proxy.js --port 8877 --policy ./policy.example.json
```

Then, in the agent's clone, point the remote at the proxy instead of GitHub:

```sh
git remote set-url origin http://127.0.0.1:8877/<owner>/<repo>.git
```

The proxy clones a mirror on first use and keeps it in sync. Reads (clone/fetch) and writes
both go through it, so the agent needs no GitHub credential at all.

It keeps a real PAT's behaviour, including branch and tag deletion: a ref the client removes in
the push is removed upstream too, and only that ref — the forward deletes exactly what the client
deleted, never a blanket prune that could drop a branch published upstream in between.

Optional, for an agent you can modify: install the fast local mirror of the gate and the flag
guard, so the agent learns about a bad commit at the command instead of at the push.

```sh
node bin/cc.js install-hooks --repo /path/to/agent/clone
ln -s "$PWD/bin/git-guard.sh" /path/to/sandbox/bin/git   # refuses --no-verify, core.hooksPath, ...
export GIT_CONFIG_PARAMETERS="'core.hooksPath=/dev/null'"  # neutralise, do not rely on
```

## MCP tools (the cooperative path)

The proxy is coercive; these let an agent ask for the right shape first. Same policy engine,
so a plan that satisfies the tools will pass the gate.

| Tool | Purpose |
|---|---|
| `cc_plan` | propose atomic commits for the working tree, with suggested messages |
| `cc_commit` | stage exactly these paths and commit, policy-checked before the index is touched |
| `cc_check` | evaluate a range and return the violations without pushing |
| `cc_status` | branch, staged/untracked counts, the policy in force, remaining budget |
| `cc_audit` | the session ledger, hash-verified |

```
node mcp/server.js    # stdio MCP server, no dependencies
```

## The ledger

Every accepted commit is appended to `.condom/ledger.jsonl`, each entry hashing the one before
it. `cc audit` (or `cc_audit`) walks the chain and reports the first entry that does not match,
so an edited or deleted line is detectable rather than invisible. It is also what the session
budget counts.

## Honest limits

- **The proxy is the boundary.** An agent that has a real PAT, or an independent path to the
  remote that does not go through this process, is not gated. Keeping the credential out of the
  agent's environment is what makes the gate real — the rest is enforcement.
- **A mirror is a second copy of the repository.** It lives under `--data` (default
  `~/.commit-condom/mirrors`). It contains whatever the repo contains.
- **The mirror must be in sync for a push to validate.** It is fetched before every ref
  advertisement; a push that arrives while an external human push is in flight will be computed
  against the pre-fetch refs and simply be rejected rather than silently accepted.
- **`block_diff_patterns` is a regex net, not a scanner.** It catches the shapes it is
  configured with. It is not a substitute for a real secret scanner.
- **The policy rules are structural.** They can make a change reviewable; they cannot make it
  correct, and a well-formed commit can still be wrong.

## Tests

```
npm test     # 34 checks: policy engine, proxy end-to-end, MCP tools
```

The proxy suite runs the whole path against a local bare repository standing in for GitHub — no
network, no real token — and asserts that a monolith push is rejected, that `--no-verify` does
not bypass the gate, that a rejected commit never reaches upstream, and that the token neverappears in the log.

## Machine-wide wiring

To make one machine obtain its GitHub credential *only* through this proxy:

```sh
# 1. the PAT stays here (mode 600), and the proxy runs as a service
mkdir -p ~/.config/commit-condom && printf 'CC_PAT=%s\n' "$YOUR_PAT" > ~/.config/commit-condom/pat.env
chmod 600 ~/.config/commit-condom/pat.env
# 2. route everything through it
node bin/cc-wire-machine.js install
node bin/cc-wire-machine.js status     # confirms: rewrites set, service up, PAT not in the store
node bin/cc-wire-machine.js revert     # undo, restoring the previous credential store
```

`install` rewrites every `https://github.com/` URL to the proxy and removes the token from
`~/.git-credentials`, so the PAT exists in exactly one place. It backs both files up first and
refuses to run if the proxy's `pat.env` is missing — otherwise it would lock you out.

Two things it does **not** do, by design:

- **It does not enforce the strict commit rules on every repo.** The machine policy is a
  credential gateway plus a secret scan; `max_files_per_commit` and friends stay opt-in per
  project, because a two-file cap on every repository on a machine blocks ordinary work.
- **It does not cover ssh remotes.** `git@github.com:...` is not an http URL and never reaches
  the proxy. `status` lists any it finds.

## Layout

```
bin/cc.js            the CLI the hooks and MCP call
bin/cc-proxy.js      the proxy entry point (holds the real PAT)
bin/git-guard.sh     git shim for the agent's PATH (fast feedback on a bypass attempt)
src/policy.js        the policy engine (pure rules over commit metadata)
src/proxy.js         git smart HTTP: mirror, gate, forward
src/config.js        policy loading and defaults
src/ledger.js        hash-chained session ledger
mcp/server.js        MCP tools
hooks/               (installed by `cc install-hooks`)
```

## Credit

The design draws on [GitProxy](https://github.com/finos/git-proxy) (FINOS), which established
the proxy-as-policy-engine pattern for git pushes, and on the git-askpass placeholder-token
trick popularised by agent sandboxes. This project aims those at commit *structure* rather than
access control.

MIT.
