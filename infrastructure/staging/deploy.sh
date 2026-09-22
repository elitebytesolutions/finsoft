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
resolve() {
  local name="ghcr.io/${REPO}-$1:${SHA}"
  docker pull -q "$name" >/dev/null
  docker inspect --format '{{index .RepoDigests 0}}' "$name"
}

{
  echo "# Written by CI on $(date -u +%FT%TZ). Digests, never tags."
  echo "API_IMAGE=$(resolve api)"
  echo "WORKER_IMAGE=$(resolve worker)"
  echo "APP_VERSION=${SHA}"
} >.env.images

echo "deploying:"
grep -E '^(API|WORKER)_IMAGE=' .env.images

# Two env files, and the split is the point: .env holds database credentials
# generated on this host that CI has never seen and cannot read, .env.images
# holds only what CI just resolved. A workflow run never handles a database
# password (INFRASTRUCTURE §6).
#
# apps/web is absent deliberately — it is behind a compose profile because it
# does not build yet (FND-017). Adding --profile web is the whole change once
# it does.
compose() { docker compose --env-file .env --env-file .env.images "$@"; }

compose up -d --remove-orphans
compose ps

# Images from superseded deploys accumulate on a 96 GB disk. Dangling only:
# a broader prune would remove the previous release's image, which is what a
# rollback needs.
docker image prune -f --filter 'dangling=true' >/dev/null 2>&1 || true
