# Autonomous ReMem Recovery Run

This is a dormant run prompt, not standing repository authority. Execute it only when the user explicitly adopts it and grants the permissions below. Higher-priority system, developer, host, and tool-permission rules still apply.

## Mission

Make as much verified progress as possible on `plan/feature-memory-recovery-1.md` without asking the user routine questions. Optimize for correct, reviewable changes, not the number of boxes checked. Implement code where authorized; do not spend the whole run producing another roadmap.

Use the issue audit and execution plan already present. Do not repeat the 48-issue audit or reconstruct this project's history from scratch.

## Required User Authorization

The user's launch message must authorize repository-local implementation, isolated testing, feature branches/worktrees, commits of intended files, pushes to this repository's remote, and draft PR creation. If a permission was not granted, record that limitation rather than assuming it. Tool approval prompts cannot be overridden by this file.

Even with that authorization, do not merge PRs, push directly to main, force-push, amend existing commits, publish packages, deploy, change installed user/agent configuration, enable new capture defaults, modify unrelated repositories, or change GitHub issue bodies/states. Do not touch user/production databases or delete pre-existing data. Never bypass a denied tool operation through another tool or transport.

Do not make additional paid model/service calls beyond the configured coding model and any explicitly permitted focused reviewer. Existing local/mock-model tests and public dependency/model-asset downloads required by repository tests are allowed; sending real memory or user transcripts to a new service is not.

## Run Limits

- Work sequentially on at most six bounded work packages or for three hours, whichever comes first. Stop cleanly sooner if the client budget/session limit is reached.
- Use one primary agent. Do not launch a council, broad agent fan-out, or recursive research. For a persistence/security package, at most one focused read-only verifier may independently challenge the completed diff.
- After three unsuccessful fix-and-test cycles for the same failure, mark the package blocked, preserve evidence, and move to an independent eligible task. Do not endlessly rephrase the same search or rerun an unchanged failing command.
- A prompt cannot enforce a dollar cap. Honor any actual provider/client spending limit; never bypass it or automatically switch to a more expensive model.
- Before starting another package, leave enough time to validate, checkpoint, and report the current one. Do not leave an undisclosed half-finished mutation.

## Startup

1. Inspect git status, branch, remotes, existing PRs, and repository instructions. Never reset, discard, or stash another person's work.
2. Read this prompt, the execution plan's requirements/readiness table, and any existing `plan/EXECUTION-STATUS.md`. Read the product vision/target architecture once as needed for their invariants, then only the selected phase and named source sites. Use required project memory/navigation tools without repeating broad discovery for every task.
3. Reconcile prior status with actual commits, PR heads, current source, and test evidence. A prior agent's claim is not proof that code was committed, pushed, or merged.
4. The previous planning session may have left these intended artifacts uncommitted: `README.md`, `docs/IMPLEMENTATION-PLAN.md`, `docs/ISSUE-AUDIT.md`, `plan/feature-memory-recovery-1.md`, and this prompt. If still present, inspect their diffs/content, preserve them, and include only those intended planning changes in a dedicated documentation branch/commit. Do not recreate or overwrite them from memory. Never use `git add .`.
5. The existing `docs/code-review/` directory is unrelated to this run. Leave it untouched and unstaged. Preserve all other unrelated changes too; use an isolated worktree if necessary. If unknown changes overlap the selected task, record a conflict and skip it rather than overwrite them.
6. Fetch the current remote base without discarding local work. Create or reuse task-specific feature branches. No implementation occurs directly on main.

## Work Selection

Start with the technical documentation tasks TASK-001/TASK-002, then implement TASK-004 through TASK-006 as one short-continuity behavior package. TASK-003 is a GitHub-administration task and is not authorized by this prompt; skip it without blocking code work.

After that, select the highest-priority eligible package in dependency order. Prefer core observation/learning work to optional integrations. If core work is review-blocked, TASK-051/TASK-052 are an independent version-flag package. Do not use a blocker as permission to start deferred reranking, Pi UI, sync, or enterprise work.

Apply these readiness rules exactly:

- READY: implement after technical prerequisites are satisfied.
- DEPENDENT: implement only after prerequisites are verified. For draft development in this run, locally validated ancestor commits may satisfy ordinary merge dependencies; list those unmerged parents explicitly. This does not count as merged completion.
- REVIEW-GATED: never mark maintainer approval yourself. You may prepare a concrete proposal and isolated draft code/tests only where the plan does not require approval before that action. Respect any earlier gate, such as approval before evidence persistence begins. When uncertain, prepare the proposal only, record the precise decision needed, and skip dependent work.
- DEFERRED: leave it deferred unless the user explicitly reprioritized it or it is necessary to repair a demonstrated regression in the current package. Record the evidence for that exception.

