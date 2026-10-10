"use strict";

// --- Theme toggle: persisted, defaults to OS preference ---------------------
const THEME_KEY = "sbxmgr-theme";
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
}
function toggleTheme() {
  const next =
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "light"
      : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_KEY, next);
}

// --- Context (selected sandbox) --------------------------------------------
let activeContext = null; // null | "__global__" | "<sandbox name>"

function showLanding() {
  document.getElementById("app").classList.add("hidden");
  document.getElementById("landing").classList.remove("hidden");
}
function showApp(context) {
  activeContext = context;
  const label = context === "__global__" ? "Global" : context;
  document.getElementById("active-context").textContent = label;
  document.getElementById("landing").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}

async function loadSandboxes() {
  const list = document.getElementById("sandbox-list");
  try {
    const res = await fetch("/api/sandboxes");
    const data = await res.json();
    const names = extractNames(data.sandboxes);
    list.innerHTML = "";
    list.appendChild(makeSandboxItem("Global", "__global__"));
    if (names.length === 0) {
      const note = document.createElement("li");
      note.className = "muted";
      note.textContent = data.error
        ? `No sandboxes (${data.error})`
        : "No sandboxes found.";
      list.appendChild(note);
    } else {
      names.forEach((n) => list.appendChild(makeSandboxItem(n, n)));
    }
  } catch (e) {
    list.innerHTML = `<li class="muted">Failed to load sandboxes.</li>`;
  }
}

// sbx ls --json shape isn't pinned yet; accept a few likely forms.
function extractNames(sandboxes) {
  if (!Array.isArray(sandboxes)) return [];
  return sandboxes
    .map((s) => (typeof s === "string" ? s : s && (s.name || s.id)))
    .filter(Boolean);
}

function makeSandboxItem(label, value) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.addEventListener("click", () => showApp(value));
  li.appendChild(btn);
  return li;
}

// --- Nav + view router ------------------------------------------------------
function initNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".nav-item")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderView(btn.dataset.view);
    });
  });
}

function renderView(view) {
  if (view === "secrets") return renderSecrets();
  if (view === "egress") return renderEgress();
  const content = document.getElementById("content");
  content.innerHTML = `<p class="muted">${view} view — not implemented yet.</p>`;
}

// --- Secrets view -----------------------------------------------------------
const SERVICES = [
  "anthropic", "copilot", "cursor", "devin", "droid", "github", "google",
  "groq", "mistral", "nebius", "openai", "openrouter", "xai",
];

function currentScopeParam() {
  // activeContext is "__global__" or a sandbox name; both are valid scope values.
  return activeContext;
}

async function renderSecrets() {
  const content = document.getElementById("content");
  content.innerHTML = `
    <div class="section-head">
      <h2>Secrets</h2>
      <button id="add-secret" class="btn">Set secret</button>
    </div>
    <div id="secret-form-wrap"></div>
    <div id="secrets-body"><p class="muted">Loading…</p></div>
  `;
  document.getElementById("add-secret").addEventListener("click", () =>
    showSecretForm()
  );
  await loadSecrets();
}

async function loadSecrets() {
  const body = document.getElementById("secrets-body");
  try {
    // List ALL scopes at once; the view sections them (Global first).
    const res = await fetch("/api/secrets");
    const data = await res.json();
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Could not list secrets: ${
        data.error || res.status
      }</p>`;
      return;
    }
    renderSecretGroups(body, data.secrets || [], data.custom_secrets || []);
  } catch (e) {
    body.innerHTML = `<p class="muted">Failed to load secrets.</p>`;
  }
}

// Field extraction aligned to real `secret ls --json`:
//   {"scope","type","name","secret"} where secret is always "(stored)".
function secretField(s, names, fallback = "") {
  for (const n of names) {
    if (s && s[n] != null && s[n] !== "") return s[n];
  }
  return fallback;
}

// Normalize a raw scope value ("global", "sandbox:box1", "box1") to a display
// label and the scope token the API expects (GLOBAL sentinel or sandbox name).
function normalizeScope(raw) {
  const v = (raw || "global").toString();
  if (v === "global" || v === "__global__") {
    return { label: "Global", token: "__global__", isGlobal: true };
  }
  const name = v.startsWith("sandbox:") ? v.slice("sandbox:".length) : v;
  return { label: name, token: name, isGlobal: false };
}

function renderSecretGroups(body, secrets, customSecrets) {
  const all = [
    ...secrets.map((s) => ({ ...s, _kind: "service" })),
    ...customSecrets.map((s) => ({ ...s, _kind: "custom" })),
  ];
  if (all.length === 0) {
    body.innerHTML = `<p class="muted">No secrets configured.</p>`;
    return;
  }

  // Group by scope. Key by token so "global"/"sandbox:x" collapse correctly.
  const byScope = new Map();
  all.forEach((s) => {
    const sc = normalizeScope(secretField(s, ["scope", "sandbox"], "global"));
    if (!byScope.has(sc.token)) byScope.set(sc.token, { meta: sc, items: [] });
    byScope.get(sc.token).items.push(s);
  });

  // Order: Global first, then sandbox scopes alphabetically by label.
  const scopes = [...byScope.values()].sort((a, b) => {
    if (a.meta.isGlobal) return -1;
    if (b.meta.isGlobal) return 1;
    return a.meta.label.localeCompare(b.meta.label);
  });

  body.innerHTML = "";
  scopes.forEach(({ meta, items }) => {
    const section = document.createElement("div");
    section.className = "scope-section";
    section.innerHTML = `<h3 class="scope-title">${meta.label}</h3>`;
    const table = document.createElement("table");
    table.className = "secret-table";
    table.innerHTML = `
      <thead><tr><th>Service</th><th>Type</th><th>Status</th><th></th></tr></thead>
      <tbody></tbody>`;
    const tbody = table.querySelector("tbody");
    items
      .sort((a, b) =>
        secretField(a, ["name", "service"]).localeCompare(
          secretField(b, ["name", "service"])
        )
      )
      .forEach((s) => {
        const service = secretField(s, ["name", "service"], "other");
        const type = secretField(s, ["type"], s._kind || "service");
        // sbx exposes no value or last-4 for stored secrets — only a
        // "(stored)" marker. Show it as a plain "Set" status; never fabricate.
        const raw = secretField(s, ["secret"], "");
        const isStored = raw === "(stored)" || raw === "";
        const statusHtml = isStored
          ? `<span class="badge set">set</span>`
          : `<code>${raw}</code>`;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${service}</td>
          <td>${type}</td>
          <td>${statusHtml}</td>
          <td></td>`;
        const btn = document.createElement("button");
        btn.className = "link-btn danger";
        btn.textContent = "remove";
        btn.addEventListener("click", () => removeSecret(service, meta.token));
        tr.lastElementChild.appendChild(btn);
        tbody.appendChild(tr);
      });
    section.appendChild(table);
    body.appendChild(section);
  });
}

