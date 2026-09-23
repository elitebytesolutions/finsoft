# Wave 0 — foundation ADR reconciliation, the outbox, and the dispatcher

**Branch:** `feature/FND-017-web-lint-cleanup` → `develop`
**Head:** `0b84ff4`

Paste this as the pull request description. It carries the evidence two guardians made a condition of merging.

---

## Do not merge until these are true

| | |
|---|---|
| ☐ | **Product Owner signature** on ADR-0013, ADR-0014, ADR-0016 and ADR-0019. Each has its own Signatures block; each is still `Proposed`. |
| ☐ | **ADR-0019 Accepted and ADR-0010 flipped to Superseded, in the same change.** Database Guardian condition **C2**: `004_create_outbox.sql` already cites that supersession in the present tense, so the migration is ahead of the record it names. |
| ☐ | GAP-001, the reconciliation deferrals D1–D9, and the `fast-check` decision — separate sign-offs, not covered by the ADR signatures. |

Two guardian signatures are already recorded, both after refusals. Neither may be entered on anyone else's behalf.

---

## What is in it

**28 commits.** Three strands:

1. **Foundation ADR reconciliation** — every claim in ADR-0013, 0014 and 0016 checked against what the repository enforces. Mechanisms built where the claim was right and the mechanism missing; wording corrected where the mechanism was narrower than the words; deferrals recorded as debt with reasons.
2. **The outbox** — `004_create_outbox.sql` with the lease fence, the transition graph, two attempt budgets, replay integrity and column-scoped grants. ADR-0019 supersedes ADR-0010 with four corrected claims.
3. **The dispatcher** — FND-011's outstanding item, with all six required failure paths demonstrated.

## The findings worth reading

**A boundary rule was inert for the second time, through the review that found the first one.** `options.exclude` listed `node_modules` alongside `doNotFollow`, so every `^node_modules/` rule matched nothing. After that was fixed, `dist` was still in the same pattern, unanchored, and `node_modules/kysely/dist/index.js` matched it — six files import `kysely` and the graph held zero `kysely` edges, while CI reported clean every day.

The fix was applied to the token the first time and to the mechanism the second: an `exclude` pattern written for *our* build output will also match a *dependency's published directory*, because that is what publishing looks like.

Neither occurrence was caught by anyone reading the config. Both were caught by asking what the rule had ever matched. That question is now `npm run verify:controls`, which removes a mechanism, runs one test file, asserts a **named** test fails, and restores the file. **10/10.**

**A migration claimed a protection it did not have.** A comment on `outbox_dispatched_at_matches_status` said it forbade resetting a `DONE` row to `PENDING` for replay. It did not — `SET status='PENDING', dispatched_at=NULL` satisfies `(false) = (false)`, `GRANT UPDATE` put it in reach of application code, and ADR-0010 actively instructed someone to do it. What forbids it now is a trigger.

**Replacing that reset without changing the deduplication key would have been worse than the bug.** ADR-0010 keyed consumer dedup on `outbox.id`. A replay is a new row with a fresh id, so it would sail straight past a dedup table keyed on it — turning replay from an audit-destroying operation into a **silent double-send**. The key is now `(tenant_id, topic, effect_key)`, and `outbox_enforce_replay()` refuses a replay that mints a fresh one.

**A rule 20 leak in the connection pool.** `describeTarget` was already safe, but a `pg` connection failure puts the DSN it tried — password included — into its *message*, which is neither a denied key nor a token shape. It reached stdout unredacted.

**Two claims in code contradicted the ADRs governing them.** `verify.ts` still asserted the retracted CHECKSUMS claim, and `assertExactNumericParsing` claimed to catch a per-`Pool` `types` option when it reads the module-global parser — the one function standing between a JS float and a money column.

**Three findings were withdrawn after measurement, two of them mine.** A `zod` resolution defect did not reproduce; I recorded it as a required fix on a reviewer's word without measuring, then repeated the misattribution in ADR-0013's history after it had been withdrawn. Both are corrected, and the config change made on the theory is reverted. Config added on a theory that measurement contradicts is how a file accumulates settings nobody can justify.

