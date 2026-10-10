# sbx Manager — Web App TODO

A Python web app to configure `sbx` sandboxes through a browser UI. The backend
shells out to the real `sbx` CLI; the frontend is a single static page with a
sidebar + content area matching `form.png`. First two feature groups: **Secrets** and **Egress**.

## Stack (decided) — zero dependencies, simple but extensible
Single-user, localhost-only, trusted tool. No framework needed.
- **Python stdlib `http.server`** — serves one static page + a handful of JSON endpoints.
  No FastAPI/uvicorn, no npm/build step, nothing to `pip install`.
- **One static `index.html`** + vanilla JS `fetch()` for forms/tables. CSS inline or
  one small `static/app.css`. No templating engine (no Jinja2), no HTMX.
- **`app/sbx.py`** — the only part with real logic: a thin, unit-tested wrapper that
  invokes `sbx` via `subprocess` (list-form args, no `shell=True`).

### Extensibility seams (so "simple" doesn't become "stuck")
- **Route dispatch table**: `{(method, path): handler}` mapping, so adding a feature =
  add a handler + a row. Keeps the stdlib handler from becoming an `if/elif` sprawl.
- **Feature isolation**: each feature (secrets, egress, …) is its own module exposing
  its routes/handlers; `server.py` just registers them.
- **sbx wrapper is the boundary**: UI/HTTP layer never builds argv inline — it always
  goes through `app/sbx.py`. Swapping stdlib → Flask later (if ever) touches only the
  HTTP layer, not the feature logic.
- Decision: start stdlib. Only add a single dep (Flask) if endpoints outgrow a simple
  dispatch table. Don't add it preemptively.

## Scope & assumptions (decided)
- [x] **Landing page = sandbox selector** (first screen). Populated from `sbx ls --json`.
      Choosing a sandbox sets the active context that drives Secrets + Egress.
      "Global" is a selectable scope alongside the listed sandboxes.
- [x] One active sandbox at a time (switch via the selector to change context).
- [x] Local `sbxd` only for v1 (no `--cloud`).
- [x] "Egress" == `sbx policy allow/deny/check network [...] [--sandbox <s>]`
      (+ optional `sbx settings set proxy`).
- [x] Run the web app on the host (not inside a sandbox) — it drives the host `sbx` CLI.
      Localhost-only, single-user, unauthenticated (Open Question #4 settled).
- [x] **Bind `127.0.0.1` only. No TLS for now** — on loopback TLS adds cert/key management
      without a matching threat (a same-host attacker is already inside the trust boundary).
      Caveat: if ever bound beyond loopback, TLS **and** auth must both be reinstated.
- [x] **Theme selector**: light/dark toggle via CSS custom properties + `data-theme` on
      `<html>`, persisted in `localStorage`, defaulting to `prefers-color-scheme`. No deps.

---

## 0. Project scaffolding
- [ ] No `requirements.txt` needed for v1 (stdlib only). Add one only if/when a dep is.
- [ ] Layout:
      - `app/server.py` — stdlib HTTP server: static file serving + route dispatch table
      - `app/sbx.py` — thin wrapper around the `sbx` CLI (subprocess)
      - `app/features/secrets.py`, `app/features/egress.py` — per-feature route handlers
      - `app/static/index.html` — single-page UI (sidebar + content area)
      - `app/static/app.css`, `app/static/app.js` — styling + vanilla fetch logic
- [ ] Promote the existing stub `server.py` into `app/server.py` (keep 127.0.0.1:8123),
      add a `{(method, path): handler}` dispatch table and static-file serving.
      → verify: `python3 -m app.server` serves `index.html` at `/`.

## 1. sbx CLI wrapper (`app/sbx.py`)
- [ ] `run_sbx(args: list[str]) -> (rc, stdout, stderr)` using `subprocess.run`,
      list-form args, timeout, no `shell=True`.
- [ ] Prefer `--json` where sbx supports it (e.g. `secret ls --json`) and parse it.
- [ ] Never echo secret values back into responses/logs; reference by name/last-4 only.
      → verify: unit test that a fake sbx binary is invoked with expected argv.

## 2. Single-page UI (`static/index.html`)
- [ ] **Landing view = sandbox picker**: `GET /api/sandboxes` (`sbx ls --json`) →
      list of sandboxes + a "Global" option. Selecting one sets the active context
      and reveals the sidebar.
- [ ] Sidebar with "Secrets" and "Egress" nav items (per `form.png`), plus the active
      context (selected sandbox) shown and switchable.
- [ ] Content area `<div id="content">`; nav clicks fetch JSON and render client-side.
- [ ] Plain CSS (`app.css`); no CDN frameworks required (add later only if wanted).
- [ ] **Theme toggle** (light/dark): CSS custom properties + `data-theme` on `<html>`,
      control in the sidebar, persist to `localStorage`, default to `prefers-color-scheme`.
      → verify: picking a sandbox lands on Secrets; nav swaps content without full reload;
        theme toggle persists across reloads.

## 3. Secrets feature
Backed by `sbx secret ...` (see `sbx.md`).

Display rules (decided):
- **Never reveal stored values.** Show name/service, scope, source (for dynamic secrets),
  and sbx's native **last-4 preview** where available. No hashing (crackable fingerprint;
  also sbx never returns the stored value anyway).