async function showSecretForm() {
  const wrap = document.getElementById("secret-form-wrap");
  const options = SERVICES.map((s) => `<option value="${s}">${s}</option>`).join("");
  // Build scope choices: Global + any sandboxes.
  let scopeOptions = `<option value="__global__">Global</option>`;
  try {
    const res = await fetch("/api/sandboxes");
    const data = await res.json();
    (data.sandboxes || []).forEach((s) => {
      const name = typeof s === "string" ? s : s.name || s.id;
      if (name) scopeOptions += `<option value="${name}">${name}</option>`;
    });
  } catch (_) {}

  wrap.innerHTML = `
    <form id="secret-form" class="card">
      <div class="row">
        <label>Service
          <select name="service">${options}</select>
        </label>
      </div>
      <div class="row">
        <label>Scope
          <select name="scope">${scopeOptions}</select>
        </label>
      </div>
      <div class="row">
        <label>Value
          <span class="masked-input">
            <input name="value" type="password" autocomplete="off" placeholder="paste or type secret" />
            <button type="button" class="icon-btn" id="unmask" title="Show/hide">👁</button>
          </span>
        </label>
      </div>
      <p class="muted small">Value is sent to sbx over stdin and never stored or echoed back.</p>
      <div class="row actions">
        <button type="submit" class="btn">Save</button>
        <button type="button" class="btn ghost" id="cancel-secret">Cancel</button>
      </div>
      <p id="secret-error" class="error"></p>
    </form>`;

  const input = wrap.querySelector('input[name="value"]');
  wrap.querySelector("#unmask").addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
  });
  wrap.querySelector("#cancel-secret").addEventListener("click", () => {
    wrap.innerHTML = "";
  });
  wrap.querySelector("#secret-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const service = fd.get("service");
    const value = fd.get("value");
    const scope = fd.get("scope");
    const err = wrap.querySelector("#secret-error");
    err.textContent = "";
    if (!value) {
      err.textContent = "Enter a value.";
      return;
    }
    const res = await fetch("/api/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service, value, scope }),
    });
    const data = await res.json();
    if (!res.ok) {
      err.textContent = data.error || "Failed to set secret.";
      return;
    }
    wrap.innerHTML = "";
    loadSecrets();
  });
}

async function removeSecret(service, scope) {
  const label = scope === "__global__" ? "Global" : scope;
  const okRemove = await confirmDialog({
    title: "Remove secret?",
    message: `Remove secret "${service}" from ${label}?`,
    confirmLabel: "Remove", danger: true,
  });
  if (!okRemove) return;
  const res = await fetch("/api/secrets", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service, scope }),
  });
  if (res.ok) loadSecrets();
  else {
    const data = await res.json().catch(() => ({}));
    showFlash(data.error || "Failed to remove secret.", "error");
  }
}

// --- Boot -------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  initTheme();
  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  document
    .getElementById("change-context")
    .addEventListener("click", showLanding);
  initNav();
  loadSandboxes();
});

