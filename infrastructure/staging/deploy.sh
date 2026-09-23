#!/usr/bin/env bash
#
# Deploy to staging. Runs ON the staging host, piped in over SSH by CI:
#
#   ssh deploy@host REGISTRY_TOKEN=… ACTOR=… SHA=… REPO=… 'bash -s' < deploy.sh
#
# It lives in a file rather than inline in the workflow for two reasons: shell
# quoted inside YAML inside an SSH invocation is three layers of escaping and
# gets silently mangled, and a file can be read, reviewed and run by hand when
# a deploy needs doing at 3am with CI down.

set -euo pipefail

: "${REGISTRY_TOKEN:?}" "${ACTOR:?}" "${SHA:?}" "${REPO:?}"

cd /opt/finsoft

# The run's own token, removed on the way out however this script exits. No
# registry credential is left behind on the host.
echo "$REGISTRY_TOKEN" | docker login ghcr.io -u "$ACTOR" --password-stdin
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

# Resolve a tag to the immutable digest it currently points at, and deploy
# THAT. Tags move; digests do not. infrastructure/README.md requires the image
# which passed staging to be the image that runs in production, and only a
# digest can carry that promise across two providers.
# Fails loudly. An earlier version let a failed pull fall through: `set -e`
# does not abort a failing command inside a command substitution whose output
# is being redirected, so a denied registry pull wrote API_IMAGE= (empty) and
# the deploy continued to compose, which then failed with a confusing
# interpolation error several steps from the real cause.
# `exit` inside a command substitution exits only that SUBSHELL, so the first
# version of this — which called resolve() from inside the here-doc that wrote
# .env.images — printed FATAL and carried on regardless, producing an empty
# API_IMAGE= and a compose interpolation error three steps later. Twice.
#
# So resolution happens into plain variables, checked in the parent shell,
# BEFORE anything is written. A digest that cannot be resolved stops the
# deploy where the problem is.
resolve() {
  local name="ghcr.io/${REPO}-$1:${SHA}" digest

  # A pull can fail transiently — registry 5xx, a slow manifest, a network
  # blip — and retrying is cheaper than a failed deploy that needs a human.
  local attempt
  for attempt in 1 2 3; do
    if docker pull -q "$name" >/dev/null 2>&1; then
      digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$name" 2>/dev/null || true)
      [ -n "$digest" ] && { printf '%s' "$digest"; return 0; }
    fi
    [ "$attempt" -lt 3 ] && sleep $((attempt * 5))
  done

  echo "FATAL: cannot resolve $name after 3 attempts." >&2
  echo "  Login succeeded but the pull was denied? The package is probably not" >&2
  echo "  linked to the repository — see org.opencontainers.image.source in" >&2
  echo "  the images job, and check the package's visibility." >&2
  return 1
}

API_IMAGE=$(resolve api) || exit 1
WORKER_IMAGE=$(resolve worker) || exit 1
WEB_IMAGE=$(resolve web) || exit 1

{
  echo "# Written by CI on $(date -u +%FT%TZ). Digests, never tags."
  echo "API_IMAGE=${API_IMAGE}"
  echo "WORKER_IMAGE=${WORKER_IMAGE}"
  echo "WEB_IMAGE=${WEB_IMAGE}"
  echo "APP_VERSION=${SHA}"
} >.env.images

echo "deploying:"
grep -E '^(API|WORKER|WEB)_IMAGE=' .env.images

# Two env files, and the split is the point: .env holds database credentials
# generated on this host that CI has never seen and cannot read, .env.images
# holds only what CI just resolved. A workflow run never handles a database
# password (INFRASTRUCTURE §6).
#
compose() { docker compose --env-file .env --env-file .env.images "$@"; }

# The data plane first, so migrations have something to connect to.
compose up -d postgres redis

# Migrations, as a one-shot that exits. This is the only process that ever
# holds finsoft_migration's BYPASSRLS credential, and it is gone when the
# container stops — the API never receives it (ADR-0004:59).
#
# Before the application starts, deliberately: the API's readiness probe
# refuses to report ready below REQUIRED_SCHEMA_VERSION, so starting it first
# would mean a window of a live-but-not-ready service for no reason.
echo "running migrations"
# -T and </dev/null: belt and braces. `compose run` attaches stdin by default,
# which is exactly how this script got eaten when it was piped in over SSH —
# the migrate container consumed everything after this line, so `up -d` never
# ran and the deploy still exited 0. It runs as a file now, but a one-shot
# that silently swallows its caller's input is worth closing off for good.
compose run --rm -T migrate </dev/null

compose up -d --remove-orphans
compose ps

# Images from superseded deploys accumulate on a 96 GB disk. Dangling only:
# a broader prune would remove the previous release's image, which is what a
# rollback needs.
docker image prune -f --filter 'dangling=true' >/dev/null 2>&1 || true