- **Mask by default** in set/change inputs, with a temporary **unmask (eye) icon**
  (password-manager style). Masking is input-only; saved values are never shown again.
- **Group intelligently**: primary by **service** (github, openai, …), sub-grouped by
  scope (active sandbox vs global). Registry credentials and custom/experimental secrets
  are their own groups (the CLI distinguishes these).

- [ ] **List**: `GET /secrets` → render from `sbx secret ls --json`
      (active sandbox + global; `--service` filter available). Columns: service, scope,
      source/type, last-4, status.
- [ ] **Set service secret**: masked form input → value delivered to
      `sbx secret set <service> [--sandbox s]` over **stdin**
      (never `--token`/`--value` — those put the secret in argv/`ps`/`/proc`/history).
      - [ ] Service dropdown from documented list
            (anthropic, copilot, cursor, devin, droid, github, google, groq, mistral,
            nebius, openai, openrouter, xai).
      - [ ] Optional `--oauth` path (openai/global per docs).
      - [ ] Dynamic source: `--ref` (1Password/AWS SM) or `--command`, with `--refresh`
            (default 55m); show source string, not a value.
- [ ] **Registry credential**: `sbx secret set --registry <host> --password-stdin`
      (value via stdin) with `--all-sandboxes` / `--sandbox` toggle, optional `--username`,
      `--registry-auth-endpoint`.
- [ ] **Custom secret** (experimental): `sbx secret set-custom --host ... --env ...`,
      value via stdin where supported (fallback `--value` only if stdin unavailable).
- [ ] **Import**: `sbx secret import --all` / per-service (surface `--dry-run`).
- [ ] **Remove**: `sbx secret rm <service> [--sandbox s] [-f]`, confirm in UI.
      → verify: each action maps to the correct argv; stdin carries the value;
        list reflects changes; no value ever appears in responses/logs.

## 4. Egress feature
Commands confirmed from `sbx-policy.md` (+ `make-policy.sh`, `sbx-settings.md`):

Global setup (one-time):
- `sbx policy init <allow-all|balanced|deny-all>`  — initial global network policy
- `sbx policy reset [--force]`                     — clear all policies, restart daemon

Rules (allow/deny precedence: deny wins):
- Allow:  `sbx policy allow network <host[:port]>`   (e.g. `api.example.com:443`)
- Deny:   `sbx policy deny network <host[:port]>`
- Check:  `sbx policy check network <host>`          — read-only, same authorizer as enforcement
- Remove: `sbx policy rm network --id <RULE_ID>`     (local rules only)
          `sbx policy rm network --sandbox <s> --resource <HOST>`

List / inspect:
- `sbx policy ls`                     — one row per policy (overview)
- `sbx policy ls <SANDBOX>`           — rules applying to one sandbox
- `sbx policy ls --wide`              — rule-level rows incl. RULE_ID + resources
- `sbx policy ls --json`              — machine-readable (use this for the UI)
- `sbx policy ls --type network`     — filter to network rules
- `sbx policy ls --source local|org|kit`, `--decision allow|deny`, `--protocol tcp|udp`
- `sbx policy inspect <policy-or-rule> [--json]` — full detail, shows removal command per rule

Audit:
- `sbx policy log [SANDBOX] [--json] [--limit N] [--type network]` — allowed/blocked hosts

Upstream proxy (`sbx-settings.md`):
- `sbx settings set proxy <url>` / `sbx settings get proxy --json` / `sbx settings unset proxy`

### UI tasks
- [ ] **One-time init banner**: if global policy uninitialized, offer `policy init balanced`
      (recommended) / `allow-all` / `deny-all`.
      → partial: backend `egress.init` + `POST /api/egress/init` exist; no frontend
        banner/uninitialized-state detection wired yet.