// --- Egress view (merged rules + observed traffic) --------------------------
const METADATA_HOSTS = ["169.254.169.254", "metadata.google.internal"];
function isSensitive(host) {
  return METADATA_HOSTS.some((h) => host.startsWith(h));
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function bareScope(scope) {
  const s = scope || "";
  return s.startsWith("sandbox:") ? s.slice("sandbox:".length) : s;
}

// Classify a rule into Source label + lock + tooltip.
function ruleSource(r) {
  const createdVia = (r.provenance && r.provenance.created_via) || "";
  if (!r.editable) {
    const kitName = (r.name || "").startsWith("kit:") ? r.name.slice(4) : "";
    let tip = "Read-only: managed rule";
    if (createdVia === "default") tip = "Read-only: built-in default rule";
    else if (r.origin === "org") tip = "Read-only: organization policy";
    else if (kitName) tip = `Read-only: kit rule '${kitName}'`;
    else tip = "Read-only: kit rule";
    return { label: "Managed", locked: true, tip };
  }
  return { label: "Local", locked: false, tip: "" };
}

// Client-side view state for the egress table. egressRows holds the full,
// unfiltered row model from the last load; egressFilter is the active
// case-insensitive substring filter (empty = show everything).
let egressRows = [];
let egressFilter = "";
// Quick state filter: "" | "allowed" | "blocked" | "denied". Combines (AND)
// with the text filter. Mutually exclusive — only one can be active at a time.
let egressStateFilter = "";

async function renderEgress() {
  const content = document.getElementById("content");
  const label = activeContext === "__global__" ? "Global" : activeContext;
  content.innerHTML = `
    <div class="section-head">
      <h2>Egress — ${label}</h2>
      <div class="actions">
        <button id="eg-add" class="btn">+ Add host…</button>
        <button id="eg-check" class="btn ghost">Check…</button>
      </div>
    </div>
    <div id="eg-flash"></div>
    <div id="eg-form-wrap"></div>
    <div class="eg-toolbar">
      <div class="eg-toolbar-left">
        <div class="eg-filter-wrap">
          <input id="eg-filter" type="search" class="eg-filter" placeholder="Filter rules…"
                 aria-label="Filter rules by substring" autocomplete="off" />
          <button type="button" id="eg-filter-clear" class="eg-filter-clear hidden"
                  aria-label="Clear filter" title="Clear filter (Esc)">×</button>
        </div>
        <div class="segmented" role="group" aria-label="Quick filter by state">
          <button type="button" class="seg eg-quick" data-state="allowed">Allowed</button>
          <button type="button" class="seg eg-quick" data-state="blocked">Blocked</button>
          <button type="button" class="seg eg-quick" data-state="denied">Denied</button>
        </div>
      </div>
      <span id="eg-filterinfo" class="filter-status"></span>
    </div>
    <div id="eg-bulkbar" class="bulk-bar hidden">
      <span id="eg-selinfo" class="bulk-count"></span>
      <div class="bulk-actions">
        <button id="eg-sel-allow" class="btn ghost small-btn" disabled>Allow selected</button>
        <button id="eg-sel-deny" class="btn ghost small-btn" disabled>Deny selected</button>
        <button id="eg-sel-remove" class="btn ghost small-btn danger-btn" disabled>Remove selected</button>
      </div>
    </div>
    <div id="eg-body"><p class="muted">Loading…</p></div>
  `;
  content.querySelector("#eg-add").addEventListener("click", showAddHostForm);
  content.querySelector("#eg-check").addEventListener("click", showCheckForm);
  // Filtering is purely client-side over the already-fetched rows, so typing
  // re-renders the table without refetching. Preserve the box's value across
  // table re-renders via the module-level egressFilter.
  const filterEl = content.querySelector("#eg-filter");
  const clearBtn = content.querySelector("#eg-filter-clear");
  filterEl.value = egressFilter;
  // Quick state filters: toggle on click, mutually exclusive, re-click clears.
  const quickBtns = [...content.querySelectorAll(".eg-quick")];
  const syncQuick = () =>
    quickBtns.forEach((b) => b.classList.toggle("active", b.dataset.state === egressStateFilter));
  // Interacting with the text filter deactivates any active quick filter.
  const clearQuick = () => {
    if (egressStateFilter) { egressStateFilter = ""; syncQuick(); }
  };
  // The clear (×) button only shows when there's text to clear.
  const syncClearBtn = () => clearBtn.classList.toggle("hidden", filterEl.value === "");
  // Single path all text-filter changes funnel through.
  const applyTextFilter = () => {
    egressFilter = filterEl.value;
    clearQuick();
    syncClearBtn();
    renderEgressTable(document.getElementById("eg-body"), egressRows);
  };
  filterEl.addEventListener("input", applyTextFilter);
  filterEl.addEventListener("focus", () => {
    if (egressStateFilter) {
      clearQuick();
      renderEgressTable(document.getElementById("eg-body"), egressRows);
    }
  });
  // Esc clears while the field is focused (standard search-box behavior).
  filterEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && filterEl.value !== "") {
      e.preventDefault();
      filterEl.value = "";
      applyTextFilter();
    }
  });
  // Custom clear button: empty, re-render, keep focus in the field.
  clearBtn.addEventListener("click", () => {
    filterEl.value = "";
    applyTextFilter();
    filterEl.focus();
  });
  syncClearBtn();
  quickBtns.forEach((b) =>
    b.addEventListener("click", () => {
      egressStateFilter = egressStateFilter === b.dataset.state ? "" : b.dataset.state;
      syncQuick();
      renderEgressTable(document.getElementById("eg-body"), egressRows);
    }));
  syncQuick();
  // Bind the bulk-action bar buttons ONCE here — they persist across
  // table re-renders, so binding them in wireSelection() (per render) would
  // stack listeners and fire applyGroup multiple times per click.
  content.querySelector("#eg-sel-allow").addEventListener("click", () => applyGroup("allow"));
  content.querySelector("#eg-sel-deny").addEventListener("click", () => applyGroup("deny"));
  content.querySelector("#eg-sel-remove").addEventListener("click", () => applyGroup("remove"));
  loadEgress();
}

// Fetch rules + log together and build the merged, host-keyed row model.
async function loadEgress() {
  const body = document.getElementById("eg-body");
  const scope = encodeURIComponent(currentScopeParam());
  try {
    const [rulesRes, logRes] = await Promise.all([
      fetch(`/api/egress?scope=${scope}`),
      fetch(`/api/egress/log?scope=${scope}`),
    ]);
    const rulesData = await rulesRes.json();
    const logData = await logRes.json().catch(() => ({ blocked: [], allowed: [] }));
    if (!rulesRes.ok) {
      body.innerHTML = `<p class="muted">Could not list rules: ${rulesData.error || rulesRes.status}</p>`;
      return;
    }
    const rows = buildRows(rulesData.rules || [], logData.blocked || [], logData.allowed || []);
    egressRows = rows;
    renderEgressTable(body, rows);
  } catch (e) {
    body.innerHTML = `<p class="muted">Failed to load egress data.</p>`;
  }
}

