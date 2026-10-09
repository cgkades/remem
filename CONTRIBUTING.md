# Contributing to ReMem

Development requires Node.js 22 or newer and npm 10 or newer. Changes should favor small interfaces,
explicit provenance, bounded context and failure isolation.

Start with [PRODUCT-VISION](docs/PRODUCT-VISION.md), [TARGET-ARCHITECTURE](docs/TARGET-ARCHITECTURE.md),
accepted [ADRs](docs/adr/), [current status](docs/current-status.md) and the
[documentation index](docs/index.md). The September audits, original MVP and recovery handbook
are dated history. They do not establish that shipped functions are absent. Resolve source symbols,
current `main`, recent merged PRs and live issue acceptance criteria before implementing.

Prefer the smallest complete vertical behavior and reuse existing storage, providers, migrations,
host adapters and tests. Keep semantic knowledge distinct from episodic evidence. Preserve source
authority, project isolation, sensitive human review, local-first transport and fail-open host turns;
persistence/authorization fail closed. Never use a model-generated success/approval flag as
independent verification. Material architecture/default changes need a maintainer decision.
Open an issue and add an ADR for a major architectural change. Keep normal logs free of memory
contents; new network calls, telemetry or remote models require explicit configuration and docs.

For each focused PR, reproduce the defect or missing behavior, reference the existing issue,
implement the fix and regression/negative controls, and describe runtime evidence separately from
source findings. Use the actual highest migration number and never edit applied migration history.
Do not close issues until their full criteria are verified and the change is merged. Follow the
maintainer's merge authorization; passing CI does not itself grant permission to merge.
Keep commits focused with imperative subjects, and update the changelog for user-visible behavior.

```sh
npm ci
npm run check
npm run pack:check
npm run pack:smoke
```

`check` runs formatting, lint, types, Vitest and build. PostgreSQL tests skip without
`REMEM_TEST_DATABASE_URL`; record counts/skips honestly. CI supplies disposable PostgreSQL/pgvector
on Node 22 and 24 and runs native OpenCode v1/v2, Pi and neural evaluation separately. To run the
entire ordinary suite against a disposable local database:

```sh
npm run test:postgres:up
REMEM_TEST_DATABASE_URL=postgresql://remem_test:remem_test@127.0.0.1:54330/remem_test npm run check
npm run test:postgres:down
```

Integration fixtures drop the `remem` schema. Never point them at installed/production memory.
`npm run test:postgres` is the narrower provider suite, not every database regression. Native v2's
`npm run test:opencode-v2` also needs a disposable database for its full learning gate. Docker-based
host commands are listed in `package.json`.

Report recall, forbidden injection, procedure/provenance correctness, context cost, latency and
interruption recovery when memory behavior changes. Keep deterministic gates and optional model
quality separate. Update current guides in the same PR when behavior changes, label measured limits,
and preserve historical/ADR evidence rather than rewriting it as new results.

Useful focused commands include `npm test`, `npm run test:coverage`, `npm run lint`,
`npm run typecheck`, `npm run format:check` and `npm run build`.

Report disclosure vulnerabilities privately following [SECURITY.md](SECURITY.md), rather than
opening public issues with sensitive content.
