# Installation

## Status and Requirements

`opencode-remem` has not been published to npm. Install from a source checkout.

Required for all modes:

- Node.js 22 or newer;
- npm; and
- OpenCode v2 beta `0.0.0-beta-18743` for the primary adapter, or OpenCode `1.18.26` for the isolated
  compatibility adapter.

Managed mode also requires a running Docker engine with Docker Compose. External mode requires a
PostgreSQL server with pgvector 0.8 or newer and host `pg_dump`/`pg_restore` binaries for CLI backup and restore.
The tested database image is `pgvector/pgvector:0.8.1-pg16`.

## Build the Source Checkout

From the repository root:

```sh
npm ci
npm run build
npm link
```

`npm link` exposes the local `remem` executable. If you do not want a global link, replace `remem` in
every example with `node /absolute/path/to/remem/dist/cli.js`.

## Managed Installation

```sh
remem init --mode managed
remem doctor
```

Initialization:

1. checks Docker and Compose;
2. creates protected config/data/backup directories;
3. selects an available port starting at `54329`;
4. creates a generated database password and protected Compose files;
5. starts `pgvector/pgvector:0.8.1-pg16` on `127.0.0.1` only;
6. applies schema migrations through version 4; and
7. runs doctor checks.

Choose a starting port explicitly when needed:

```sh
remem init --mode managed --port 55432
```

The CLI tries that port and up to the next 99 loopback ports. Re-running `remem init` is idempotent
for an existing valid configuration: it starts managed storage if needed and applies pending
migrations.

## External PostgreSQL

Create an empty database and grant the Remem role enough privilege to create the `vector` extension,
the `remem` schema, tables, and indexes. Then initialize with an environment variable:

```sh
REMEM_DATABASE_URL='postgresql://remem:password@db.example/remem?sslmode=require' \
  remem init --mode external
remem doctor
```

The direct flag also works but can expose credentials in shell history or process listings:

```sh
remem init --mode external --database-url 'postgresql://remem:password@db.example/remem'
```

External mode does not provision, start, stop, or reset PostgreSQL. TLS, certificates, server
updates, availability, physical recovery, and backup scheduling remain operator responsibilities.

## Configure OpenCode v2

Source users should add the built package-root entry to OpenCode's `plugins` list:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/remem/dist/index.js"
    }
  ]
}
```

With no inline provider options, the plugin reads the application config created by `remem init`.
Restart OpenCode after editing its configuration.

`remem init --opencode` adds the bare package string `opencode-remem`. Because the package is not
published, use that flag only when your OpenCode installation can already resolve a local package
with that name. The explicit file URL above is the reliable source-checkout path.

For OpenCode `1.18.26`, use the isolated package export `./server` or `./opencode/v1`; a source build
uses `dist/server.js`. The v1 trust boundary is weaker. See
[OpenCode integration](opencode-integration.md).

## Platform Locations

| Platform | Configuration directory                               | Data directory                                           |
| -------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/remem`, otherwise `~/.config/remem` | `$XDG_DATA_HOME/remem`, otherwise `~/.local/share/remem` |
| macOS    | `~/Library/Application Support/Remem`                 | `~/Library/Application Support/Remem/data`               |
| Windows  | `%APPDATA%\Remem`                                     | `%LOCALAPPDATA%\Remem`                                   |

The configuration file is `config.json`; managed mode also creates `compose.yaml` and `.env` in the
configuration directory. Backups default to `backups/` under the data directory.

Override locations with `REMEM_CONFIG_DIR`, `REMEM_DATA_DIR`, or the full config file path
`REMEM_CONFIG`. See [Configuration](configuration.md) for precedence and security details.

## Verify the Installation

```sh
remem status
remem doctor
```

`status` and `doctor` currently run the same check suite:

- config and managed credential permissions;
- Docker and Compose availability in managed mode;
- managed container health or external ownership status;
- writable data directory;
- configured provider health;
- PostgreSQL connectivity and version;
- pgvector extension presence;
- pending schema migrations;
- database write access;
- embedding model ID and 384 dimensions; and
- whether an OpenCode config contains `opencode-remem`.

The OpenCode check is a string-presence check for `opencode-remem`. It cannot prove that the beta host
loaded the plugin or that a local file URL is correct. A source file URL whose path does not contain
that exact package name can produce a warning even when configured correctly.

## Upgrade a Source Checkout

After updating source:

```sh
npm ci
npm run build
remem backup
remem migrate
remem doctor
```

Automated pre-upgrade backups are not implemented. Keep the generated config and database backup
separate from the source checkout.