// Merge model:
//  - expand each rule's resources[] into a per-host row (STATE from decision,
//    SOURCE from ruleSource, selectable iff Local)
//  - log entries (blocked/allowed) attach their SEEN data to a COVERING rule
//    row when one exists; otherwise they become their own "Policy log" row.
//  - duplicate proxy paths for the same destination collapse (summed count).
//
// Coverage (conservative — only certain matches merge; sbx's authorizer is the
// source of truth for the rest, so ambiguous cases stay as separate rows):
//   - exact string match
//   - a bare-host rule covers an observed host:port  (example.com ⊇ example.com:443)
//   - a simple suffix wildcard covers a subdomain     (*.kiro.dev / **.kiro.dev ⊇ cli.kiro.dev)
// NOT merged (left as separate rows): CIDR, char-classes, globs.
function stripPort(h) {
  if (h.startsWith("[")) return h; // IPv6 literal — leave as-is
  const i = h.lastIndexOf(":");
  return i === -1 ? h : h.slice(0, i);
}
function ruleCoversHost(ruleRes, obsHost) {
  if (ruleRes === obsHost) return true;
  // bare-host rule covers host:port
  if (ruleRes === stripPort(obsHost)) return true;
  // simple suffix wildcard: *.dom or **.dom
  const m = ruleRes.match(/^\*{1,2}\.(.+)$/);
  if (m) {
    const base = m[1];
    const obsBare = stripPort(obsHost);
    if (obsBare === base) return true;
    if (obsBare.endsWith("." + base)) return true;
  }
  return false;
}

function buildRows(rules, blocked, allowed) {
  const rows = [];

  // 1) configured rules → one row per RULE (not per resource). A rule holding
  // >1 resource is a "bundle" rendered as a single row; the rule is the unit of
  // management (allow/deny/remove act on the whole bundle, matching sbx storage
  // and `rm --id`). `hosts` is the full resource list; `host` is the primary
  // (first) host used for the display cell and text-filter matching.
  rules.forEach((r) => {
    const src = ruleSource(r);
    const state = r.decision === "allow" ? "allowed" : "blocked";
    const denied = r.decision === "deny"; // explicit deny decision, not default
    const hosts = Array.isArray(r.resources) ? r.resources.slice() : [];
    if (hosts.length === 0) return;
    rows.push({
      host: hosts[0], hosts, bundle: hosts.length > 1,
      state, denied, scope: bareScope(r.scope), ruleId: r.id, source: src,
      selectable: !src.locked, seenCount: 0, seenLast: "", proxies: {},
      // per-host SEEN totals for bundles, surfaced only in the info dialog.
      seenByHost: {},
    });
  });

  // Attach a log observation to a covering rule row, or create a Policy-log row.
  // Only CONFIGURED rule rows are merge targets (they have a ruleId); never fold
  // one log observation into another log row via coverage.
  //
  // Precompute the rule-row lookups ONCE (not per log entry): an exact host→row
  // map for the common case, and the list of rule rows for the rare coverage
  // fallback. Doing this inside attach() re-filtered `rows` on every entry,
  // which is O(log × rules) with a fresh allocation each call — slow on busy
  // sandboxes with many observations.
  const ruleRows = rows.filter((row) => row.ruleId !== null);
  // Index EVERY host of every rule row (a bundle owns all of its hosts), so an
  // observation for any host in a bundle folds into that bundle's single row.
  const ruleRowByHost = new Map();
  ruleRows.forEach((row) => (row.hosts || [row.host]).forEach((h) => {
    if (!ruleRowByHost.has(h)) ruleRowByHost.set(h, row);
  }));
  const logRowsByHost = new Map();
  const attach = (e, observedState) => {
    // Prefer an exact host match (e.g. the allow rule you just created for the
    // same host:port) over a broader cover, so an observation never spawns a
    // duplicate row alongside its own rule. Fall back to conservative coverage
    // against any host in a rule (bundles cover all of their hosts).
    const covering =
      ruleRowByHost.get(e.host) ||
      ruleRows.find((row) => (row.hosts || [row.host]).some((h) => ruleCoversHost(h, e.host)));
    let target;
    if (covering) {
      target = covering; // SEEN rolls up into the owning rule row
    } else {
      // standalone "Policy log" row, keyed by host so duplicates collapse
      if (!logRowsByHost.has(e.host)) {
        const row = {
          host: e.host, hosts: [e.host], bundle: false, state: observedState,
          scope: bareScope(e.vm_name ? `sandbox:${e.vm_name}` : ""),
          ruleId: null,
          source: { label: "Policy log", locked: false,
                    tip: observedState === "blocked"
                      ? "Seen in policy log; no matching allow rule"
                      : "Seen in policy log; allowed by proxy" },
          selectable: observedState === "blocked", // blocked log rows → Allow
          seenCount: 0, seenLast: "", proxies: {}, seenByHost: {},
        };
        logRowsByHost.set(e.host, row);
        rows.push(row);
      }
      target = logRowsByHost.get(e.host);
    }
    target.seenCount += e.count_since || 0;
    // Per-host SEEN total (shown only in the Host Bundle info dialog).
    if (target.seenByHost) target.seenByHost[e.host] = (target.seenByHost[e.host] || 0) + (e.count_since || 0);
    if (e.last_seen && (!target.seenLast || e.last_seen > target.seenLast)) target.seenLast = e.last_seen;
    if (e.proxy_type) target.proxies[e.proxy_type] = (target.proxies[e.proxy_type] || 0) + (e.count_since || 0);
  };

  blocked.forEach((e) => attach(e, "blocked"));
  allowed.forEach((e) => attach(e, "allowed"));

  // Sort: blocked first (actionable), then by seenCount desc, then host.
  return rows.sort((a, b) => {
    if (a.state !== b.state) return a.state === "blocked" ? -1 : 1;
    if (b.seenCount !== a.seenCount) return b.seenCount - a.seenCount;
    return a.host.localeCompare(b.host);
  });
}

