# Runbook: provisioning `AUTH_JWT_*` on the staging host

**ADR-0009.** `packages/auth/src/jwt.ts` refuses to build its key set unless
`NODE_ENV` is exactly `development` or `test`, **or** three variables are
set: `AUTH_JWT_PRIVATE_KEY` (a PKCS8 PEM, passed to `jose`'s `importPKCS8`
as-is — real newline bytes required, not an escaped `\n`), `AUTH_JWT_KID`
(the signing key's id), and `AUTH_JWT_PUBLIC_KEYS` (a JSON array of
`{kid, pem}`, SPKI PEMs, which **must include** the signing kid — that's how
a token this process signs can also be verified by it and by every other
instance in the fleet reading the same variable).

Staging runs `NODE_ENV=production`, so the ephemeral allowlist in
`ephemeralKeysAllowed()` never applies there. `infrastructure/staging/compose.yaml`
declares all three with a `:?` guard on the `api` service:

```yaml
AUTH_JWT_PRIVATE_KEY: ${AUTH_JWT_PRIVATE_KEY:?see infrastructure/staging/RUNBOOK-jwt-keys.md}
AUTH_JWT_KID: ${AUTH_JWT_KID:?see infrastructure/staging/RUNBOOK-jwt-keys.md}
AUTH_JWT_PUBLIC_KEYS: ${AUTH_JWT_PUBLIC_KEYS:?see infrastructure/staging/RUNBOOK-jwt-keys.md}
```

A missing variable fails `docker compose config`/`up` itself, before any
container starts — not a crash-loop on the API's own boot check, though that
check is also there as a second line of defence for any path that reads the
variables directly.

## Gate

**This step is a hard blocker**, same as
[`RUNBOOK-finsoft-refresh-role.md`](RUNBOOK-finsoft-refresh-role.md): run it
**before merging the PR that ships `packages/auth` to `main`** — i.e. before
that PR's deploy job reaches staging. `deploy.sh` never holds these
variables and never will (INFRASTRUCTURE §6: a workflow run never handles a
signing key, any more than it handles a database password); they live only
in `/opt/finsoft/.env` on the host, written once, by hand.

I (the agent that wrote this) do not have SSH access to the staging host and
have not run this. A human operator with `deploy`/staging access runs the
commands below.

## What was verified before writing this (and what was not)

- **Compose version parity.** The staging host runs Compose v5.5.1
  (`ssh vps 'docker compose version'`, read-only, no state changed); the
  verification below was built and run locally against v5.1.4 — same major
  version, and env-file interpolation of a quoted scalar has not changed
  behaviour across v5 minors.
- **A double-quoted, multi-line PEM in `--env-file` round-trips exactly**
  through `docker compose config`, byte for byte, *provided the value is
  written into the file directly (e.g. `cat key.pem` between the quotes)
  rather than passed through a shell command substitution first* —
  `$(cat file)` strips the file's trailing newline(s), which silently
  truncates the PEM by one line ending. Confirmed with a throwaway RSA-2048
  keypair (never committed, generated in a scratch directory and discarded):
  `docker compose --env-file .env.test config --format json` returned
  `AUTH_JWT_PRIVATE_KEY` identical in length and content to the source file.
- **`jose`'s `importPKCS8`/`importSPKI` accept the round-tripped value**, and
  a full sign → verify round trip with that exact key pair succeeded. This
  is the actual consumer, not just the compose layer — both were checked.
- **Not verified, and out of scope for this change:** anything on the
  staging host itself was changed. Only a read-only `docker compose version`
  was run there.

This is why the script below builds the `.env` lines by appending file
contents directly (`cat "$TMP_PRIV"` inside the quotes), never via
`VAR=$(cat file)` followed by `printf "%s" "$VAR"`.

## Step 1 — generate the key pair on the host (one-time, or on rotation)

As the `deploy` user, in `/opt/finsoft`:

```sh
ssh deploy@<staging-host>
cd /opt/finsoft
umask 077

KID="staging-$(date -u +%Y-%m)"   # e.g. staging-2026-09. On a same-month
                                  # rotation, append a serial: staging-2026-09b.

TMP_PRIV=$(mktemp)
TMP_PUB=$(mktemp)
trap 'shred -u "$TMP_PRIV" "$TMP_PUB" 2>/dev/null || rm -f "$TMP_PRIV" "$TMP_PUB"' EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP_PRIV"
openssl pkey -in "$TMP_PRIV" -pubout -out "$TMP_PUB"
```

`genpkey` writes PKCS8 (`-----BEGIN PRIVATE KEY-----`) directly — no
separate conversion step, and no passphrase (an encrypted private key would
need a passphrase supplied at every process boot, which trades one secret
for two). `openssl pkey -pubout` writes SPKI (`-----BEGIN PUBLIC KEY-----`),
which is what `importSPKI` expects.

Neither command above prints the key material to the terminal.

## Step 2 — append to `.env` without ever echoing the private key

```sh
PUB_JSON=$(jq -n --rawfile pem "$TMP_PUB" --arg kid "$KID" '[{kid: $kid, pem: $pem}]')

{
  printf '\n# AUTH_JWT_* added by RUNBOOK-jwt-keys.md, %s, kid=%s\n' "$(date -u +%FT%TZ)" "$KID"
  printf 'AUTH_JWT_KID=%s\n' "$KID"
  printf 'AUTH_JWT_PRIVATE_KEY="'
  cat "$TMP_PRIV"
  printf '"\n'
  printf 'AUTH_JWT_PUBLIC_KEYS=%s\n' "$PUB_JSON"
} >> .env

chmod 600 .env
```

