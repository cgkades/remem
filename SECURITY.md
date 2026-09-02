# Security Policy

## Reporting a Vulnerability

Report vulnerabilities through the repository's private GitHub security-advisory channel. Do not
open a public issue when a report could expose memory contents, credentials, private paths, or
provider access details.

Include affected versions, impact, reproduction steps, and any known mitigations. Maintainers will
acknowledge the report as soon as practical and coordinate disclosure after a fix is available.

## Supported Versions

Remem is pre-1.0. Security fixes are applied to the latest release and the default branch.

## Data Handling

Remem is local-first and has no telemetry. The Markdown MVP performs no network requests. Future
remote providers and model-backed stages must be explicitly configured; their data-handling
properties will be documented separately.

See [`docs/security-model.md`](docs/security-model.md) for the threat model and operational
guidance.