function stateBadge(row) {
  if (row.state === "allowed") return `<span class="badge allow">Allowed</span>`;
  if (row.denied) return `<span class="badge deny">Denied</span>`;
  return `<span class="badge deny">Blocked</span>`;
}
function seenCell(row) {
  if (!row.seenCount) return "—";
  const detail = Object.entries(row.proxies)
    .map(([p, c]) => `${p}: ${c}`).join(", ");
  const tip = `${detail}${row.seenLast ? ` · last ${row.seenLast}` : ""}`;
  return `<span title="${tip}">${fmtTime(row.seenLast)} · ${row.seenCount}×</span>`;
}

function renderEgressTable(body, rows) {
  // Case-insensitive substring filter over the host; empty filter shows all.
  const q = egressFilter.trim().toLowerCase();
  // Quick state filter maps onto the row model: Blocked excludes explicit
  // denies (those surface under Denied).
  const stateMatch = (r) => {
    if (!egressStateFilter) return true;
    if (egressStateFilter === "allowed") return r.state === "allowed";
    if (egressStateFilter === "denied") return r.denied === true;
    return r.state === "blocked" && !r.denied; // "blocked"
  };
  const visible = rows.filter((r) =>
    (q ? (r.hosts || [r.host]).some((h) => h.toLowerCase().includes(q)) : true) && stateMatch(r));

  // Status chip: only shown (via .is-active) while a filter is active.
  const info = document.getElementById("eg-filterinfo");
  const filtering = q || egressStateFilter;
  if (info) {
    info.classList.toggle("is-active", !!filtering);
    info.textContent = filtering ? `🔍 Viewing ${visible.length} of ${rows.length} rules` : "";
  }

  if (rows.length === 0) {
    body.innerHTML = `<p class="muted">No egress rules or observed traffic for this scope.</p>`;
    return;
  }
  if (visible.length === 0) {
    body.innerHTML = `<p class="muted">No rules match the active filter.</p>`;
    return;
  }
  const table = document.createElement("table");
  table.className = "secret-table rules-table";
  table.innerHTML = `
    <thead><tr>
      <th class="chk"><input type="checkbox" id="eg-selall" title="Select all selectable rows" /></th>
      <th>Host</th><th>State</th><th>Scope</th><th>Seen</th><th>Source</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  visible.forEach((row) => {
    const hosts = row.hosts && row.hosts.length ? row.hosts : [row.host];
    const bundle = row.bundle && hosts.length > 1;
    // A bundle's checkbox carries ALL hosts (comma-joined) so Allow/Deny act on
    // the whole rule as a unit; single-host rows carry just the one host.
    const allHosts = hosts.join(",");
    // Sensitivity marker if ANY host in the bundle is sensitive.
    const warn = hosts.some(isSensitive)
      ? ` <span class="warn" title="Sensitive: cloud metadata / SSRF endpoint — allowing is risky">⚠</span>` : "";
    const chk = row.selectable
      ? `<input type="checkbox" class="eg-rowchk" data-host="${allHosts}" data-state="${row.state}" data-ruleid="${row.ruleId || ""}" data-scope="${row.scope || ""}" data-source="${row.source.label}" />`
      : "";
    const src = row.source || { label: "", locked: false, tip: "" };
    const lock = src.locked ? "🔒 " : "";
    const tr = document.createElement("tr");
    const isWildcard = /[*?\[]/.test(row.host);
    // Policy-log rows (observed traffic, no configured rule) get a row marker
    // and an explanatory tooltip on the host.
    const isLog = row.ruleId === null;
    if (isLog) tr.className = "log-row";
    else if (bundle) tr.className = "bundle-row";
    const hostTip = isLog ? ` title="Parsed from egress logs — observed traffic, not a configured rule"` : "";
    if (bundle) {
      // Bundle: show the first host, then a "(+N more)" link opening the Host
      // Bundle dialog. Primary host via textContent-safe DOM to avoid injection.
      const bundleTip = `Bundled rule — ${hosts.length} hosts; click to view all`;
      tr.innerHTML = `
        <td class="chk">${chk}</td>
        <td class="domain bundle-host"></td>
        <td>${stateBadge(row)}</td>
        <td>${row.scope || ""}</td>
        <td>${seenCell(row)}</td>
        <td ${src.tip ? `title="${src.tip}"` : ""}>${lock}${src.label}</td>`;
      const cell = tr.querySelector(".bundle-host");
      cell.title = bundleTip;
      const primary = document.createElement("span");
      primary.className = "bundle-primary";
      primary.textContent = hosts[0];
      cell.appendChild(primary);
      if (hosts.some(isSensitive)) {
        const w = document.createElement("span");
        w.className = "warn";
        w.title = "Sensitive: cloud metadata / SSRF endpoint — allowing is risky";
        w.textContent = " ⚠";
        cell.appendChild(w);
      }
      const more = document.createElement("button");
      more.type = "button";
      more.className = "bundle-more link-btn";
      more.textContent = ` (+${hosts.length - 1} more)`;
      more.addEventListener("click", () => showBundleDialog(row));
      cell.appendChild(more);
    } else {
      tr.innerHTML = `
        <td class="chk">${chk}</td>
        <td class="domain${isWildcard ? " wildcard" : ""}"${hostTip}>${row.host}${warn}</td>
        <td>${stateBadge(row)}</td>
        <td>${row.scope || ""}</td>
        <td>${seenCell(row)}</td>
        <td ${src.tip ? `title="${src.tip}"` : ""}>${lock}${src.label}</td>`;
    }
    tbody.appendChild(tr);
  });

  body.innerHTML = "";
  body.appendChild(table);
  wireSelection();
}

// Enable toolbar; each action applies only to rows where it's valid, and
// reports what it skipped.
function wireSelection() {
  const btnAllow = document.getElementById("eg-sel-allow");
  const btnDeny = document.getElementById("eg-sel-deny");
  const btnRemove = document.getElementById("eg-sel-remove");
  const info = document.getElementById("eg-selinfo");
  const bulkbar = document.getElementById("eg-bulkbar");
  const selAll = document.getElementById("eg-selall");
  const boxes = () => [...document.querySelectorAll(".eg-rowchk")];

  const refresh = () => {
    const checked = boxes().filter((b) => b.checked);
    const any = checked.length > 0;
    // Contextual bulk bar: only present once at least one row is selected.
    if (bulkbar) bulkbar.classList.toggle("hidden", !any);
    // Policy-log rows (observed traffic) have no rule id — they are not
    // removable. If any checked row is one, Remove is disabled (Allow/Deny OK).
    const hasLog = checked.some((b) => !b.dataset.ruleid);
    btnAllow.disabled = !any;
    btnDeny.disabled = !any;
    btnRemove.disabled = !any || hasLog;
    btnRemove.title = hasLog
      ? "Can't remove observed traffic (policy log). Use Allow/Deny, or deselect those rows."
      : "Remove selected local rule(s)";
    info.textContent = `${checked.length} selected`;
  };

  boxes().forEach((b) => b.addEventListener("change", refresh));
  if (selAll) selAll.addEventListener("change", () => {
    boxes().forEach((b) => (b.checked = selAll.checked));
    refresh();
  });

  // NOTE: the Allow/Deny/Remove toolbar buttons are bound ONCE in renderEgress
  // (they persist across table re-renders). Binding them here would stack a new
  // listener on every loadEgress(), firing applyGroup N times per click.
  refresh();
}

// AWS-style dismissible flash banner. type: error|warning|success|info.
// Auto-fades after ~6s; manual × closes immediately. No deps.
// Renders into #eg-flash when present (egress panel); otherwise into a shared
// floating top-level container created lazily, so any view can call it.
let _flashFloat = null;
function showFlash(message, type = "info") {
  let wrap = document.getElementById("eg-flash");
  if (!wrap) {
    if (!_flashFloat) {
      _flashFloat = document.createElement("div");
      _flashFloat.id = "flash-float";
      document.body.appendChild(_flashFloat);
    }
    wrap = _flashFloat;
  }
  const el = document.createElement("div");
  el.className = `flash flash-${type}`;
  el.setAttribute("role", type === "error" || type === "warning" ? "alert" : "status");
  const icon = { error: "⛔", warning: "⚠", success: "✓", info: "ℹ" }[type] || "ℹ";
  el.innerHTML = `<span class="flash-icon">${icon}</span><span class="flash-msg"></span><button class="flash-close" aria-label="Dismiss">×</button>`;
  el.querySelector(".flash-msg").textContent = message; // textContent = no injection
  const close = () => { el.classList.add("flash-out"); setTimeout(() => el.remove(), 250); };
  el.querySelector(".flash-close").addEventListener("click", close);
  wrap.innerHTML = ""; // one flash at a time
  wrap.appendChild(el);
  setTimeout(close, 6000);
}

// Reusable themed modal confirm, replacing native confirm(). Returns a Promise
// that resolves true (confirmed) or false (cancelled/Esc/backdrop). Uses the
// native <dialog> element for a free backdrop, focus trap, and Esc handling.
// One dialog node is built lazily and reused across all callers.
//   await confirmDialog({ title, message, confirmLabel, cancelLabel, danger })
let _confirmDlg = null;
function confirmDialog(opts = {}) {
  const { title = "Confirm", message = "", confirmLabel = "Confirm",
          cancelLabel = "Cancel", danger = false } = opts;
  if (!_confirmDlg) {
    _confirmDlg = document.createElement("dialog");
    _confirmDlg.className = "confirm-dialog";
    _confirmDlg.innerHTML = `
      <form method="dialog" class="confirm-body">
        <h3 class="confirm-title"></h3>
        <p class="confirm-msg"></p>
        <div class="confirm-actions">
          <button value="cancel" class="btn ghost confirm-cancel"></button>
          <button value="ok" class="btn confirm-ok"></button>
        </div>
      </form>`;
    document.body.appendChild(_confirmDlg);
  }
  const dlg = _confirmDlg;
  dlg.querySelector(".confirm-title").textContent = title;
  dlg.querySelector(".confirm-msg").textContent = message; // textContent = no injection
  dlg.querySelector(".confirm-cancel").textContent = cancelLabel;
  const ok = dlg.querySelector(".confirm-ok");
  ok.textContent = confirmLabel;
  ok.classList.toggle("danger-btn", !!danger);

  return new Promise((resolve) => {
    let decided = false;
    const onClose = () => {
      dlg.removeEventListener("close", onClose);
      resolve(decided);
    };
    // The <form method="dialog"> sets returnValue to the clicked button's value;
    // Esc/backdrop close with empty returnValue → treated as cancel.
    dlg.addEventListener("close", () => { decided = dlg.returnValue === "ok"; }, { once: true });
    dlg.addEventListener("close", onClose, { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}

// Read-only info dialog (OK-only), reusing a lazily-built <dialog> node distinct
// from confirmDialog so the two don't fight over one node's structure.
//   infoDialog({ title, lines: string[] })  → resolves when dismissed.
let _infoDlg = null;
function infoDialog(opts = {}) {
  const { title = "Info", lines = [] } = opts;
  if (!_infoDlg) {
    _infoDlg = document.createElement("dialog");
    _infoDlg.className = "confirm-dialog info-dialog";
    _infoDlg.innerHTML = `
      <form method="dialog" class="confirm-body">
        <h3 class="confirm-title"></h3>
        <ul class="info-list"></ul>
        <div class="confirm-actions">
          <button value="ok" class="btn confirm-ok">OK</button>
        </div>
      </form>`;
    document.body.appendChild(_infoDlg);
  }
  const dlg = _infoDlg;
  dlg.querySelector(".confirm-title").textContent = title;
  const list = dlg.querySelector(".info-list");
  list.innerHTML = "";
  lines.forEach((ln) => {
    const li = document.createElement("li");
    li.textContent = ln; // textContent = no injection (hosts are untrusted-ish)
    list.appendChild(li);
  });
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(), { once: true });
    dlg.showModal();
  });
}

// Open the "Host Bundle" dialog for a bundle row: lists every host, with a
// per-host SEEN count appended when the policy log provided one.
function showBundleDialog(row) {
  const hosts = row.hosts && row.hosts.length ? row.hosts : [row.host];
  const seen = row.seenByHost || {};
  const lines = hosts.map((h) => {
    const c = seen[h];
    return c ? `${h}  —  seen ${c}×` : h;
  });
  infoDialog({ title: "Host Bundle", lines });
}


// sbx rejects a deny that targets a host already covered by an allow (same
// scope/protocol) with a message full of rule UUIDs; surface guidance instead.
// Returns a friendlier string, or null if we don't recognize the error.
function translateEgressError(action, hosts, raw) {
  if (!raw) return null;
  const hostList = hosts && hosts.length ? hosts.join(", ") : "that host";
  if (/conflicts with existing allow rule/i.test(raw)) {
    return `${hostList} is already allowed by an existing rule. ` +
           `To block it, select its row and use “Remove selected” to delete the allow — ` +
           `a deny can’t override an allow for the same host at the same scope.`;
  }
  if (/conflicts with existing deny rule/i.test(raw)) {
    return `${hostList} is already denied by an existing rule. ` +
           `To allow it, remove the deny first.`;
  }
  return null;
}

async function applyGroup(action) {
  const checked = [...document.querySelectorAll(".eg-rowchk")].filter((b) => b.checked);

  if (action === "remove") {
    // Option A: a selection that mixes Local rules with Policy-log observations
    // is ambiguous. Refuse the whole batch and tell the user plainly — the
    // Remove button is also disabled live, so this is the safety net.
    const logRows = checked.filter((b) => !b.dataset.ruleid);
    if (logRows.length) {
      showFlash(
        `${logRows.length} selected row(s) are observed traffic (policy log), not removable rules. ` +
        `Use Allow/Deny on those, or deselect them.`, "warning");
      return;
    }
    // All selected rows are Local rules. Preserve each rule's scope so
    // sandbox-scoped rules get --sandbox (global --id lookup fails for them).
    const byId = new Map();
    checked.forEach((b) => {
      if (!byId.has(b.dataset.ruleid)) {
        const sc = b.dataset.scope;
        byId.set(b.dataset.ruleid, sc && sc !== "global" ? sc : "__global__");
      }
    });
    const ids = [...byId.keys()];
    if (ids.length === 0) { showFlash("Nothing selected to remove.", "info"); return; }
    const okRemove = await confirmDialog({
      title: "Remove rule(s)?",
      message: `Remove ${ids.length} local rule(s)? A rule bundling multiple hosts removes all of them.`,
      confirmLabel: "Remove", danger: true,
    });
    if (!okRemove) return;
    let ok = 0;
    const errors = [];
    for (const id of ids) {
      const res = await fetch("/api/egress", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, scope: byId.get(id) }) });
      if (res.ok) ok++;
      else {
        const d = await res.json().catch(() => ({}));
        errors.push(d.error || `rule ${id}: HTTP ${res.status}`);
      }
    }
    if (errors.length) showFlash(`Removed ${ok}/${ids.length}. Failed: ${errors.join("; ")}`, "error");
    else showFlash(`Removed ${ok} rule(s).`, "success");
    loadEgress();
    return;
  }

  // allow / deny: act on the host list. Each checkbox's data-host may itself be
  // a comma-joined bundle, so flatten to the full host set for the API call and
  // for sensitivity checks.
  const hostField = checked.map((b) => b.dataset.host).filter(Boolean);
  const hosts = hostField.join(",").split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) return;
  const sensitive = hosts.filter(isSensitive);
  if (action === "allow" && sensitive.length) {
    const okAllow = await confirmDialog({
      title: "Allow sensitive host(s)?",
      message: `${sensitive.join(", ")} are cloud metadata / SSRF-sensitive. Allowing can expose host credentials. Continue?`,
      confirmLabel: "Allow anyway", danger: true,
    });
    if (!okAllow) return;
  }

  // Deny, rule-as-unit: a selected row that is CURRENTLY an allow rule (configured,
  // state allowed, has a rule id) can't be denied directly — sbx refuses with
  // "conflicts with existing allow rule". Flip the whole rule atomically: remove
  // the allow rule(s), then create the deny for the same host set. Confirm the
  // destructive remove first; preserve the manual "remove it yourself" escape.
  if (action === "deny") {
    const allowRules = checked.filter(
      (b) => b.dataset.ruleid && b.dataset.state === "allowed");
    if (allowRules.length) {
      const names = allowRules.map((b) => b.dataset.host).join(", ");
      const okFlip = await confirmDialog({
        title: "Block currently-allowed rule(s)?",
        message: `${names} ${allowRules.length > 1 ? "are" : "is"} currently allowed. ` +
          `Blocking will remove the existing allow rule${allowRules.length > 1 ? "s" : ""} ` +
          `and create a deny for the same host set. Continue?`,
        confirmLabel: "Remove allow & deny", danger: true,
      });
      if (!okFlip) return;
      // Remove each allow rule by its own id + scope (bundles removed whole).
      const removeErrors = [];
      for (const b of allowRules) {
        const sc = b.dataset.scope;
        const scope = sc && sc !== "global" ? sc : "__global__";
        const res = await fetch("/api/egress", {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: b.dataset.ruleid, scope }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          removeErrors.push(d.error || `rule ${b.dataset.ruleid}: HTTP ${res.status}`);
        }
      }
      if (removeErrors.length) {
        showFlash(`Could not remove existing allow rule(s): ${removeErrors.join("; ")}`, "error");
        loadEgress();
        return;
      }
    }
  }

  const path = action === "allow" ? "/api/egress/allow" : "/api/egress/deny";
  const resources = hosts.join(",");
  const doPost = () => fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: currentScopeParam(), resources }),
  });
  let res = await doPost();
  let data = await res.json().catch(() => ({}));
  if (res.ok) { showFlash(`${action === "allow" ? "Allowed" : "Denied"}: ${data.resources}`, "success"); loadEgress(); return; }

  // Deny still conflicting (e.g. an allow we didn't detect up-front, such as a
  // broader covering rule): surface actionable guidance rather than raw stderr.
  const friendly = translateEgressError(action, hosts, data.error);
  showFlash(friendly || data.error || `${action} failed.`, friendly ? "warning" : "error");
  loadEgress();
}

// + Add host form (accepts domains, wildcards, IPs, CIDR, IPv6, ports).
function showAddHostForm() {
  const wrap = document.getElementById("eg-form-wrap");
  wrap.innerHTML = `
    <form id="eg-add-form" class="card">
      <div class="row">
        <label>Host(s) — comma-separated (domains, IPs, CIDR, IPv6, ports)
          <input name="resources" type="text" placeholder="api.example.com:443, 10.0.0.0/24, *.npmjs.org, [2001:db8::1]/128" />
        </label>
      </div>
      <div class="row">
        <label>Protocol
          <select name="protocol">
            <option value="">tcp (default)</option>
            <option value="udp">udp</option>
            <option value="tcp,udp">tcp,udp</option>
          </select>
        </label>
      </div>
      <div class="row actions">
        <button type="button" class="btn" data-decision="allow">Add allow</button>
        <button type="button" class="btn ghost" data-decision="deny">Add deny</button>
        <button type="button" class="btn ghost" id="eg-add-cancel">Cancel</button>
      </div>
      <p id="eg-add-error" class="error"></p>
    </form>`;
  const form = wrap.querySelector("#eg-add-form");
  const err = form.querySelector("#eg-add-error");
  form.querySelector("#eg-add-cancel").addEventListener("click", () => (wrap.innerHTML = ""));
  form.querySelectorAll("button[data-decision]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const resources = form.resources.value.trim();
      const protocol = form.protocol.value || null;
      if (!resources) { err.textContent = "Enter at least one host."; return; }
      const path = btn.dataset.decision === "allow" ? "/api/egress/allow" : "/api/egress/deny";
      const res = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: currentScopeParam(), resources, protocol }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { wrap.innerHTML = ""; loadEgress(); }
      else {
        const hosts = resources.split(",").map((h) => h.trim()).filter(Boolean);
        err.textContent = translateEgressError(btn.dataset.decision, hosts, data.error) || data.error || "Failed.";
      }
    });
  });
}

function showCheckForm() {
  const wrap = document.getElementById("eg-form-wrap");
  wrap.innerHTML = `
    <form id="eg-check-form" class="card">
      <div class="row">
        <label>Host to check
          <input name="host" type="text" placeholder="api.example.com:443" />
        </label>
      </div>
      <div class="row actions">
        <button type="submit" class="btn">Check</button>
        <button type="button" class="btn ghost" id="eg-check-cancel">Cancel</button>
      </div>
      <p id="eg-check-result" class="muted small"></p>
    </form>`;
  const form = wrap.querySelector("#eg-check-form");
  const out = form.querySelector("#eg-check-result");
  form.querySelector("#eg-check-cancel").addEventListener("click", () => (wrap.innerHTML = ""));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const host = form.host.value.trim();
    if (!host) { out.textContent = "Enter a host."; return; }
    const res = await fetch("/api/egress/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: currentScopeParam(), host }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) out.textContent = `${host}: ${data.allowed ? "ALLOWED" : "BLOCKED"}${data.output ? " — " + data.output : ""}`;
    else out.textContent = data.error || "Check failed.";
  });
}