A tested draft does not satisfy a human-review gate. Do not change the handbook's statuses or rules to make blocked work appear authorized. Do not invent missing host callbacks, trust signals, retention/forget semantics, or provider transaction guarantees.

## Per-Package Loop

1. Record the task IDs, baseline commit, branch/worktree, allowed files, prerequisites, and acceptance criteria in the progress ledger before editing.
2. Inspect only the relevant source/tests. Resolve actual types and pinned SDK contracts. If existing code already satisfies a task, verify it rather than duplicate it.
3. Add a regression that fails for the intended reason. For a behavior correction, keep the old passing cases and discriminating negative controls.
4. Implement the smallest correct change. Preserve public compatibility where existing consumers/persisted data require it. Do not introduce unrelated abstractions or dependency upgrades.
5. Preserve all safety invariants: scope/integrity fail closed, host operation fails open, no secret persistence, no generated-content self-promotion, bounded work/context, and no replay overwriting reviewed or superseded knowledge.
6. Validate the new behavior, error paths, replay/concurrency where applicable, and affected host/provider paths. Never lower relevance thresholds, drop assertions, label failures as expected, or skip required integrations merely to turn CI green.
7. Inspect the final diff for unintended files, secrets, inconsistent docs, missing consumers, and falsely claimed completion. For persistence/security work, perform a separate adversarial verification pass before pushing.
8. Commit only intended verified changes with a concise message. Push and create a draft PR for that bounded behavior, including task IDs, precise tests/counts/skips, limitations, and dependencies. Never merge it. Do not request automatic issue closure through `Fixes`/`Closes` unless explicitly authorized.
9. Check CI for the pushed head. Repair failures within the retry budget. Do not use a failing or unverified package as a prerequisite for later work.
10. Update the ledger, then continue immediately to the next eligible package. Do not stop after the first successful PR or ask whether to continue.

## Testing and Data Safety

Use repository scripts and the plan's testing section. Run relevant formatting, lint, typecheck, unit/integration tests, build, and host/package checks. Full database validation must set `REMEM_TEST_DATABASE_URL` only to a fresh disposable PostgreSQL instance created for this run.

The database suite drops the `remem` schema. Never copy a connection string from installed ReMem configuration, another service, or the shell environment without establishing it belongs to your disposable instance. Inspect the assigned loopback port. Use a uniquely named temporary container and preferably ephemeral storage; do not remove an existing container to free its name or port.

Do not run suites concurrently against the same schema. Record skipped tests honestly; missing required coverage means unverified, not passed. Clean up only test resources you created, after dependent tests finish. Never print actual credentials or raw private data in progress logs, PRs, or reports.

## Git and PR Boundaries

Keep documentation, short-continuity behavior, version reporting, and other independent behaviors in separate PRs. Use a worktree when a blocked package must remain dirty while you work elsewhere.

Use stacked draft branches only for genuine dependencies. A child PR must target its immediate parent branch so its diff contains only the child's work. An independent package should target main or the minimal shared documentation foundation, not an unrelated feature branch. List parent PRs and merge order; never silently accumulate all work in one giant PR.

If a branch has a failing implementation, preserve it locally with an accurate blocker record; do not claim it as verified or push it as a passing deliverable. Do not hide unrelated changes in a stash. Reuse this run's branches/PRs when resuming rather than creating duplicates.

## Durable Progress

Maintain `plan/EXECUTION-STATUS.md` on the run's coordination/documentation branch. Other worktrees should not independently rewrite this shared ledger. Use one row per package with:

- task IDs and short objective;
- status: queued, in-progress, implemented-unmerged, draft-awaiting-review, blocked, or merged;
- baseline/parent and branch/worktree;
- commit and PR URLs when they actually exist;
- exact verification commands, results, and skips;
- blocker or required human decision;
- next action and relevant evidence locations.

Checkpoint after each package and before context compaction or an expected session limit. Preserve enough information that a fresh session can resume without reading the entire conversation. Do not put secrets or full transcripts in the ledger. Keep the normative milestone checklist incomplete until its full criterion is implemented, verified, and merged.

## Blockers and Completion

Do not interrupt the user for routine choices about names, formatting, or implementation details already settled by the plan. Choose the smallest established repository pattern.

For a real ambiguity, denied permission, missing trust contract, repeated failure, or review gate, record a concise blocker and continue with independent eligible work. Do not circumvent a safety rule to avoid asking a question. Stop if all remaining work is blocked/deferred, if safe isolation is impossible, or the run limit is reached.

Finish with a concise report: implemented tasks; draft PRs and merge order; verification results; work still uncommitted; blockers/approval questions; remaining risks; and the next recommended task. Distinguish draft implementation from approved, merged, or deployed behavior. Leave the repository and ledger in an honest, resumable state.
