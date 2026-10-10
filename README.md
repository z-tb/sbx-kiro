# sbx-kiro

This is a work-in-progress [Docker sandbox](https://docs.docker.com/ai/sandboxes/) (`sbx`) template for running the Kiro LLM in a Docker SBX environment, plus a web UI for managing the sandbox. The SBX tui is OK but navigating and managing takes different views and it seems a little janky yet so I came up with this idea. The web UI is a locally running python server that tries to present all the egress complexity in one view.  I do like it so far but still needs tuning.

The two parts:

1. **A Kiro SBX template** - an `sbx` kit (`kiro-kit/spec.yml`) and supporting Makefile/scripts that fire up Docker SBX (sandbox) with a pre-defined network egress allow-list for campus and running Kiro in general. 
2. **sbx Manager** - a localhost web frontend for the `sbx` commands that govern egress, secrets (really just a placeholder for now), and maybe other sandbox features.

This is an AI assisted project. The managment app is pretty basic for right now. It's a single-user tool bound to `127.0.0.1` that shells out to the real `sbx` binary rather than reimplementing anything. If the `sbx` command can't do it, neither can this. It's not intended to be served over the network as I didn't implement TLS into it because it's not needed for the time being. I'm still considering a self-signed cert once I have things in place a bit just becuase HTTP just doesn't feel right. 

## Quick Start

### 1. Stand up the Kiro sandbox

```bash
# Create and start the sandbox from the kit (first run)
make start

# Open a shell inside it
make shell
```

`make start` builds the sandbox named `kiro-llm` using the kit in `kiro-kit/`, which applies the Kiro network egress allow-list. Edit `kiro-kit/spec.yml` and run `make rebuild` to apply changes.

### 2. Run the management UI (optional, WIP)

```bash
# Foreground (Ctrl-C to stop)
make serve

# Or run the module directly
python3 -m app.server
```

Then open the UI:

```
http://127.0.0.1:8123
```

The app requires the `sbx` CLI to be installed and on your `PATH`. Endpoints that touch `sbx` return `503` with a clear message when the binary is missing, so the page still loads without it - it just can't do anything useful.

## The Kiro Sandbox Template

The template is what makes a sandbox suitable for running Kiro. It has three pieces:

| File | Role |
|------|------|
| `kiro-kit/spec.yml` | An `sbx` kit (schema v2, `kind: mixin`) named `kiro-network-policy`. A network permissions overlay that allow-lists the hosts Kiro needs - `*.kiro.dev` and regional endpoints, AWS SSO/OIDC/Cognito, VS Code CDN, Ubuntu/Alpine package mirrors, and site-specific domains. |
| `Makefile` | Sandbox lifecycle targets (`start`, `run`, `stop`, `status`, `shell`, `rebuild`, `purge`) plus `sbx` daemon control. The default sandbox name is `kiro-llm` and the mounted workdir is `/scratch/llm`. |
| `make-policy.sh` | Imperatively applies a baseline network allow-list to a running sandbox via `sbx policy allow`, skipping hosts that are already permitted. An alternative to the declarative kit for ad-hoc tweaks. |

A note carried from the kit: wildcard domains only match the first subdomain tier (e.g. `*.kiro.dev` matches `foo.kiro.dev` but not `foo.us-east-1.kiro.dev`), so nested wildcards are listed explicitly.

## Requirements

| Requirement | Notes |
|-------------|-------|
| Python 3.10+ | Standard library only (`http.server`). Uses `str \| None` type syntax. |
| `sbx` CLI | Must be on `PATH`. All sandbox operations are delegated to it. |
| A sandbox | Create one with `make start` (see the sandbox lifecycle targets below). |

## sbx Manager

The management UI is an early work in progress. It currently exposes two feature groups - secrets and egress - for the sandbox selected on the landing view. More `sbx` features may be surfaced over time; anything not yet in the UI is still managed through the `sbx` CLI directly.

### How it works

The server is a `{(method, path): handler}` dispatch table over `http.server.ThreadingHTTPServer`. Every request that needs sandbox data goes through `app/sbx.py`, a thin wrapper around `subprocess` that keeps the shell-out boundary in one place:

- List-form argv only. Never `shell=True`, never string interpolation.
- Secret values are piped over **stdin**, never passed as command-line arguments, so they never appear in `ps` or `/proc/<pid>/cmdline`.
- Stored secret values are never returned to the browser - the UI only ever sees names, scopes, and metadata from `sbx secret ls --json`.
- Request bodies are never logged (they may carry secrets).

The UI is a single static page: pick a sandbox (or the global scope) on the landing view, then manage **Secrets** and **Egress** for that context.

### Server

| Setting | Default | Notes |
|---------|---------|-------|
| Host | `127.0.0.1` | Bound to loopback only. Not configurable by design. |
| Port | `8123` | Set `APP_PORT` for the Makefile targets. |

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/sandboxes` | List sandboxes (`sbx ls --json`). |
| `GET` | `/api/secrets` | List secrets by scope/service. |
| `POST` | `/api/secrets` | Create/update a service secret (value via stdin, or `--oauth`/`--ref`/`--command`). |
| `DELETE` | `/api/secrets` | Remove a secret. |
| `GET` | `/api/egress` | List network policy rules. |
| `POST` | `/api/egress/allow` | Allow network resources. |
| `POST` | `/api/egress/deny` | Deny network resources. |
| `POST` | `/api/egress/check` | Read-only authorization check for a host. |
| `DELETE` | `/api/egress` | Remove a network rule by id. |
| `POST` | `/api/egress/init` | Initialize global network policy (`allow-all`, `balanced`, `deny-all`). |
| `GET` | `/api/egress/log` | Blocked/allowed host activity from the proxy. |

## Features

### Secrets

Store and manage the credentials a sandbox is allowed to use. Service secrets apply globally by default or can be scoped to a single sandbox. Supported services match the `sbx` CLI: `anthropic`, `copilot`, `cursor`, `devin`, `droid`, `github`, `google`, `groq`, `mistral`, `nebius`, `openai`, `openrouter`, `xai`.

A secret can be a literal value (piped over stdin), an OAuth flow (`--oauth`), or a dynamic source resolved at use time - a 1Password `op://` reference or an AWS Secrets Manager ARN (`--ref`), or an arbitrary command's stdout (`--command`).

### Egress

Manage the network policy that controls what a sandbox can reach. Allow or deny hosts, wildcards, globs, ports, or CIDR ranges, globally or per sandbox. Run a read-only `check` to see whether a host would be permitted, and read the proxy's activity log to see what was actually blocked or allowed. Only local (editable) rules can be removed; defaults, org, and kit rules are read-only.

## Usage

The `Makefile` has two groups of targets: the web app, and the underlying `sbx` sandbox lifecycle.

### Web app

```bash
make serve         # run in the foreground
make serve-bg      # run in the background (writes /tmp/sbx-manager.pid)
make serve-status  # is it running?
make serve-stop    # stop the background instance
make app-restart   # stop + start the background instance
```

### Sandbox lifecycle

These manage the `sbx` sandbox itself (named `kiro-llm` by default), not the web app.

```bash
make start    # create and start the sandbox from kiro-kit/spec.yml
make run      # start an existing (stopped) sandbox
make stop     # stop the sandbox
make status   # show sandbox state
make shell    # exec a shell inside the sandbox
make rebuild  # purge and recreate (needed after editing spec.yml)
```

The `sbx` daemon is controlled with `make sbx-start`, `make sbx-stop`, `make sbx-restart`, and `make sbx-status`.

## Development

```bash
# Run the test suite (stdlib unittest, no dependencies)
make test

# Verbose
make test-v
```

Adding a feature follows the same shape throughout: write a pure function in `app/features/` that builds argv and returns `(status, payload)`, register a handler row in the `ROUTES` table in `app/server.py`, and wire the UI in `app/static/`. Feature functions are unit-tested without touching HTTP.

## Project Layout

```
app/
  server.py          HTTP server + route dispatch table
  sbx.py             subprocess wrapper around the sbx CLI
  features/
    secrets.py       secret list/set/remove -> `sbx secret ...`
    egress.py        policy list/allow/deny/check/log -> `sbx policy ...`
  static/
    index.html       single-page UI
    app.css
    app.js
tests/               unittest suite for the server, sbx wrapper, and features
kiro-kit/
  spec.yml           sbx kit: network permissions overlay for the Kiro sandbox
Makefile             web app + sandbox lifecycle targets
make-policy.sh       bulk-apply a baseline network allow-list to a sandbox
```

## Notes

- The server binds to `127.0.0.1` only. It performs no authentication because it is not meant to be exposed. Do not put it behind a public listener.
- All privileged behavior lives in the `sbx` CLI. This app adds a UI and a safe subprocess boundary; it does not store credentials itself.
- sbx Manager is a work in progress. The sandbox template is usable on its own via the Makefile without ever starting the UI.

## License

GPL-3.0. See [LICENSE](LICENSE).