- [x] **List rules**: `GET /egress` → `sbx policy ls <s> --wide --json` → table with
      resource, decision (allow/deny), source (local/org/kit), RULE_ID, editable?.
      → done: `egress.list_rules` + `GET /api/egress`; `loadEgress`/`renderEgressTable`.
- [x] **Allow host**: form → `sbx policy allow network [--sandbox <s>] RESOURCES`
      (check-then-apply guard via `sbx policy check network` from `make-policy.sh`).
      RESOURCES is comma-separated; supports wildcards (`*.`,`**.`), globs, char classes,
      ports (`host:443`), IPv6 (`[addr]:port` / CIDR), and `**` = allow all.
      Optional `--protocol tcp|udp` (repeat/comma for both); HTTP rules via `--method`,`--path`.
      → done: `egress.allow` + `POST /api/egress/allow`; add-host form `data-decision="allow"`.
        (HTTP `--method`/`--path` not surfaced in the form yet.)
- [x] **Deny host**: form → `sbx policy deny network [--sandbox <s>] RESOURCES` (same syntax; deny wins).
      → done: `egress.deny` + `POST /api/egress/deny`; add-host form `data-decision="deny"`.
- [x] **Check host** (read-only): `sbx policy check network <host>` from the UI.
      → done: `egress.check` + `POST /api/egress/check`; `showCheckForm` reports ALLOWED/BLOCKED.
- [x] **Scope**: global by default; `--sandbox <s>` scopes to that sandbox's `local` policy.
      There is no `--global` flag — global is the default (omit `--sandbox`).
      → done: `egress._scope_args`; frontend passes `currentScopeParam()` on every call.
- [ ] **Bulk allow**: textarea → join hosts into one comma-separated `allow network` call
      (not a loop — RESOURCES accepts a list). Port the `make-policy.sh` host set.
      → partial: add-host input already accepts a comma-separated list in one call;
        dedicated textarea + ported make-policy.sh host set not implemented.
- [x] **Remove rule**: `sbx policy rm network --id <RULE_ID>` (from `ls --wide --json`);
      fall back to `--sandbox <s> --resource <host>`. Only local rules are removable
      (UI must disable remove for org/kit rules — `editable` flag from inspect/ls).
      → done: `egress.remove` (`--force --id`, +`--sandbox`) + `DELETE /api/egress`;
        `applyGroup("remove")`; non-local/log rows aren't selectable so remove is gated.
- [x] **Policy log view** (optional): `sbx policy log <s> --json` to debug blocked hosts.
      → done: `egress.log` + `GET /api/egress/log`; merged into rows (SEEN column +
        "Policy log" rows for observed-but-unruled hosts).
- [x] **Filter rules view** (client-side): text input does a case-insensitive substring
      match on host (empty = show all); re-renders from cached rows (no refetch).
      Quick-filter facets [Allowed] [Blocked] [Denied] render as a segmented control,
      combine (AND) with the text filter, and are mutually exclusive; typing in or
      focusing the text filter clears the active facet. Active-filter status chip
      "🔍 Viewing N of M rules" (accent-tinted pill, shown only while filtering).
      → verified: `node --check app/static/app.js` passes.
- [x] **Egress toolbar layout** (data-grid conventions): single find toolbar with
      search + segmented state facets left-aligned and the status chip right-aligned
      (`justify-content: space-between`). Bulk actions (Allow/Deny/Remove selected)
      moved into a contextual bar that is hidden until ≥1 row is selected, led by a
      "N selected" count.
      → verified: `node --check` passes; no stale `group-toolbar`/`eg-filter-bar` refs.
- [x] **Filter clear affordance**: custom × button inside the search field (visible only
      when non-empty) + Esc-to-clear while focused; native WebKit search × suppressed.
      All text-filter changes routed through one `applyTextFilter` path.
      → verified: `node --check` passes.
- [x] **Policy-log row highlight**: observed-traffic rows (`ruleId === null`) get a
      `log-row` class → amber row wash + 3px left accent spine (per-theme), plus a host
      tooltip "Parsed from egress logs — observed traffic, not a configured rule".
      → verified: `node --check` passes.
- [x] **De-duplicate host rows**: a policy-log observation whose host exactly matches an
      existing rule row must fold into that row (roll up SEEN) instead of spawning a
      second row. Screenshot showed `10.17.34.40:22` and `google.com` each as two rows
      (Policy-log + Local/Managed). Tighten the log→rule attach so exact-host matches merge.
      → done: `attach()` prefers an exact-host CONFIGURED rule row (`ruleId !== null`),
        then falls back to `ruleCoversHost`. Verified via node harness: observation folds
        into the allow rule row (1 row, SEEN merged, ruleId kept). (Note: the `google.com`
        case is rule+rule, not log+rule — out of scope here; both are real rules.)
