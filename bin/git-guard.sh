#!/bin/sh
# commit-condom: a `git` shim for the agent's PATH.
#
# The proxy is the authoritative gate, and it cannot be bypassed because the credential is
# not in the agent's environment. This shim is defence in depth and, more usefully, fast
# feedback: it refuses the flags that would silently skip the LOCAL hooks, so the agent finds
# out at the command rather than at the push.
#
# Install by putting a symlink to this file before the real git in the agent's PATH:
#   ln -s /path/to/commit-condom/bin/git-guard.sh /sandbox/bin/git
# Set CC_REAL_GIT if git is not at /usr/bin/git.
#
# It does NOT block `-c` in general (git -c user.email=... is normal). It blocks only the
# keys that would disable enforcement.
set -eu

REAL_GIT="${CC_REAL_GIT:-/usr/bin/git}"

refuse() { echo "commit-condom: $1" >&2; exit 1; }

# Pass 1: flags that are never acceptable.
for a in "$@"; do
  case "$a" in
    --no-verify) refuse "--no-verify is refused. The remote gate runs regardless — fix the commits, do not skip the check." ;;
    --config-env|--config-env=*) refuse "--config-env is refused (it can redirect core.hooksPath)." ;;
  esac
done

# Pass 2: `-c <key>=<value>` and `-c<key>=<value>`, plus the long form. Only the keys that
# control enforcement are refused.
prev=""
for a in "$@"; do
  key=""
  case "$a" in
    -c) : ;;                                  # the key arrives as the NEXT argument
    -c*) key="${a#-c}" ;;                     # -ccore.hooksPath=...
    --config=*) key="${a#--config=}" ;;
    *) key="" ;;
  esac
  case "$key" in
    core.hooksPath=*|credential.helper=*|commit.gpgsign=*|transfer.credentialsUrl=*|transfer.credentialsInUrl=*)
      refuse "refusing to override $key — enforcement config is not the agent's to change." ;;
  esac
  # when -c is separate, the next arg carries the key
  if [ "$prev" = "-c" ]; then
    case "$a" in
      core.hooksPath=*|credential.helper=*|commit.gpgsign=*|transfer.credentialsInUrl=*)
        refuse "refusing to override $a — enforcement config is not the agent's to change." ;;
    esac
  fi
  prev="$a"
done

exec "$REAL_GIT" "$@"
