# Contributing to Remem

Remem is early-stage software that handles potentially sensitive context. Changes should favor
small interfaces, explicit provenance, bounded context, and failure isolation.

## Development

Requirements:

- Node.js 22 or newer
- npm 10 or newer

Install and verify:

```sh
npm ci
npm run check
```

Useful commands:

```sh
npm test
npm run test:coverage
npm run lint
npm run typecheck
npm run format:check
npm run build
```

## Pull Requests

- Open an issue before a large architectural change.
- Add behavioral tests for retrieval and context-injection changes.
- Preserve source attribution and scope when transforming memories.
- Do not add network calls, telemetry, or remote model use without explicit configuration and
  documentation.
- Keep normal logs free of memory contents.
- Add an ADR when changing a major architectural decision.
- Update the changelog for user-visible changes.

Commits should be focused and use imperative subject lines.

## Reporting Security Issues

Do not open public issues for vulnerabilities involving data disclosure. Follow
[`SECURITY.md`](SECURITY.md).
