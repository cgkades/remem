# Autonomous Recovery Run — Execution Ledger

> Coordination/documentation branch for this run:
> `docs/restore-recovery-planning-foundation`. Other worktrees/branches for
> this run must not independently rewrite this file; append/update it here
> and merge forward.

- **Run prompt:** `plan/autonomous-recovery-prompt.md`
- **Execution plan:** `plan/feature-memory-recovery-1.md`
- **Baseline:** `683ba5011fb82d29196b1153ec8246902c889b24` (`origin/main`, PR #82)
- **Run started:** 2026-09-10
- **Run limits:** at most 6 bounded work packages or 3 hours

## Packages

### Package 1 — TASK-001/TASK-002 (Phase 0: docs reconciliation)

- **Status:** draft-awaiting-review
- **Baseline/branch:** `683ba50` → `docs/restore-recovery-planning-foundation`
- **Commit:** `5b1030e`
- **PR:** https://github.com/cgkades/remem/pull/83 (draft, CI green: Node 22/24,
  OpenCode v1/v2 E2E, Pi adapter/E2E, neural eval — all pass)
- **What it does:** preserves the prior planning session's intended artifacts
  (`plan/feature-memory-recovery-1.md`, `plan/autonomous-recovery-prompt.md`,
  `docs/ISSUE-AUDIT.md`, `README.md`, `docs/IMPLEMENTATION-PLAN.md`) and
  corrects stale "schema version 4"/"not published to npm" claims across
  `docs/architecture.md`, `docs/mvp.md`, `docs/future-roadmap.md`,
  `docs/memory-model.md`, `docs/storage-architecture.md`,
  `docs/installation.md`, `docs/configuration.md`, `docs/backup-restore.md`,
  `docs/evaluation.md`. Actual current schema version is 7
  (`migrations/0001`-`0007`), verified against
  `tests/postgres-provider.integration.test.ts`'s upgrade assertion
  (`applied: [2,3,4,5,6,7], currentVersion: 7`) and
  `src/storage/migrations.ts` `migrationStatus()` (read-only).
- **Verification:** `npm run lint` pass; `npm run typecheck` pass;
  `npx prettier --check <changed files>` pass. Docs-only diff; `npm test`/
  `npm run build` not re-run for this PR (no source changed). CI ran the
  full matrix anyway and is green.
- **Skips:** none.
- **Blocker/decision needed:** none to implement this PR. TASK-003
  (applying the issue audit's proposed GitHub issue-body/state updates) is
  explicitly out of scope for this run (GitHub-administration task, not
  authorized) and is reported, not applied, in `docs/ISSUE-AUDIT.md`.
- **Next action:** maintainer review/merge. No further work queued on this
  branch.

### Package 2 — TASK-004/005/006 (Phase 1: short-continuity anchor fallback)

- **Status:** draft-awaiting-review
- **Baseline/branch:** `683ba50` → `feature/phase1-short-continuity-anchor-fallback`
- **Commit:** `f760720`
- **PR:** https://github.com/cgkades/remem/pull/84 (draft, targets `main`
  independently of PR #83; CI green: Node 22/24, OpenCode v1/v2 E2E, Pi
  adapter/E2E, neural eval — all pass)
- **What it does:** `DeterministicRetrievalPlanner.plan`'s existing
  continuity/no-qualified-match fallback derives one bounded "anchor" token
  from the prompt (>=3 chars, excluded-token-list-filtered) that also names
  an eligible (non-institutionally-blocked) catalog entry's title/alias;
  routes only to providers owning an anchor-matched entry, using the anchor
  itself (not the full prompt) as the literal parameterized query. Ties in
  catalog document frequency break by earliest prompt-token order. With no
  anchor, or no available provider for the matched anchor, the pre-existing
  full-prompt/all-available-providers fallback is unchanged.
  `minimumConfidence`, scoring, and non-continuity behavior are untouched.