---

## Evidence

### Staging ledger — 004 has never been released

Database Guardian condition **C3**. Taken from the staging cluster at the time of writing:

```
 version |              filename              |   checksum   |          applied_at
---------+------------------------------------+--------------+-------------------------------
       1 | 001_create_tenants.sql             | f393cfbd467d | 2026-09-23 00:52:12.667913+00
       2 | 002_create_users.sql               | 43c3d7b21b7e | 2026-09-23 00:52:12.711585+00
       3 | 003_restrict_schema_migrations.sql | 6590b31835da | 2026-09-23 00:52:12.73875+00
(3 rows)
```

`004` is absent. `main`, `develop` and both origins are at `7a298ce`, the initial commit. This is what the once-only amendment disposition rests on, and it **expires the moment this merges**.

### The claim query's plan, at scale

`npm run db:outbox-plan`, against **1,002,062 rows across 65 tenants** with a small PENDING working set:

```
Limit  (cost=0.29..205.35 rows=50 width=30) (actual time=0.029..0.040 rows=20 loops=1)
  Buffers: shared hit=21 read=3 dirtied=2
  ->  LockRows  (cost=0.29..238.16 rows=58 width=30) (actual time=0.029..0.039 rows=20 loops=1)
        Buffers: shared hit=21 read=3 dirtied=2
        ->  Index Scan using outbox_pending_idx on outbox  (cost=0.29..237.58 rows=58 width=30) (actual time=0.022..0.028 rows=20 loops=1)
              Index Cond: ((tenant_id = (current_setting('app.tenant_id'::text))::uuid) AND (available_at <= now()))
              Filter: (status = 'PENDING'::text)
              Buffers: shared hit=1 read=3
Planning Time: 0.788 ms
Execution Time: 0.118 ms
```

The RLS predicate is the **leading index condition**, not a filter above the scan — which is what `current_setting` being `STABLE` buys. There is **no Sort node**, which is what justifies the index's third column: `(tenant_id, available_at, id)` supplies `ORDER BY available_at, id` directly.

A plan reviewed against ten rows would have shown a sequential scan and proved nothing.

### Gate

```
typecheck · eslint · format:check · depcruise (307 modules, 686 deps, clean)
db:migrate:verify (4 migrations, sequential, checksums match, forward-only)
659 tests across 34 files
verify:controls  10/10 controls proved to fail when their mechanism is removed
```

---

## Reviewing this

Start with `docs/adr/RECONCILIATION-2026-09.md`. It indexes every finding in three buckets — required fix, inaccurate claim, deferral — with the evidence for each, and records what was withdrawn.

Then `docs/adr/ADR-0019-transactional-outbox.md`, whose summary table states the four corrections in one place before arguing the two that change the delivery contract.

`004_create_outbox.sql` is long, and most of it is reasoning rather than DDL. Its revision history records all seven prior committed versions with SHAs and checksums, both guardian dispositions, and the four conditions attached to the last one.

---

## Known limitations, stated rather than discovered

- **A failing check cannot block this merge.** Branch protection is unavailable for a private repository on this plan (HTTP 403) — [GAP-001](COMPLIANCE_GAPS.md). Every gate runs and reports; nothing enforces the result. The compensating controls are listed there and none of them is equivalent.
- **Nine of seventeen depcruise rules are proved to fire.** ADR-0013 names the eight that are not.
- **`RAISE EXCEPTION` text is caught by no gate.** `COMMENT ON` text reaches `pg_description` and the new codegen check; `pg_proc.prosrc` reaches nothing, and no test asserts the message fragments. Database Guardian condition **C4**.
- **The consumer registry is empty**, deliberately: a consumer lands with the code that raises its topic, and nothing can post a sale until Wave 5.
- **FND-012's reconciliation suite does not exist.** "One test of each kind" is an FND-015 acceptance criterion and reconciliation has none.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
