#!/usr/bin/env bash
#
# Post-deploy smoke test.
#
#   bash infrastructure/staging/smoke.sh http://31.220.74.159
#
# Asks the deployed thing whether it works. A deploy step that reports success
# because `docker compose up` exited zero has reported that a command ran, not
# that a system is serving.

set -euo pipefail

BASE="${1:?usage: smoke.sh <base-url>}"
ATTEMPTS=30
INTERVAL=5

fail() {
  printf '\n\033[31mSMOKE FAILED: %s\033[0m\n' "$1"
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Liveness, with a wait. Containers take time to start and a probe run the
#    instant the deploy returns measures the deploy, not the service.
# ---------------------------------------------------------------------------
printf 'waiting for liveness '
for i in $(seq 1 "$ATTEMPTS"); do
  if curl -fsS --max-time 5 "$BASE/api/health" >/dev/null 2>&1; then
    printf ' up after %ss\n' "$(((i - 1) * INTERVAL))"
    break
  fi
  [ "$i" -eq "$ATTEMPTS" ] && fail "no liveness after $((ATTEMPTS * INTERVAL))s"
  printf '.'
  sleep "$INTERVAL"
done

LIVE=$(curl -fsS --max-time 5 "$BASE/api/health")
echo "  liveness: $LIVE"
echo "$LIVE" | grep -q '"status":"ok"' || fail "liveness did not report ok"

# ---------------------------------------------------------------------------
# 2. Readiness — the one that actually proves the stack is wired together.
#    Liveness touches nothing; readiness reaches PostgreSQL and checks the
#    schema version, so a green readiness means the API found the database,
#    authenticated as finsoft_app and read a real table.
# ---------------------------------------------------------------------------
READY=$(curl -fsS --max-time 10 "$BASE/api/health/ready") ||
  fail "readiness returned non-2xx: $(curl -sS --max-time 10 "$BASE/api/health/ready" || true)"
echo "  readiness: $READY"
echo "$READY" | grep -q '"status":"ready"' || fail "readiness did not report ready"

# ---------------------------------------------------------------------------
# 3. Nothing internal leaks through the proxy. rule 20 — the readiness body is
#    public and unauthenticated, so it must never carry a host, a port, a role
#    or a connection string.
# ---------------------------------------------------------------------------
for LEAK in postgres:// 5432 finsoft_app finsoft_migration password; do
  echo "$READY" | grep -qi -- "$LEAK" && fail "readiness body leaked '$LEAK' (rule 20)"
done
echo "  no internal detail in the public body"

# ---------------------------------------------------------------------------
# 4. The data plane is NOT reachable from outside. Docker writes iptables
#    rules that bypass ufw, so a published database port is open to the
#    internet while ufw reports it denied. This asserts the posture holds
#    rather than assuming it.
# ---------------------------------------------------------------------------
HOSTONLY=${BASE#http://}
HOSTONLY=${HOSTONLY%%/*}
HOSTONLY=${HOSTONLY%%:*}
for PORT in 5432 6379 3001 3002; do
  if timeout 3 bash -c "</dev/tcp/$HOSTONLY/$PORT" 2>/dev/null; then
    fail "port $PORT is reachable from the internet; only 80 may be"
  fi
done
echo "  5432, 6379, 3001, 3002 all closed from outside"

# ---------------------------------------------------------------------------
# 5. A real application request through the proxy.
#
#    Readiness proves the API found its database. It says nothing about
#    whether the thing a person opens actually renders — and those fail
#    independently: the web container can be down, or the proxy misrouted,
#    with a perfectly ready API behind it.
# ---------------------------------------------------------------------------
printf 'waiting for the web application '
for i in $(seq 1 "$ATTEMPTS"); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then
    printf ' up after %ss\n' "$(((i - 1) * INTERVAL))"
    break
  fi
  [ "$i" -eq "$ATTEMPTS" ] && fail "GET / returned $CODE after $((ATTEMPTS * INTERVAL))s"
  printf '.'
  sleep "$INTERVAL"
done

# Rendered HTML, not just a 200. A proxy error page is also a 200 in some
# configurations, and an empty shell would satisfy a status-code check.
BODY=$(curl -fsS --max-time 10 "$BASE/")
echo "$BODY" | grep -q '<title>' || fail "GET / returned no <title> — not a rendered page"
echo "  GET / renders: $(echo "$BODY" | grep -oE '<title>[^<]*</title>' | head -1)"

# Same origin, which is the reason the proxy exists at all: ADR-0009's refresh
# cookie is SameSite=Strict and a cross-origin call would never send it.
echo "$BODY" | grep -qi 'localhost:3001\|127.0.0.1:3001' &&
  fail "the page references the API by host:port — it is not being served same-origin"

printf '\n\033[32mSMOKE PASSED\033[0m\n'
