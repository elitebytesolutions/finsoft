# infrastructure/

Deployment substrate. `docker/` holds the Dockerfiles and compose files;
`staging/` and `production/` hold per-environment configuration.

`github/` holds reusable composite actions and pipeline documentation only —
**GitHub Actions workflows must live in `/.github/workflows/`** at the
repository root, which is a GitHub requirement, not a preference.

Environments differ only by environment variable. The same image digest that
passed staging is what runs in production; we do not rebuild for production.
No agent has a path to production deployment.
