# Autonomous Recovery Run — Execution Ledger

> This ledger lived on `docs/restore-recovery-planning-foundation`, which has
> since merged into `main` (see Package 1 below). It now lives at
> `plan/EXECUTION-STATUS.md` on `main` directly. All three packages below
> have since been reviewed (via the pr-review skill, multi-reviewer passes
> with independent empirical verification of every BLOCKER/CONCERN finding)
> and merged; see each package's "Review" note for what was found and fixed
> before merge.

- **Run prompt:** `plan/autonomous-recovery-prompt.md`
- **Execution plan:** `plan/feature-memory-recovery-1.md`
- **Baseline:** `683ba5011fb82d29196b1153ec8246902c889b24` (`origin/main`, PR #82)
- **Run started:** 2026-09-10
- **Run limits:** at most 6 bounded work packages or 3 hours

## Packages

### Package 1 — TASK-001/TASK-002 (Phase 0: docs reconciliation)

- **Status:** merged
- **Baseline/branch:** `683ba50` → `docs/restore-recovery-planning-foundation`
  (deleted after merge)
- **Commit:** `5b1030e` (plus `a451fdd`, `e00a0da` — maintainer-decision
  recording and a ledger staleness fix found during review)
- **PR:** https://github.com/cgkades/remem/pull/83 — **merged into `main`**
  (squash-merged 2026-09-16, CI green: Node 22/24, OpenCode v1/v2 E2E, Pi
  adapter/E2E, neural eval — all pass)
- **Review:** pr-review pass found one self-authored staleness issue (this
  ledger's own CI-pending prose for PR #85 was outdated) — fixed before
  merge. No other findings (docs-only diff; doc-claim-verification agent
  independently confirmed all schema-version/migration/publish-status
  claims against actual source).
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
- **Blocker/decision needed:** none. TASK-003 (applying the issue audit's
  proposed GitHub issue-body/state updates) is explicitly out of scope for
  this run (GitHub-administration task, not authorized) and is reported,
  not applied, in `docs/ISSUE-AUDIT.md`.
- **Next action:** none — merged.

### Package 2 — TASK-004/005/006 (Phase 1: short-continuity anchor fallback)

- **Status:** merged
- **Baseline/branch:** `683ba50` →
  `feature/phase1-short-continuity-anchor-fallback` (deleted after merge)
- **Commit:** `f760720` (plus `3f1761f` — pr-review fix-loop commit, see
  Review below)
- **PR:** https://github.com/cgkades/remem/pull/84 — **merged into `main`**
  (squash-merged 2026-09-16, CI green after fixes: Node 22/24, OpenCode
  v1/v2 E2E, Pi adapter/E2E, neural eval — all pass)
- **Review:** pr-review pass (code, data-structures/concurrency, security,
  TypeScript-idiom, test-quality reviewers) found real gaps, independently
  re-verified by direct execution (reverting `src/planner.ts` and re-running
  tests) rather than trusting reviewer claims:
  - 2 of the original 8 anchor tests passed unchanged against the pre-fix
    planner (didn't actually pin the claimed behavior); 2 more had weaker
    gaps (an unexercised exclusion list, a duplicate empty-catalog test).
    Fixed: rewrote the institutional-gate test as a true A/B toggle on one
    entry, added a genuinely discriminating provider-exclusion test, added
    a positive control for the exclusion list, replaced the duplicate test
    with a non-trivial-catalog case, and added a frequency-vs-order
    tie-break test. Re-verified: 6 of 11 anchor tests now genuinely fail
    without the fix (up from 3).
  - The new integration test couldn't distinguish "the anchor path worked"
    from "the orchestrator's independent semantic-recognition fallback
    happened to compensate" (semantic recognition always attempts when
    deterministic confidence < 0.82, and the anchor fallback's confidence
    is a fixed 0.62). Verified empirically (`recognitionStage:
"deterministic"`, signals include `"anchor-routed continuity
fallback"`) that the anchor path is genuinely responsible, and added
    assertions on both fields.
  - Fixed a dead tie-break branch in `selectContinuityAnchor` (correct
    output was an accident of loop iteration order, not of the written
    comparison) and merged a two-variable `anchor`/`anchorRoutedProviderIds`
    pair into one `Map<providerId, ContinuityAnchor>` (TypeScript reviewer
    WARN, same risk class as an earlier real issue in this file).
  - Not changed (accepted as intentional/out of scope): single-token query
    narrowing is TASK-005's approved design; shared 0.62 confidence between
    anchor and blind-fallback paths is a legitimate future refinement.
  - Security review: no injection risk (parameterized bind value, further
    restricted to `\p{L}\p{N}` by the tokenizer); confirmed institutional
    gating is applied before anchor candidacy in code, not just claimed.
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
- **Tests (after review fixes):** 11 unit tests in `tests/planner.test.ts`
  (up from 8 — see Review above) plus 1 PostgreSQL integration test in
  `tests/postgres-provider.integration.test.ts` reproducing TASK-004's exact
  short prompt (`Let's continue the Orion work.`) end-to-end through
  capture → promote → fresh provider/orchestrator/session, plus TASK-006's
  3 negative controls (foreign project, unrelated prompt, bare continuity
  phrase), now with recognition-stage/signal assertions pinning the code
  path.
- **Verification (post-fix):** `npm run lint` pass; `npm run typecheck`
  pass; `npm run build` pass; `npx prettier --check <changed files>` pass;
  `npm test` 324 passed / 41 skipped; `npm run test:postgres` 28 passed / 0
  skipped against a disposable, freshly-created, loopback-bound PostgreSQL
  container. Re-verified on integrated `main` after all 3 packages merged:
  326 passed / 41 skipped (unit), 28/28 (integration), tarball smoke pass.
- **Skips:** none unexpected. Full-suite `vitest run` with
  `REMEM_TEST_DATABASE_URL` set is flaky (multiple integration test files
  each run their own `DROP SCHEMA ... CASCADE` in `beforeAll`, and vitest
  runs files concurrently by default) — reproduced with and without this
  change; not a regression. Use the repo's own `npm run test:postgres`
  (single file) instead.
- **Blocker/decision needed:** none.
- **Next action:** none — merged.

### Package 3 — TASK-051/052 (Phase 15: `--version`/`-V` CLI flag)

- **Status:** merged
- **Baseline/branch:** `683ba50` → `feature/cli-version-flag` (deleted after
  merge)
- **Commit:** `efd5d77` (plus `a1af6c1` — pr-review fix-loop commit, see
  Review below)
- **PR:** https://github.com/cgkades/remem/pull/85 — **merged into `main`**
  (squash-merged 2026-09-16, CI green after fixes: Node 22/24, OpenCode
  v1/v2 E2E, Pi adapter/E2E, neural eval — all pass)
- **Review:** pr-review pass (code, security, TypeScript-idiom,
  test-quality, and a substituted CLI-contract reviewer) found a real bug,
  independently re-verified by direct execution:
  - `installedPackageVersion()`'s early-return sat outside `runCli`'s
    existing try/catch (4 of 5 reviewers independently flagged this), so a
    corrupted install (missing/malformed `package.json`) would surface as
    an unhandled promise rejection instead of the CLI's normal
    `Remem <command> failed: ...` + exit-1 convention. Verified by
    temporarily removing `"version"` from this repo's own `package.json`
    (immediately restored, confirmed via `git diff --stat` showing no
    changes) — confirmed the crash, then confirmed the fix. Fixed by
    wrapping the branch in its own try/catch and hoisting the shared
    output/errorOutput closures.
  - A test-quality BLOCKER claim ("test passes vacuously") was
    independently re-verified via two targeted mutations rather than
    trusted at face value: confirmed the test correctly fails when the
    guard is loosened from "sole argument" to "present anywhere in args"
    (the realistic regression), downgraded from BLOCKER to
    clarify-and-strengthen, and fixed a docstring that incorrectly claimed
    the test hit an "Unknown command" dispatch path (it actually hits
    `readAppConfig`'s ENOENT failure — verified directly).
  - Fixed an unchecked `as {version: string}` cast in the test fixture;
    removed a `stat(configDir)` assertion that passes/fails identically
    regardless of whether config access occurred; added
    `--version | -V (must be the only argument)` to `usage()` output.
  - Not changed (accepted as this bounded task's approved scope):
    `--version` combined with other args isn't honored/rejected the way
    git/npm/docker handle theirs — TASK-051 explicitly scoped
    single-argument-only.
  - Known, disclosed limitation: no permanent automated test for
    `installedPackageVersion()`'s own failure path (verified manually via
    direct execution instead, since a clean automated test would need
    either an unsafe live-mutation of the real `package.json` or a deeper
    path-injection refactor).
- **What it does:** `runCli` handles a single-argument `--version`/`-V`
  before any command-resolving argument parsing and before
  paths/runner/config/database/install-lock access. Version is read from
  `package.json` via `packageRoot(import.meta.url)` (same pattern as
  `doctor.ts`'s existing host-integration checks), never
  `process.cwd()`/a hardcoded duplicate. `--help` and all other
  command/flag parsing unchanged; `--version` combined with other
  arguments is not special-cased (see Review above for the accepted
  scope boundary).
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
- **Next action:** none — merged.

### Package 4 — TASK-007/008/009 (Phase 2: evidence admission contract)

- **Status:** merged
- **Baseline/branch:** merge of PRs #83/#84/#85 → `feature/phase2-evidence-admission`
  (deleted after merge)
- **Commit:** `9cfb9b4` (single commit; an earlier 2-commit split was
  squashed after GitHub push protection flagged secret-shaped test
  fixtures — see Review below)
- **PR:** https://github.com/cgkades/remem/pull/86 — **merged into `main`**
  (squash-merged 2026-09-16, CI green: Node 22/24, OpenCode v1/v2 E2E, Pi
  adapter/E2E, neural eval — all pass)
- **Review:** a 7-reviewer pr-review pass (code, data-structures/
  concurrency, security, threat-model, TypeScript-idiom, test-quality,
  architecture) found real, independently-verified issues before this PR
  was opened:
  - **BLOCKER/CRITICAL** (converged across 3 reviewers, each independently
    reproduced): the module's documented "never throws" contract was
    violated by null/malformed identity fields, a null context/payload, a
    non-array `evidenceRefs`, and a circular `payload.metadata`. Fixed via
    defensive `typeof`/`isPlainRecord`/`Array.isArray` guards throughout,
    a new `canonicalizePayload` (safe JSON round-trip, fails cleanly on
    circular/BigInt), and a catch-all wrapper (`admitEvidence` around the
    real `admitEvidenceUnsafe` logic). Verified with 9 new "never throws"
    tests.
  - **HIGH** (security reviewer): credential screening covered only
    `payload`, so a secret in `sessionId`/`turnId`/`messageId`/
    `evidenceRefs` bypassed screening entirely. Fixed by screening every
    identity-like field the same way.
  - **CONCERN** (data-structures reviewer): a `Map`/getter-based payload
    value could bypass the recursive credential scanner or create a
    TOCTOU gap between what was screened and what was persisted;
    `payload`/`metadata` key order wasn't sorted before hashing (risking
    a false `identity-collision` verdict for two logically-identical
    payloads). Fixed via `canonicalizePayload`'s single-snapshot,
    key-sorted approach, used uniformly for the byte-size check, the
    credential scan, the hash, and the persisted envelope.
  - **CONCERN** (architecture reviewer): a hand-rolled 32-bit FNV-1a-style
    hash had weak collision resistance for the duplicate-vs-collision
    decision, and the raw NUL-joined namespace string was being returned
    as the literal `id` — which would have broken a future PostgreSQL
    `text`-column write in Phase 3 (Postgres rejects embedded NUL bytes).
    Fixed by switching `id`/`contentHash` derivation to SHA-256 (via
    `node:crypto`, the same pattern `capture.ts`'s `stableId` already
    establishes).
  - **CONCERN** (code reviewer): `enabledOrigins: []` in config couldn't
    be expressed — it silently widened back to the default two origins.
    Fixed: `parseEvidenceOrigins` now distinguishes "not an array"
    (falls back to default) from "an array, even empty" (respected).
    Also added the missing config-wiring test coverage this reviewer
    flagged (6 new tests across `tests/config.test.ts`/
    `tests/storage-config.test.ts`).
  - **WARN** (TypeScript reviewer): a duplicated `EvidenceOrigin` literal
    list in `config.ts` risked silent drift from the canonical enum
    (fixed: exported canonical arrays from `observation-admission.ts`,
    reused in `config.ts`); an unsafe `stack.pop() as {...}` assertion
    discarded the compiler's own undefined-check (fixed: replaced with a
    direct loop check).
  - **Test-quality reviewer**: added direct tests that rejection `detail`
    strings never leak the triggering secret/oversized content
    (previously unverified despite the module's own claim), a byte-size
    symmetry check on the depth-bound test, a positive-direction
    `enabledOrigins`-widening test, and an `evidenceRefs.providerId`
    validation test (only `eventId` was previously covered).
  - **Not changed** (reviewed, reasoned, accepted): `EvidenceAdmissionConfig`'s
    type stays defined in `observation-admission.ts` rather than moving to
    `config.ts` to match `CaptureConfig`'s placement — a judgment call
    (it's the direct input contract of the one pure function that
    consumes it; no circular runtime dependency exists, verified). An
    origin's lack of cryptographic/provenance binding and
    `maxQueuedEvents` having no enforcement point in this module are both
    explicitly deferred to later phases per the module's own documented
    design (Phase 5 host-wiring and caller-owned queueing, respectively),
    not defects here.
  - **Push-protection note**: the first push attempt was rejected by
    GitHub secret scanning — test fixtures used realistic-looking secret
    formats (an AWS-access-key-shaped string, a Stripe-`sk_live_`-shaped
    string) to exercise `containsSensitiveCredential`. Replaced with a
    generic `api_key=<hex>` pattern that still triggers the same
    detector without matching a real provider's token format. Both
    commits were then squashed into one (this branch was never
    successfully pushed before the fix, so no shared history was
    rewritten).
- **What it does:** a new, additive, pure module
  (`src/observation-admission.ts`) defining the normalized evidence
  envelope, role/origin/kind enums, and `admitEvidence`/
  `summarizeRejections` pure functions per the approved Phase 2 contract;
  wired into `src/config.ts`/`src/storage/config-file.ts` config parsing.
  Does not persist anything, wire into any host adapter, or change any
  existing capture behavior/default. See the merged commit message for
  the full implementation breakdown.
- **Tests:** 59 tests in `tests/observation-admission.test.ts`, 6 in
  `tests/config.test.ts`, 1 in `tests/storage-config.test.ts` (66 new
  total).
- **Verification:** `npm run lint` pass; `npm run typecheck` pass;
  `npm run build` pass; `npx prettier --check <changed files>` pass;
  `npm test` 391 passed / 41 skipped (up from 326 pre-merge baseline,
  unchanged skip set). Re-verified on integrated `main` after merge:
  391 passed / 41 skipped (unit), `npm run test:postgres` 28/28
  (disposable container created/torn down for this verification only —
  this module itself performs no I/O), tarball smoke pass.
- **Skips:** none unexpected.
- **Blocker/decision needed:** none.
- **Next action:** none — merged. Phase 3 (episodic persistence) is now
  `DEPENDENT`-but-unblocked on this landing; its own retention-policy
  values remain separately review-gated before implementation.

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
TASK-007/008/009. It does **not** pre-approve Phase 4's transaction
contract, Phase 5's host-verification contract, Phase 6's remaining
broader-rule thresholds beyond decision 3, Phase 7, Phase 10, or Phase 11 —
those remain separately gated and still need their own maintainer decision
before implementation. Phase 3's retention-policy values are resolved
separately below (2026-09-16).

### Phase 3 decision — RESOLVED 2026-09-16

The maintainer reviewed and approved Phase 3's retention/capacity policy in
a second decision conversation on 2026-09-16, replacing the plan's original
age-based retention proposal entirely. Full text is recorded in
`plan/feature-memory-recovery-1.md` §1 as decision 6 under "Maintainer
Decisions (2026-09-10, amended 2026-09-16)", and inlined into Phase 3.
Summary:

- **No age-based deletion of any kind.** Retention is governed entirely by
  size pressure, in two configurable tiers per provider/project.
- **Soft limit (default 1 GiB logical bytes, new TASK-060):** makes 60+-day
  entries eligible for _compaction_ (shrinking, not deleting) — heavy
  reduction of bulk artifacts (tool output, stack traces, long logs),
  minimal reduction of reasoning/narrative text. Compaction starts
  conservative; its aggressiveness may only escalate in response to
  sustained soft-to-hard gap closure, never silently, and the current level
  must be visible via `doctor`/`status`. A user-triggered forced full
  compaction (ignoring the 60-day gate) is also required.
- **Hard limit (default 2 GiB logical bytes, part of the revised TASK-012):**
  the only point where anything is actually _removed_, oldest-eligible-first,
  and only after compaction has already run. Explicit privacy deletion
  (TASK-013) still overrides both tiers immediately.
- **Bulk artifacts are never persisted raw in the first place (new
  TASK-059):** tool-output-shaped payloads (stack traces, long logs) get a
  deterministic extraction (key error/exception lines + bounded head/tail)
  applied before storage, independent of the 60-day compaction gate; an
  LLM-based summarizer is an optional upgrade to that step, never required.
  This is intentionally narrower than "never lose detail" — if truly raw
  output is needed later, the operator's own host-level logging (e.g.
  OpenCode's own log configuration) remains the system of record for that,
  not ReMem's episodic store.
- **Supersession review is AI-suggested, human-confirmed only (new
  TASK-061):** candidates are generated deterministically from decision 4's
  entity/relationship links (not a free-roaming AI scan of all history); an
  optional AI-assisted step may summarize _why_ a candidate looks
  superseded; every suggestion requires explicit human confirmation via
  TASK-013's forget path before anything is removed. Fully automatic
  deletion is explicitly rejected for now — the maintainer intends to trial
  the manually-confirmed workflow first and revisit automation later based
  on real usage.
- **Session-start hard-limit capacity warning only (new TASK-062):** when a
  provider/project is at/near the **hard** limit only (never the soft
  limit) at session start, inject one bounded, body-free notice (byte
  count/limit only, no content) into the same attributed context-injection
  channel Session A/Session B recall already uses, rather than requiring a
  manually-run `status`/`doctor` command. The exact per-session-vs-throttled
  firing cadence is still an open implementation question the maintainer
  flagged for resolution at TASK-062 implementation time, not decided here.

This resolves Phase 3's retention-policy REVIEW-GATED status (now READY in
`plan/feature-memory-recovery-1.md` §1's readiness table) and unblocks
TASK-010/011/012/059/060/061/062. It does not change TASK-013's own
existing review-gated status (explicit forget preview/confirmation)
independent of this decision.

## Not started this run (blocked/deferred, per readiness table)

Per `plan/feature-memory-recovery-1.md` §1's readiness table, every
remaining phase (other than Phase 2, resolved above, and Phase 3, also
resolved above) is one of:

- **REVIEW-GATED** (4, 5, 6 remaining thresholds, 7, 10, 11): requires
  maintainer approval of a concrete contract/patch (managed-
  transaction/association-ledger schema; host-callback verification
  contract; any fact-promotion rule broader than the approved boundary;
  consolidation mutation authority; full-loop default-rollout gate;
  embedding identity schema) _before_ implementation.
- **DEPENDENT** on a REVIEW-GATED phase (8 on 1,7; 9 on 3,4,7): cannot
  fully land until the review-gated prerequisite lands, though isolated
  pieces (e.g. TASK-057's `search()` extension) may be draftable once
  their narrower prerequisite (TASK-055) exists.
- **DEFERRED** (12, 13, 14; and 15's TASK-053/054, which are explicitly
  "after phase 10"): not authorized to start per the plan and per the run
  prompt's Work Selection rule.

## Next eligible package

**TASK-007/008/009 (Phase 2) are done** — implemented, reviewed, and merged
as Package 4 (PR #86). See "Recommended next task" below for what's next.

## Work still uncommitted

None. All three packages are merged into `main` (PRs #83, #84, #85). Their
feature/coordination branches were deleted after merge. `docs/code-review/`
remains untouched and untracked, as instructed (unrelated to this run) —
this now also includes a new review artifact
(`docs/code-review/2026-09-16-pr-84-anchor-continuity-review.md`) written
by a security-reviewer subagent during the pr-review pass on PR #84;
consistent with the pre-existing file in that directory, it has never been
committed in this repo's history and is left as local-only reviewer output.

## Disposable test database

Three disposable, loopback-bound PostgreSQL containers were created and
torn down across this run's three sessions, each via the repo's own
`compose.test.yaml` (`docker compose -f compose.test.yaml up --detach
--wait`), producing container `remem-test-postgres-1` on
`127.0.0.1:54330` with a fresh ephemeral named volume each time. Each was
torn down via `npm run test:postgres:down` (removes volumes) at the end
of its respective session. An unrelated, already-exited container named
`remem-test-postgres` (no `-1` suffix, port 15432) predated this run and
was left untouched throughout all three sessions.

## Remaining risks

- The full `vitest run` suite is flaky when `REMEM_TEST_DATABASE_URL` is
  set, due to concurrent integration-test files each dropping/recreating
  the shared `remem` schema (pre-existing; not introduced by this run).
  Use `npm run test:postgres` (single file) instead, as this ledger and the
  repo's own script both do.
- All findings from the pr-review passes on PRs #84 and #85 that were
  accepted as out-of-scope/intentional (see each package's Review note
  above) remain as-is: the anchor fallback's single-token query narrowing
  and shared 0.62 confidence value; the `--version` flag's
  not-honored-when-combined-with-other-args behavior; and
  `installedPackageVersion()`'s failure path lacking a permanent automated
  test (verified manually instead). None of these were rated
  BLOCKER/CRITICAL by any reviewer, and each is documented with its
  rationale in the corresponding PR's merged commit message.
- Final integrated verification on `main` after all 3 merges: `npm test`
  326 passed / 41 skipped, `npm run test:postgres` 28/28, `npm run
pack:smoke` exit 0, lint/typecheck/build/prettier all clean.

## Recommended next task

TASK-007/008/009 (Phase 2) are **done** (Package 4, merged — see above).
The Phase 3 retention/capacity policy decision is also **done** (see
"Phase 3 decision — RESOLVED 2026-09-16" above).

**Phase 3 (episodic persistence: TASK-010, 011, 012, 013, 059, 060, 061, 062) is now the fully-unblocked next package**, per the revised policy:
two size tiers (1 GiB soft/compaction, 2 GiB hard/eviction, both
configurable, no age-based deletion), deterministic bulk-artifact
reduction before persistence, entity-linked human-confirmed supersession
review, and a hard-limit-only session-start capacity notice. TASK-013
(explicit forget preview/confirmation) remains its own review-gated item
per the plan's exit criterion for this phase, independent of this
decision, but TASK-061's supersession review is designed to depend on
TASK-013's forget path once it lands, not to duplicate it.

Suggested implementation order within Phase 3: TASK-010 (storage) and
TASK-011 (search) first, since nothing else in this phase can be
exercised without them; TASK-059 (bulk-artifact reduction) next, since
TASK-060's compaction policy is easier to reason about once raw bulk
content is already bounded at the door; then TASK-012 (soft/hard capacity
accounting) and TASK-060 (compaction) together, since they share the same
size-accounting mechanism; TASK-062 (session-start warning) once TASK-012
gives it something real to check; TASK-013 and TASK-061 last, since
TASK-061 depends on TASK-013's confirmation path.