- **Tests added:** 8 unit tests in `tests/planner.test.ts` (anchor
  routing+query substitution, provider-availability restriction,
  institutional-gate exclusion, document-frequency tie-break,
  case/punctuation normalization, no-anchor fallback preserved, bare
  "continue the work" no-route, qualified-match behavior unchanged). 1
  PostgreSQL integration test in `tests/postgres-provider.integration.test.ts`
  reproducing TASK-004's exact short prompt
  (`Let's continue the Orion work.`) end-to-end through capture → promote
  → fresh provider/orchestrator/session, plus TASK-006's 3 negative
  controls (foreign project, unrelated prompt, bare continuity phrase).
- **Verification:** `npm run lint` pass; `npm run typecheck` pass;
  `npm run build` pass; `npx prettier --check <changed files>` pass;
  `npm test` 321 passed / 41 skipped (unchanged skip set — no
  `REMEM_TEST_DATABASE_URL` for that run); `npm run test:postgres` 28
  passed / 0 skipped against a disposable, freshly-created, loopback-bound
  PostgreSQL container (`compose.test.yaml`, container
  `remem-test-postgres-1`, `127.0.0.1:54330`, ephemeral named volume). Red
  state confirmed by temporarily reverting `src/planner.ts` alone and
  re-running the new integration test: `resultCount: 0`, empty
  `memoryText` (recorded in the PR body, not shipped as a separate commit).
- **Skips:** none unexpected. Full-suite `vitest run` with
  `REMEM_TEST_DATABASE_URL` set is flaky (multiple integration test files
  each run their own `DROP SCHEMA ... CASCADE` in `beforeAll`, and vitest
  runs files concurrently by default) — reproduced with and without this
  change; not a regression. Use the repo's own `npm run test:postgres`
  (single file) instead, as done here.
- **Blocker/decision needed:** none to implement this PR.
- **Next action:** maintainer review/merge.

### Package 3 — TASK-051/052 (Phase 15: `--version`/`-V` CLI flag)

- **Status:** draft-awaiting-review
- **Baseline/branch:** `683ba50` → `feature/cli-version-flag`
- **Commit:** `efd5d77`
- **PR:** https://github.com/cgkades/remem/pull/85 (draft, targets `main`
  independently; CI: all jobs pass — Node 22/24, OpenCode v1/v2 E2E, Pi
  adapter/E2E, neural eval — confirmed green later in the same session)
- **What it does:** `runCli` handles a single-argument `--version`/`-V`
  before any command-resolving argument parsing and before
  paths/runner/config/database/install-lock access. Version is read from
  `package.json` via `packageRoot(import.meta.url)` (same pattern as
  `doctor.ts`'s existing host-integration checks), never
  `process.cwd()`/a hardcoded duplicate. `--help` and all other
  command/flag parsing unchanged; `--version` combined with other
  arguments is not special-cased.
- **Tests added:** 2 unit tests in `tests/cli-provisioning.test.ts`
  (pre-initialization: fresh temp paths with no written app config, a
  `runner.run()` that throws if invoked, asserts exit 0/exact
  version/no stderr/`paths.configDir` never created; and a
  not-special-cased-with-extra-args case). 2 assertions added to
  `scripts/package-smoke.mjs` running `--version`/`-V` against the
  **installed npm-packed tarball** binary from its existing temp
  "application" directory outside the repository, with no `remem` config,
  comparing stdout exactly against `package.json`'s version.
- **Verification:** `npm run lint` pass; `npm run typecheck` pass;
  `npm run build` pass; `npx prettier --check <changed files>` pass;
  `npm test` 315 passed / 40 skipped (unchanged skip set); `npm run
pack:smoke` pass (exit 0; `--help`, `--version`, `-V`, subpath exports,
  and a consumer `tsc` typecheck all succeed). Database tests not
  applicable (no schema/provider changes).
- **Skips:** none unexpected.
- **Blocker/decision needed:** none.
- **Next action:** maintainer review/merge.

## Not started this run (blocked/deferred, per readiness table)

Per `plan/feature-memory-recovery-1.md` §1's readiness table, every
remaining phase is one of:

- **REVIEW-GATED** (2, 4, 5, 6, 7, 10, 11): requires maintainer approval of
  a concrete contract/patch (observation/admission envelope and identity
  rules; managed-transaction/association-ledger schema; host-callback
  verification contract; four-outcome learning policy; consolidation
  mutation authority; full-loop default-rollout gate; embedding identity
  schema) _before_ implementation, per the plan's explicit gates (e.g.
  "Maintainer approval of these proposed values is part of TASK-007; do
  not present them as today's defaults").
- **DEPENDENT** on a REVIEW-GATED phase (3 on 2; 8 on 1,7; 9 on 3,4,7):
  cannot start until the review-gated prerequisite lands.
- **DEFERRED** (12, 13, 14; and 15's TASK-053/054, which are explicitly
  "after phase 10"): not authorized to start per the plan and per this
  run's Work Selection rule ("Do not use a blocker as permission to start
  deferred reranking, Pi UI, sync, or enterprise work").

Per the run prompt's Work Selection section, TASK-051/052 (Package 3
above) was exactly the one authorized independent package available once
Phase 0/1 (Packages 1-2) were complete and Phase 2+ was confirmed
review-gated. **No further code-eligible, non-review-gated package
remains for this run.** This is consistent with the prompt's stated
expectation of "a small review queue, not unattended completion of all 54
tasks."