`jq -n --rawfile` reads the public PEM as a raw string and builds JSON safely
(no manual escaping, no risk of breaking on the PEM's own newlines). The
private key line is written by piping the temp file's bytes directly between
two literal double-quotes in the `printf`/`cat` sequence — never assigned to
a shell variable, never passed through `$(...)` (which would strip its
trailing newline and truncate the key by one line ending — see above),
and never displayed. `chmod 600` is reasserted every run in case a prior
edit loosened it.

Rerunning Step 1 and Step 2 for the same `KID` value would append a
duplicate, contradictory line — pick a new `KID` per rotation (see below) or
edit `.env` by hand if correcting a mistake.

## Step 3 — verify parse and cryptographic validity, without printing secrets

**a. Compose parses the file and the three variables satisfy their `:?`
guards:**

```sh
docker compose --env-file .env --env-file .env.images config --format json | jq -r '
  .services.api.environment |
  "AUTH_JWT_KID: " + .AUTH_JWT_KID,
  "AUTH_JWT_PRIVATE_KEY: " + (.AUTH_JWT_PRIVATE_KEY | length | tostring) + " chars (value not printed)",
  "AUTH_JWT_PUBLIC_KEYS kids: " + ((.AUTH_JWT_PUBLIC_KEYS | fromjson | map(.kid)) | join(", "))
'
```

Expect the `AUTH_JWT_KID` value to appear once as the KID, the private key
length to be roughly 1700 characters (a 2048-bit PKCS8 PEM, give or take a
few for line-wrap and the header/footer), and the signing `KID` to appear in
the public-keys list.

**b. The key actually imports and signs/verifies, using the exact bytes the
running `api` service would see** — run inside the same image, never on the
bare host:

```sh
cat > .verify-jwt.mjs <<'JS'
import { importPKCS8, importSPKI, exportJWK, calculateJwkThumbprint, SignJWT, jwtVerify } from 'jose'

const kid = process.env.AUTH_JWT_KID
const priv = await importPKCS8(process.env.AUTH_JWT_PRIVATE_KEY, 'RS256')
const entries = JSON.parse(process.env.AUTH_JWT_PUBLIC_KEYS)
const signingEntry = entries.find((e) => e.kid === kid)
if (!signingEntry) {
  console.error(`FAIL: AUTH_JWT_KID "${kid}" is not present in AUTH_JWT_PUBLIC_KEYS`)
  process.exit(1)
}
const pub = await importSPKI(signingEntry.pem, 'RS256')
const jwt = await new SignJWT({ sub: 'verify-jwt-keys' })
  .setProtectedHeader({ alg: 'RS256', kid })
  .setIssuedAt()
  .setExpirationTime('1m')
  .sign(priv)
const { payload } = await jwtVerify(jwt, pub, { issuer: undefined, audience: undefined })
const thumbprint = await calculateJwkThumbprint(await exportJWK(pub))
console.log('kid:', kid)
console.log('public key thumbprint (RFC 7638, SHA-256):', thumbprint)
console.log('sign -> verify round trip:', payload.sub === 'verify-jwt-keys' ? 'OK' : 'FAIL')
JS

docker compose --env-file .env --env-file .env.images run --rm -T --no-deps \
  -v "$(pwd)/.verify-jwt.mjs:/verify-jwt.mjs:ro" \
  --entrypoint node api /verify-jwt.mjs

rm -f .verify-jwt.mjs
```

This prints only the `kid` and a public-key fingerprint — never the private
key, never the full public PEM. Expect `sign -> verify round trip: OK`.

If either check fails, **do not** bring up `api`/`worker` — fix `.env` and
re-verify. An import failure here is the same failure `buildKeySet()` would
hit at container boot, just caught before the service restarts in a loop.

## Step 4 — bring the services up

```sh
docker compose --env-file .env --env-file .env.images up -d --remove-orphans
docker compose ps
```

(Only needed if `api`/`worker` were already running against the old
environment, or as part of the next scheduled deploy — `deploy.sh` reads the
same `.env` automatically.)

## Rotation

1. Generate a new key pair with a new `KID` (Steps 1–2), but **add its
   public half to the existing `AUTH_JWT_PUBLIC_KEYS` array — do not remove
   the old entry yet.** Redeploy/restart with the old `AUTH_JWT_KID` still
   signing; this is a verify-only change and every currently-live token
   still validates.
2. Once that's live, switch `AUTH_JWT_KID` to the new kid and remove (or
   leave, at least until the old access-token TTL has fully elapsed —
   `ACCESS_TOKEN_TTL_SECONDS`, ~15 minutes) the old private key material.
   Never remove a `kid` from `AUTH_JWT_PUBLIC_KEYS` while any token signed
   with it could still be unexpired: doing so turns every such token into a
   500 at the verifier, not a clean 401.
3. Keep old public entries in `AUTH_JWT_PUBLIC_KEYS` for at least one full
   access-token TTL past the switch, then remove them in a later, separate
   change.

## Notes

- This does not touch the database, `finsoft_refresh`, or any table — see
  [`RUNBOOK-finsoft-refresh-role.md`](RUNBOOK-finsoft-refresh-role.md) for
  that one-time step, which is unrelated but also blocks the same PR's
  staging deploy.
- No agent has, or should ever be given, the contents of `/opt/finsoft/.env`
  on any host. This runbook is written so a human can run it end to end
  without ever pasting a private key into a chat, a PR, or a CI log.
