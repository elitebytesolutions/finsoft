#!/usr/bin/env bash
#
# Provision the Contabo staging host.
#
# Idempotent: safe to re-run. It is written as a script rather than typed over
# SSH so the state of that machine is reviewable in the repository, and so a
# rebuild is a re-run instead of an archaeology exercise.
#
#   scp infrastructure/staging/provision.sh vps:/tmp/
#   ssh vps 'bash /tmp/provision.sh'
#
# Staging only. Production is a different provider (INFRASTRUCTURE §1) and no
# agent has a path to it.

set -euo pipefail

DEPLOY_USER=deploy
APP_DIR=/opt/finsoft
SWAP_SIZE=4G

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
log "Docker"
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # Docker's own repository, not Ubuntu's docker.io package: the distro build
  # lags and does not ship the compose v2 plugin this stack uses.
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker
else
  echo "already installed: $(docker --version)"
fi

# ---------------------------------------------------------------------------
log "Swap (${SWAP_SIZE})"
# ---------------------------------------------------------------------------
# The box has none. With PostgreSQL, Redis and three Node processes on 8 GB, a
# spike OOM-kills a container outright rather than degrading — and the process
# the kernel picks is not the one that caused it.
if ! swapon --show | grep -q .; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  # Prefer reclaiming cache to swapping out a live process. The swap is a
  # safety net against the OOM killer, not a memory tier to run in.
  sysctl -qw vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >>/etc/sysctl.conf
else
  echo "already present"
fi

# ---------------------------------------------------------------------------
log "Deploy user"
# ---------------------------------------------------------------------------
# CI does not get root. A compromised workflow run should not own the machine,
# and the deploy identity has to be revocable without touching human access.
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
else
  echo "already exists"
fi

# ── Read this before calling the deploy user "least privilege" ─────────────
#
# It is not. Membership of `docker` is ROOT-EQUIVALENT on this host: the
# daemon runs as root and any member of the group can start a container that
# bind-mounts / and writes to it. `deploy` has no password and no sudo, and
# neither of those closes that path.
#
# What the separate identity actually buys, which is worth having but is not
# isolation:
#
#   - a revocable credential. Removing one key ends CI's access without
#     touching any human's, and leaves an obvious audit trail of what changed.
#   - attribution. Deploy actions are that key's, not a shared root login's.
#   - no interactive or password path, so the key is the only way in.
#
# What it does NOT buy: protection from a compromised workflow run. Such a run
# can become root on this machine. The mitigations that matter for that are
# the ones on the CI side — short-lived tokens, a pinned host key, and a
# deploy job that cannot start unless the gates passed.
#
# The real fix is rootless Docker, and the tooling is present on this host
# (dockerd-rootless-setuptool.sh). It is deliberately NOT done here: it moves
# the daemon to a user socket and needs net.ipv4.ip_unprivileged_port_start
# lowered for the proxy to bind :80, which is a change to make on its own and
# verify, not one to fold into a deployment.
usermod -aG docker "$DEPLOY_USER"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "/home/$DEPLOY_USER/.ssh"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0755 "$APP_DIR"

# ---------------------------------------------------------------------------
log "Firewall"
# ---------------------------------------------------------------------------
# READ THIS BEFORE PUBLISHING A PORT.
#
# Docker writes its own iptables rules into the DOCKER chain, which is
# traversed BEFORE ufw's. A container published with `-p 5432:5432` is
# reachable from the internet even while `ufw status` shows PostgreSQL denied.
# ufw is not a backstop for a published port; it does not see it.
#
# So the rule for this stack is: every container binds to 127.0.0.1 and the
# reverse proxy is the only thing that publishes to 0.0.0.0. ufw below is
# defence for the HOST's own services, not for containers.
ufw allow OpenSSH >/dev/null          # before enabling, or this session dies
ufw allow 80/tcp >/dev/null           # ACME HTTP-01 + the redirect to 443
ufw allow 443/tcp >/dev/null          # the reverse proxy's HTTPS listener
ufw --force enable >/dev/null         # `ufw allow` is itself idempotent — a
                                       # re-run against an already-enabled
                                       # firewall with these rules present is
                                       # a no-op, not an error
ufw status verbose | head -6

# ---------------------------------------------------------------------------
log "Done"
# ---------------------------------------------------------------------------
docker --version
docker compose version
echo "app dir:     $APP_DIR"
echo "deploy user: $DEPLOY_USER (groups: $(id -nG "$DEPLOY_USER" | tr ' ' ','))"
free -h | grep -i swap