### Phase 2 decision — RESOLVED 2026-09-10

The maintainer reviewed and approved the concrete Phase 2 contract in a
decision conversation on 2026-09-10. Full text is now recorded in
`plan/feature-memory-recovery-1.md` §1 under "Maintainer Decisions
(2026-09-10)", and inlined into the Phase 2/6/8/9 sections. Summary:

1. **Evidence recording scope (Phase 2, TASK-007):** record all raw
   evidence from the start once configured — both `direct-user` and
   host-observed `assistant`/`tool` origins together, not a separately
   gated toggle. Recording evidence is not the same as promoting it to a
   fact (that is decision 3, Phase 6). Other TASK-007 development-profile
   values (disabled until configured; project scope only; 8 KiB/16
   references/32 queued events; unknown origins cannot auto-promote) are
   approved as originally proposed.
2. **Missing-identity handling (Phase 2, TASK-007/TASK-008):** confirmed —
   skip storing the event's content, do not deduplicate by guessed
   identity — plus a new requirement: log the rejection as a bounded
   diagnostic (reason code and count only, never content).
3. **Fact-promotion boundary (Phase 6, TASK-022 and new TASK-056):** a
   host-verified action with an observable outcome may promote to a
   _generalized_ fact (not raw output, not an added unverified causal
   claim) if not corrected. An unverified explanation/causal claim, or AI
   output responding to something that needed the user's input, stays
   episodic-only if the user just moves on — "moved on" is never
   sufficient by itself for that class. Promotion for that class requires
   either the existing explicit-user-confirmation capture path (a short
   "ok, do it" counts — it is an explicit statement, not silence) or
   independent verification. Corrections always supersede via the
   existing correction workflow.
4. **Entity/relationship linking (Phase 6/8, new TASK-055/TASK-057):** the
   schema (`remem.entities`/`remem.memory_entities`/`remem.relationships`)
   and types (`MemoryEntity`/`MemoryRelationship` on `MemoryWrite`) already
   exist and are already returned by point-reads (`BASE_SELECT` in
   `src/providers/postgres.ts`); extraction should start populating them
   and `search()`/synthesis should start surfacing them — this is not a
   new schema design problem.
