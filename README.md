# @zenextia/cli

Deploy [Zenextia](https://zenextia.com) AI Factory applications from source.

You send your project's **source**; Zenextia builds it, signs the result and
verifies it before anyone in your Workspace can use it. The CLI never builds
anything locally and has no runtime dependencies.

Requires Node.js 20 or later.

```sh
npx @zenextia/cli login
npx @zenextia/cli deploy
```

or install it once: `npm install --global @zenextia/cli`, then use `zenextia`.

## Démarrage rapide (français)

1. Dans Zenextia, un administrateur active **Agents IA externes**
   (Paramètres > Intégrations) et vous donne le droit **Publier des applications**.
2. Connectez-vous : `zenextia login`. Le navigateur s'ouvre ; choisissez le
   Workspace puis autorisez l'accès.
3. Dans le dossier du projet (avec `zenextia.app.json`, `package.json` et
   `package-lock.json`) : `zenextia deploy`.
4. La CLI affiche l'avancement de la construction et de la vérification, puis
   le lien d'aperçu et l'étape suivante. Pour y revenir plus tard :
   `zenextia status`.

## Commands

| Command | What it does |
| --- | --- |
| `zenextia login [--api <url>] [--no-browser]` | Authorise the CLI for one Workspace (OAuth in the browser). |
| `zenextia logout [--api <url>]` | Forget the stored tokens for that API. |
| `zenextia deploy [dir] [--no-wait] [--timeout <minutes>]` | Archive the project, upload it, then follow the build and verification (30 min by default). |
| `zenextia status [dir \| --installation <id>] [--version-id <id>]` | Show where the last deployed version (or a given installation) stands. |

Global options: `--api <url>` (default `https://api.zenextia.com`, or the
`ZENEXTIA_API` environment variable), `--json`, `--help`, `--version`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success: deployed and ready (or queued with `--no-wait`), status read |
| 1 | Refused or failed: build or verification failed, upload refused, network error |
| 2 | Usage: bad option, missing project file, invalid lockfile |
| 3 | Authentication: not logged in, session expired or revoked, consent denied |

### For coding agents

Add `--json` to any command: stdout then carries exactly one JSON document
(`{"ok": true, ...}` or `{"ok": false, "error": {"code", "message", "hint"}}`)
and progress stays off stdout. Only `login` needs a human, once, to approve
the connection in the browser; the URL is printed on stderr.

## What gets uploaded

The archive is a ZIP of the project root, built deterministically (sorted
entries, fixed timestamps), limited to 100 MiB and 20,000 files:

- `zenextia.app.json`, `package.json` and `package-lock.json` are required.
  The lockfile must be npm lockfile v3 with every package from
  `https://registry.npmjs.org` and a `sha512` integrity.
- `.gitignore` files (root and nested) are honoured.
- `.git/`, `node_modules/`, `.env*` and `.npmrc` are never uploaded.
- Symbolic links and special files are refused: list them in `.gitignore` or
  replace them with real files.

Zenextia installs the locked dependencies with lifecycle scripts disabled,
then runs your build without network access; the output directory is `dist`.

## Authentication and stored data

`zenextia login` is a standard MCP OAuth 2.1 client of
`https://<api>/mcp`: dynamic client registration, authorization code with
PKCE (S256), a one-time loopback redirect on `127.0.0.1`, and rotating
refresh tokens renewed transparently. One login gives access to one Workspace.

Tokens are stored per API in `%APPDATA%\zenextia\credentials.json` (Windows)
or `~/.config/zenextia/credentials.json` (`$XDG_CONFIG_HOME` is honoured),
readable only by you (mode 0600). The last deployment of each application is
remembered in `deployments.json` next to it, for `zenextia status`.
`ZENEXTIA_CONFIG_DIR` overrides the directory.

`zenextia logout` deletes the local tokens. The connection stays listed in
Zenextia (Settings > Integrations), where it can be revoked.

### Behind a proxy

Node's `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set
(Node 22.21 / 24.5 and later).

## Development

```sh
npm test
```

Tests use `node --test` and a fake OAuth + MCP backend (`test-support/`).
Releases are published from `v*` tags by GitHub Actions with npm trusted
publishing and provenance.

## License

MIT
