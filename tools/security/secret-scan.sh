#!/usr/bin/env bash
#
# Secret scanning. NON_NEGOTIABLES rule 20.
#
# Gitleaks, as a standalone pinned binary — deliberately NOT the GitHub
# Action. An action is a third party executing arbitrary code in a job that
# holds GITHUB_TOKEN; a pinned tarball verified against a recorded SHA256 is a
# smaller surface and it is auditable from this file alone.
#
#   bash tools/security/secret-scan.sh            # scan history + worktree
#   bash tools/security/secret-scan.sh --staged   # pre-commit style
#
# ── Failure semantics, which are the whole point ─────────────────────────
#
# Gitleaks exits 1 when it FINDS something and a non-zero, non-1 code when it
# FAILS to run — a bad config, an unreadable repo, an out-of-memory. Treating
# "not 1" as success is how a scanner quietly stops scanning while CI stays
# green. Both outcomes fail here, and they are reported differently so the
# difference is visible.
#
# There is no bypass flag, no environment variable that skips it and no
# allowlist argument. A finding that is genuinely a false positive is
# suppressed in .gitleaks.toml, in a commit, with a reason — which is
# reviewable. A flag on a command line is not.

set -euo pipefail

VERSION="8.30.1"
# sha256 of gitleaks_${VERSION}_linux_x64.tar.gz, from the release's own
# checksums file AND verified by downloading the artifact and hashing it.
# If upstream ever re-cuts this tag, this fails rather than running whatever
# is now behind the URL.
SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

BIN_DIR="${RUNNER_TEMP:-/tmp}/gitleaks-${VERSION}"
BIN="${BIN_DIR}/gitleaks"

fail() {
  printf '\n\033[31m%s\033[0m\n' "$1"
  exit 1
}

# ---------------------------------------------------------------------------
# Install, verified
# ---------------------------------------------------------------------------
if [ ! -x "$BIN" ]; then
  mkdir -p "$BIN_DIR"
  TARBALL="${BIN_DIR}/gitleaks.tar.gz"
  URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_linux_x64.tar.gz"

  echo "installing gitleaks ${VERSION}"
  curl -sSfL --max-time 120 "$URL" -o "$TARBALL" ||
    fail "SCANNER ERROR: could not download gitleaks ${VERSION}"

  ACTUAL=$(sha256sum "$TARBALL" | cut -d' ' -f1)
  if [ "$ACTUAL" != "$SHA256" ]; then
    # Not a warning. A mismatch means the artifact is not the one this
    # repository reviewed, and running it would be running unreviewed code
    # with access to the whole checkout.
    fail "SCANNER ERROR: checksum mismatch for gitleaks ${VERSION}
  expected $SHA256
  actual   $ACTUAL"
  fi

  tar -xzf "$TARBALL" -C "$BIN_DIR" gitleaks ||
    fail "SCANNER ERROR: could not extract gitleaks"
  chmod +x "$BIN"
fi

"$BIN" version >/dev/null 2>&1 || fail "SCANNER ERROR: gitleaks binary will not run"
echo "gitleaks $("$BIN" version 2>&1 | head -1), checksum verified"

# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------
# --redact so a finding's VALUE never reaches the log. CI logs are retained,
# readable by anyone with repository access, and exportable — printing the
# secret in order to report the secret would widen the exposure the scan
# exists to catch.
ARGS=(--redact --verbose --exit-code 1)
[ -f .gitleaks.toml ] && ARGS+=(--config .gitleaks.toml)

MODE="${1:-}"
if [ "$MODE" = "--staged" ]; then
  echo "scanning staged changes"
  set +e
  "$BIN" protect --staged "${ARGS[@]}"
  CODE=$?
  set -e
else
  # Full history, not just the diff. A secret committed six months ago and
  # deleted yesterday is still in the pack file and still compromised; a
  # diff-only scan reports the repository clean.
  echo "scanning full history and working tree"
  set +e
  "$BIN" detect "${ARGS[@]}"
  CODE=$?
  set -e
fi

# ---------------------------------------------------------------------------
# Interpret the exit code. See the note at the top.
# ---------------------------------------------------------------------------
case "$CODE" in
  0)
    printf '\n\033[32mNo secrets detected.\033[0m\n'
    ;;
  1)
    fail "SECRETS DETECTED — see the redacted findings above.

Rule 20: secrets are never committed, never logged, never printed.

A real secret is ROTATED FIRST, then removed from history. Deleting the line
in a new commit does not help: the value is still in the object store and
must be treated as compromised from the moment it was pushed.

A false positive is suppressed in .gitleaks.toml, in a commit, with a reason."
    ;;
  *)
    fail "SCANNER ERROR: gitleaks exited $CODE without completing a scan.

This is NOT a pass. The repository has not been scanned, and a failure to
scan is treated exactly as seriously as a finding — otherwise a broken
scanner is indistinguishable from a clean repository."
    ;;
esac
