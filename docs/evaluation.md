# Evaluation

## Executable Corpus

The repository contains a real, checked-in evaluation corpus at
`tests/fixtures/evaluation/catalog.json`. "Real" here means it is executable test data rather than a
proposed future benchmark; it is a curated engineering-memory fixture, not production user logs.

The corpus contains 30 entries spanning:

- decisions, preferences, procedures, incidents, tasks, and other notes;
- current, stale, and superseded records;
- project and global scopes;
- unresolved work;
- aliases and paraphrases; and
- close distractors across projects and topics.

Eight prompts are evaluated: five have an expected topic and three are intentionally unrelated.
Examples include AWS authentication paraphrase, Phoenix Kafka continuity, a communication
preference, an unresolved deployment blocker, a current database decision, and three negative
general-knowledge/coding requests.

## Run It

```sh
npm test -- tests/evaluation.test.ts
```

The test runs the normal `RememOrchestrator` with provider/topic catalog construction, deterministic
and local semantic recognition, provider execution, normalization, deduplication, synthesis, and
token accounting.

## Required Thresholds

The test asserts:

| Metric                    | Assertion        |
| ------------------------- | ---------------- |
| Relevant recall rate      | at least `0.8`   |
| Missed relevant prompts   | at most `1`      |
| Irrelevant injection rate | exactly `0`      |
| Maximum selected tokens   | at most `2300`   |
| Maximum per-case latency  | under `500 ms`   |
| Provider failures         | exactly `0`      |
| Deduplicated results      | greater than `0` |

Relevant recall requires an actual provider request and selected output containing the expected
fixture content; a below-threshold catalog match does not count. Irrelevant injection counts a
negative case with one or more selected records. Selected tokens are the maximum combined catalog
and recall estimate across cases. The provider deliberately returns duplicate bodies so the test
also proves exact-content deduplication.

These are threshold assertions, not an accuracy claim for arbitrary language. The default local hash
model is deterministic feature hashing with small concept groups and is not a general neural
embedding model.

## Other Behavioral Coverage

Separate tests cover:

- semantic paraphrase routing and unrelated-prompt suppression;
- Markdown scoping, frontmatter, path exclusions, and symlink/file limits;
- provider timeout and partial-failure fallback;
- malformed and out-of-scope provider result rejection;
- provenance-preserving exact-content deduplication;
- untrusted instruction-like memory rendering;
- v2 system-policy/user-data separation and the v1 compatibility path;
- migration clean install, version 1 through version 4 upgrade, and repeated no-op migration;
- PostgreSQL CRUD, scope filtering, provenance, full-text/vector search, supersession, and embedding
  failure fallback;
- managed loopback Compose generation and protected files; and
- restore confirmation and subprocess secret redaction.

## CI Environment

GitHub Actions runs `npm run check` on Node.js 22 and 24. Each matrix job starts
`pgvector/pgvector:0.8.1-pg16`, sets `REMEM_TEST_DATABASE_URL`, and therefore executes the PostgreSQL
integration suite rather than skipping it.

`npm run check` includes Prettier, ESLint, TypeScript, tests, and build.

## Interpretation and Gaps

The current corpus is small, English-heavy, deterministic, and selected around implemented concept
groups. A single in-process latency maximum does not represent production tail latency, Docker
startup, external network databases, or large catalogs. The token estimator uses UTF-8 byte length as
a conservative bound rather than a model tokenizer.

Future evaluation should add:

- larger redacted prompt sets not selected to match concept groups;
- repeated p50/p95/p99 latency and warm/cold catalog measurements;
- per-scope leakage tests across multiple users/workspaces;
- stronger embedding model comparisons with reindex cost;
- restore verification with record counts and representative searches;
- host-version contract tests for future OpenCode v2 beta updates; and
- precision/context-cost reports across supported model families.

Evaluation should continue to report false positives and context cost alongside recall. Injecting
everything is not a successful memory system.