- [x] **Translate deny/allow conflict errors**: stop passing raw sbx stderr
      (`conflicts with existing allow rule "<uuid>" … for tcp`) to the user. Detect the
      conflict and show plain language: host is already allowed by a local rule; to block
      it, Remove the allow (a deny can't override an allow at the same host/scope).
      → done: `translateEgressError()` maps the conflict stderr to actionable text (no
        UUIDs); wired into the bulk Allow/Deny flash (as a "warning") and the add-host
        form error line. Verified: translated output contains no UUID.
- [x] **Sticky egress controls** (desktop-only): keep the find toolbar + table column
      header visible while the long rules list scrolls (single page scrollbar, no inner
      scroll region, no mobile layout — this is a localhost desktop tool).
      `.eg-toolbar` sticky `top:0`; `.bulk-bar` sticky `top:58px` (under the toolbar,
      reachable while scrolling); `.rules-table thead th` sticky `top:58px`. Offset via
      `--eg-sticky-top` on `.content`; z-stack toolbar 20 > bulk 15 > thead 10.
      → done: `node --check` passes; CSS braces balanced; no `@media`/mobile rules.
- [x] **Deny a currently-allowed rule (remove-then-deny, rule-as-unit)**: when **Deny** is
      clicked on a rule that is currently an allow, `sbx` refuses a direct deny
      (`conflicts with existing allow rule`). Operate on the **whole rule the user clicked**
      — remove that allow rule, then recreate the identical resource set as a deny. If
      unwanted, the operator removes the rule manually instead. Decisions (confirmed):
      - [x] **The rule to act on is the clicked rule.** No host-matching/lookup — the row
            carries the rule `id` + `scope`. (Earlier "which allow to remove" was a non-question.)
      - [x] **Port / resource carry-through**: deny the rule's exact resource string(s)
            (e.g. `10.17.34.40:22`), so ports carry through for free — no port parsing.
      - [x] **Deny a bundle = atomic flip of the whole bundle**: `rm network --id <bundle>`
            (drops all allows) → `deny network <all original hosts, comma-joined>` (recreates
            the same host set as one deny bundle). One click flips every host in the bundle.
      - [x] **Scope correctness**: pin both the remove and the deny to the clicked rule's
            own scope (`--sandbox <s>` for sandbox-scoped rules; omit for global).
      - [x] **Scope the feature to the row-based Deny path** (`applyGroup("deny")`), where
            the rule id + scope are known. The **+ Add host → Add deny** form (typed string,
            no rule id) keeps showing the guidance message.
      - [x] **Retry semantics**: try deny → on `conflicts with existing allow rule`, remove
            the clicked allow rule → retry deny once. Never blind-remove on any other error.
      - [x] **Transparency/confirm**: gate the destructive remove behind a danger-styled
            confirm — "<rule> is currently allowed. Blocking it will remove the existing
            allow rule and create a deny. Continue?" — preserving the manual escape hatch.
      → done: `applyGroup("deny")` flattens bundle hosts, detects checked rows that are
        currently-allowed configured rules (`data-state="allowed"` + `data-ruleid`), shows a
        danger confirm, removes each allow rule by its own id+scope (bundles removed whole),
        then issues the deny for the full host set; `translateEgressError` remains the
        fallback for any residual covering-rule conflict. Verified: `node --check` passes.
- [x] **Bundled rules as first-class rows (rule-as-unit rendering)**: a rule with
      `resources.length > 1` renders as ONE row (stop expanding `resources[]` into N rows
      in `buildRows`). The rule is the unit of management; allow/deny/remove act on the whole
      bundle atomically (matches `sbx` storage + `rm --id`). Confirmed by `sbx-policy.md`:
      `allow network "a,b"` creates one multi-resource rule; `rm --id` deletes the whole rule.
      Decisions (confirmed):
      - [x] **Never break hosts out of a bundle** into separate rows for any operation.
      - [x] **Truncate to column width + "…(+N more)"**: show as many hosts as fit, then a
            count badge. (CSS ellipsis alone can't append the count, so compute the "+N more"
            in JS; the visible host text may still CSS-ellipsis within the cell.)
      - [x] **Clickable → info dialog**: the bundle cell is a link that opens a read-only
            popup titled **"Host Bundle"** listing all hosts, dismissed with a single **OK**
            button. Add a small `infoDialog({title, lines})` reusing the existing `<dialog>`
            node (do NOT overload `confirmDialog`); render hosts via `textContent` (no injection).
      - [x] **Bundle tint**: parallel to the amber `.log-row`, add a `.bundle-row` with a
            **violet/indigo** spine+wash (per-theme token) and a tooltip
            ("Bundled rule — N hosts; click to view all").
      - [x] **No bundle+log dual-tint case exists**: confirmed in `buildRows`/`attach` —
            policy-log entries are per single host (`e.host`) and only roll SEEN into a
            single-host rule row; a log observation is never itself a bundle and cannot
            "fold into a bundle" as a merged dual-state row. A row is bundle XOR log.
      - [x] **SEEN for bundles = aggregate on the bundle row** (sum of observations across
            the bundle's hosts). Do NOT list per-host counts in the rule view. IF `sbx policy
            log` provides per-host counts (it does — `attach` has per-host `seenCount`), show
            the per-host breakdown ONLY inside the **Host Bundle** info dialog, with the
            bundle row's SEEN showing the overall total.
      → done: `buildRows` now emits one row per rule carrying `hosts[]`, `bundle`
        (`hosts.length>1`), and `seenByHost{}`; `attach()` indexes every host of every rule
        so a log observation for any bundle host folds into that bundle's single row
        (aggregate SEEN on the row, per-host totals in `seenByHost`). `renderEgressTable`
        gives bundles a `.bundle-row` (violet/indigo), shows the primary host + a
        `(+N more)` link opening `showBundleDialog` → `infoDialog({title:"Host Bundle"})`
        (OK-only, `textContent`, per-host SEEN listed). Checkbox `data-host` carries the
        comma-joined host set so Allow/Deny act on the whole rule. Verified: `node --check`
        passes; CSS braces balanced; node harness confirmed one-row-per-bundle, log folding,
        per-host SEEN, no stray policy-log rows; 49 python backend tests still pass.
- [ ] **Upstream proxy** (optional): set/get/unset via `sbx settings`.
      → verify: allow a host → `policy check` passes → `policy ls --json` shows the rule.

Note: RESOLVED — `sbx-policy.md` now includes the full `allow network` leaf help.
Confirmed: RESOURCES is comma-separated; scope is global-by-default with `--sandbox <s>`
for a single sandbox (no `--global` flag); pattern syntax covers wildcards/globs/char-classes/
ports/IPv6/CIDR and `**`; `--protocol`, `--method`, `--path` are available. `deny network`
mirrors `allow network`. `rm network --id <RULE_ID>` (local only; ID from `ls --wide`/`inspect`).
The standalone `check network` / `rm network` leaf pages aren't dumped, but usage is pinned
down via the parent listings + `inspect`/`ls` references.

## 5. UX polish
- [ ] Flash/toast on success/error from sbx stderr (sanitized).
- [ ] Disable destructive actions behind a confirm step.
- [ ] Loading indicators on fetch requests.
- [ ] Empty states for "no secrets" / "no egress rules".

## 6. Verification & docs
- [ ] Smoke test against a real local sandbox (create one, set a secret, allow a host).
- [ ] Unit tests for `app/sbx.py` argv construction (mock subprocess).
- [ ] Short README: how to run (`python3 -m app.server`, then open http://127.0.0.1:8123). No deps to install.
- [ ] Add `run`/`serve` target to the Makefile.

---

## Resolved decisions
1. **Leaf `network` flags** — ✅ RESOLVED by updated `sbx-policy.md`. `allow network`
   leaf help confirms: comma-separated RESOURCES, global-by-default scope with `--sandbox <s>`
   (no `--global` flag), full pattern syntax (wildcards/globs/char-classes/ports/IPv6/CIDR/`**`),
   and `--protocol`/`--method`/`--path`. List view uses `sbx policy ls --wide --json`;
   removal uses `rm network --id <RULE_ID>`.
2. **Scope model** — ✅ One active sandbox at a time. Landing page is the sandbox
   selector (`sbx ls --json`); selection drives Secrets + Egress. "Global" selectable.
3. **Secret scope UI** — ✅ No hash. Mask by default + temporary unmask (eye) icon on
   inputs; stored values never revealed (show last-4 + metadata). Group by service,
   sub-grouped by scope. Values entered in the web form, delivered to sbx over **stdin**.
4. **Web app auth** — ✅ Localhost-only, single-user, unauthenticated.