5. **Bounded temporal/episode recall (Phase 9, new TASK-058):** a new,
   explicitly user-triggered recall mode, structured like Phase 1's
   continuity-anchor trigger. Start with a **fixed, bounded phrase list**
   (`today`, `yesterday`, `this morning`, `this afternoon`, `last night`,
   `last week`, `last <weekday>`) for calendar-relative queries, plus a
   separate entity-scoped trigger ("what else did we do while fixing
   this/that") that reuses the Phase 1 anchor match and decision 4's
   relationship links. Open-ended date parsing is explicitly deferred.

This resolves Phase 2's REVIEW-GATED status (now READY in
`plan/feature-memory-recovery-1.md` §1's readiness table) and unblocks
TASK-007/008/009. It does **not** pre-approve Phase 3's retention-policy
values, Phase 4's transaction contract, Phase 5's host-verification
contract, Phase 6's remaining broader-rule thresholds beyond decision 3,
Phase 7, Phase 10, or Phase 11 — those remain separately gated and still
need their own maintainer decision before implementation.

## Not started this run (blocked/deferred, per readiness table)

Per `plan/feature-memory-recovery-1.md` §1's readiness table, every
remaining phase (other than Phase 2, resolved above) is one of:

- **REVIEW-GATED** (4, 5, 6 remaining thresholds, 7, 10, 11): requires
  maintainer approval of a concrete contract/patch (managed-
  transaction/association-ledger schema; host-callback verification
  contract; any fact-promotion rule broader than the approved boundary;
  consolidation mutation authority; full-loop default-rollout gate;
  embedding identity schema) _before_ implementation.
- **DEPENDENT** on a REVIEW-GATED phase (3 on 2 — now READY, so 3 is
  DEPENDENT-but-unblocked once Phase 2 lands, though its own retention
  values in §3 remain separately gated; 8 on 1,7; 9 on 3,4,7): cannot fully
  land until the review-gated prerequisite lands, though isolated pieces
  (e.g. TASK-057's `search()` extension) may be draftable once their
  narrower prerequisite (TASK-055) exists.
- **DEFERRED** (12, 13, 14; and 15's TASK-053/054, which are explicitly
  "after phase 10"): not authorized to start per the plan and per the run
  prompt's Work Selection rule.

## Next eligible package

**TASK-007/008/009 (Phase 2) are now eligible** — the contract is approved
above. TASK-007 is now largely a matter of encoding the approved contract
into the actual `SessionObservation`/admission types; TASK-008/009 are
pure functions (no host SDK/database imports) and can be implemented and
tested in isolation. This is the recommended next package for a future
run/session.

## Work still uncommitted

None. All completed edits for this run are committed on the three branches
above and pushed to `origin`. `docs/code-review/` remains untouched and
untracked, as instructed (unrelated to this run).

## Disposable test database

A disposable, loopback-bound PostgreSQL container was created for this
run's `npm run test:postgres` verification via the repo's own
`compose.test.yaml` (`docker compose -f compose.test.yaml up --detach
--wait`), producing container `remem-test-postgres-1` on
`127.0.0.1:54330` with an ephemeral named volume
(`remem-test_remem-test-postgres-data`). An unrelated, already-exited
container named `remem-test-postgres` (no `-1` suffix, port 15432) predated
this run and was left untouched throughout. The disposable container is
torn down via `npm run test:postgres:down` at the end of this run (removes
its volumes; does not touch the unrelated pre-existing container).

## Remaining risks

- The full `vitest run` suite is flaky when `REMEM_TEST_DATABASE_URL` is
  set, due to concurrent integration-test files each dropping/recreating
  the shared `remem` schema (pre-existing; not introduced by this run).
  Anyone re-verifying Package 2 should use `npm run test:postgres`
  (single file), matching this ledger and the repo's own script, not a
  bare `vitest run` with the database URL set.
- None of the three PRs have been merged; they are independent (not
  stacked) and can merge in any order — there is no cross-PR dependency
  among Packages 1-3.

## Recommended next task

TASK-007/008/009 (Phase 2), per the approved contract recorded above and
in `plan/feature-memory-recovery-1.md`. See "Next eligible package" above
for detail.
