// Privacy screen. Surfaces what the privacy() scan finds — browser caches,
// cookies & history, and mail residue — grouped into checkable lists. Risky
// (personal) findings start unchecked and are flagged so a sweep never wipes
// something personal by accident. "Clean selected" runs clean(paths, false).

import type { Api } from "../api";
import type { Finding } from "../types";
import { formatBytes } from "../components";

type GroupId = "browser" | "cookies" | "mail";

interface Group {
  id: GroupId;
  title: string;
  blurb: string;
  findings: Finding[];
}

const GROUP_META: Record<GroupId, { title: string; blurb: string }> = {
  browser: {
    title: "Browser caches",
    blurb: "Cached pages, images and service-worker data. Safe to clear.",
  },
  cookies: {
    title: "Cookies & history",
    blurb: "Sign-in cookies and browsing history. Clearing signs you out.",
  },
  mail: {
    title: "Mail",
    blurb: "Mail caches, downloads and attachment residue.",
  },
};

const GROUP_ORDER: GroupId[] = ["browser", "cookies", "mail"];

export function renderPrivacy(root: HTMLElement, api: Api): void {
  const el = document.createElement("div");
  el.className = "screen screen-privacy pv";
  el.innerHTML = template();
  root.appendChild(el);

  const body = el.querySelector(".pv-body") as HTMLElement;
  const footer = el.querySelector(".pv-footer") as HTMLElement;
  const summaryEl = el.querySelector(".pv-summary") as HTMLElement;
  const cleanBtn = el.querySelector(".pv-clean") as HTMLButtonElement;
  const rescanBtn = el.querySelector(".pv-rescan") as HTMLButtonElement;

  // path -> checkbox state, keyed so re-renders keep selections.
  const selected = new Set<string>();
  let groups: Group[] = [];
  let busy = false;

  rescanBtn.addEventListener("click", () => void load());
  cleanBtn.addEventListener("click", () => void cleanSelected());

  function showLoading(): void {
    footer.hidden = true;
    body.innerHTML = `
      <div class="pv-state">
        <div class="pv-spinner" role="status" aria-label="Scanning"></div>
        <p>Scanning privacy traces…</p>
      </div>`;
  }

  function showError(message: string): void {
    footer.hidden = true;
    body.innerHTML = `
      <div class="pv-state pv-state-error">
        <div class="pv-state-icon">${ICON_ALERT}</div>
        <h3>Couldn't complete the privacy scan</h3>
        <p>${escapeHtml(message)}</p>
      </div>`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "pv-btn pv-btn-primary";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => void load());
    (body.querySelector(".pv-state") as HTMLElement).appendChild(retry);
  }

  function showEmpty(): void {
    footer.hidden = true;
    body.innerHTML = `
      <div class="pv-state pv-state-empty">
        <div class="pv-state-icon">${ICON_SHIELD}</div>
        <h3>Nothing to clear</h3>
        <p>No browser, cookie or mail traces were found. You're clean.</p>
      </div>`;
  }

  async function load(): Promise<void> {
    if (busy) return;
    selected.clear();
    showLoading();
    try {
      const findings = await api.privacy();
      groups = groupFindings(findings);
      if (groups.every((g) => g.findings.length === 0)) {
        showEmpty();
        return;
      }
      // Non-risky items are pre-selected; risky (personal) ones start off.
      for (const g of groups) {
        for (const f of g.findings) if (!f.risky) selected.add(f.path);
      }
      renderGroups();
    } catch (err) {
      showError(errorMessage(err));
    }
  }

  function renderGroups(): void {
    body.innerHTML = "";
    for (const id of GROUP_ORDER) {
      const group = groups.find((g) => g.id === id);
      if (!group || group.findings.length === 0) continue;
      body.appendChild(renderGroup(group));
    }
    footer.hidden = false;
    syncFooter();
  }

  function renderGroup(group: Group): HTMLElement {
    const total = group.findings.reduce((s, f) => s + f.size, 0);
    const section = document.createElement("section");
    section.className = "pv-group";

    const head = document.createElement("div");
    head.className = "pv-group-head";
    head.innerHTML = `
      <button type="button" class="pv-selectall" aria-label="Toggle all in ${escapeHtml(
        group.title
      )}"></button>
      <div class="pv-group-meta">
        <h3>${escapeHtml(group.title)}</h3>
        <p>${escapeHtml(group.blurb)}</p>
      </div>
      <span class="pv-group-size">${formatBytes(total)}</span>`;
    section.appendChild(head);

    const selectAll = head.querySelector(".pv-selectall") as HTMLButtonElement;
    const list = document.createElement("div");
    list.className = "pv-list";

    for (const finding of group.findings) {
      list.appendChild(renderRow(finding, syncSelectAll));
    }
    section.appendChild(list);

    selectAll.addEventListener("click", () => {
      const allOn = group.findings.every((f) => selected.has(f.path));
      for (const f of group.findings) {
        if (allOn) selected.delete(f.path);
        else selected.add(f.path);
      }
      list.querySelectorAll<HTMLElement>(".pv-row").forEach((row) => {
        const path = row.dataset.path as string;
        applyRowState(row, selected.has(path));
      });
      syncSelectAll();
      syncFooter();
    });

    function syncSelectAll(): void {
      const on = group.findings.filter((f) => selected.has(f.path)).length;
      const state =
        on === 0 ? "off" : on === group.findings.length ? "on" : "mixed";
      selectAll.dataset.state = state;
      selectAll.innerHTML = state === "off" ? "" : ICON_CHECK;
    }
    syncSelectAll();

    return section;
  }

  function renderRow(
    finding: Finding,
    onChange: () => void
  ): HTMLElement {
    const row = document.createElement("label");
    row.className = "pv-row";
    row.dataset.path = finding.path;
    if (finding.risky) row.classList.add("pv-row-personal");

    const checked = selected.has(finding.path);
    const noteBits: string[] = [];
    if (finding.note) noteBits.push(escapeHtml(finding.note));
    if (finding.stale) noteBits.push("stale");

    row.innerHTML = `
      <span class="pv-check" data-on="${checked}">${
      checked ? ICON_CHECK : ""
    }</span>
      <span class="pv-row-main">
        <span class="pv-row-name" title="${escapeHtml(finding.path)}">${escapeHtml(
      friendlyName(finding.path)
    )}</span>
        <span class="pv-row-sub">
          <span class="pv-row-path">${escapeHtml(shortenPath(finding.path))}</span>
          ${
            finding.risky
              ? `<span class="pv-tag pv-tag-personal">Personal</span>`
              : ""
          }
          ${noteBits.length ? `<span class="pv-row-note">${noteBits.join(" · ")}</span>` : ""}
        </span>
      </span>
      <span class="pv-row-size">${formatBytes(finding.size)}</span>`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "pv-visually-hidden";
    checkbox.checked = checked;
    row.prepend(checkbox);

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(finding.path);
      else selected.delete(finding.path);
      applyRowState(row, checkbox.checked);
      onChange();
      syncFooter();
    });

    return row;
  }

  function syncFooter(): void {
    const all = groups.flatMap((g) => g.findings);
    const chosen = all.filter((f) => selected.has(f.path));
    const bytes = chosen.reduce((s, f) => s + f.size, 0);
    const personal = chosen.filter((f) => f.risky).length;

    if (chosen.length === 0) {
      summaryEl.textContent = "Nothing selected";
    } else {
      const parts = [
        `${chosen.length} item${chosen.length === 1 ? "" : "s"} · ${formatBytes(
          bytes
        )}`,
      ];
      if (personal > 0)
        parts.push(`${personal} personal`);
      summaryEl.textContent = parts.join(" · ");
    }
    summaryEl.classList.toggle("pv-summary-warn", personal > 0);
    cleanBtn.disabled = busy || chosen.length === 0;
    cleanBtn.textContent = busy ? "Cleaning…" : "Clean selected";
  }

  async function cleanSelected(): Promise<void> {
    if (busy) return;
    const all = groups.flatMap((g) => g.findings);
    const chosen = all.filter((f) => selected.has(f.path));
    if (chosen.length === 0) return;

    const bytes = chosen.reduce((s, f) => s + f.size, 0);
    const personal = chosen.filter((f) => f.risky).length;
    const lines = [
      `Permanently clear ${chosen.length} item${
        chosen.length === 1 ? "" : "s"
      } (${formatBytes(bytes)})?`,
    ];
    if (personal > 0) {
      lines.push(
        `${personal} of these are personal (cookies, history or mail) — clearing them will sign you out and erase that data.`
      );
    }
    lines.push("This cannot be undone.");
    if (!confirm(lines.join("\n\n"))) return;

    busy = true;
    syncFooter();
    rescanBtn.disabled = true;
    try {
      const paths = chosen.map((f) => f.path);
      const result = await api.clean(paths, false);
      const freed = formatBytes(result.freed);
      if (result.failures > 0) {
        toast(
          `Cleared ${freed}, but ${result.failures} item${
            result.failures === 1 ? "" : "s"
          } couldn't be removed.`,
          "warn"
        );
      } else {
        toast(`Cleared ${freed} of privacy traces.`, "ok");
      }
    } catch (err) {
      toast(`Clean failed: ${errorMessage(err)}`, "danger");
    } finally {
      busy = false;
      rescanBtn.disabled = false;
      // Re-scan so the lists reflect what's actually left on disk.
      await load();
    }
  }

  void load();
}

function applyRowState(row: HTMLElement, on: boolean): void {
  const box = row.querySelector(".pv-check") as HTMLElement;
  const input = row.querySelector("input") as HTMLInputElement;
  box.dataset.on = String(on);
  box.innerHTML = on ? ICON_CHECK : "";
  input.checked = on;
}

function groupFindings(findings: Finding[]): Group[] {
  const buckets: Record<GroupId, Finding[]> = {
    browser: [],
    cookies: [],
    mail: [],
  };
  for (const f of findings) buckets[classify(f)].push(f);
  for (const id of GROUP_ORDER) {
    buckets[id].sort((a, b) => b.size - a.size);
  }
  return GROUP_ORDER.map((id) => ({
    id,
    title: GROUP_META[id].title,
    blurb: GROUP_META[id].blurb,
    findings: buckets[id],
  }));
}

// Sort each finding into one of the three privacy buckets. Cookies/history and
// mail win over the generic "browser caches" bucket so personal data is grouped
// where users expect it.
function classify(f: Finding): GroupId {
  const p = f.path.toLowerCase();
  const n = (f.note ?? "").toLowerCase();
  const hay = `${p} ${n}`;
  if (/mail|imap|smtp|outlook|thunderbird|\bv\d+\/mailbox/.test(hay)) {
    return "mail";
  }
  if (
    /cookie|history|\bwebkit\b.*storage|local storage|localstorage|sessionstorage|session storage|\bhistory\.|visited|autofill|login data|web data|places\.sqlite|formhistory/.test(
      hay
    )
  ) {
    return "cookies";
  }
  // Personal findings that didn't match a more specific bucket are most often
  // history/cookie data, so keep them out of the "safe" caches bucket.
  if (f.risky) return "cookies";
  return "browser";
}

function friendlyName(path: string): string {
  const segs = path.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length === 0) return path;
  const last = segs[segs.length - 1];
  const app = pickApp(segs);
  if (app && app.toLowerCase() !== last.toLowerCase()) return `${app} — ${last}`;
  return last;
}

function pickApp(segs: string[]): string | null {
  const known = [
    "Safari",
    "Google",
    "Chrome",
    "Firefox",
    "BraveSoftware",
    "Brave-Browser",
    "Microsoft Edge",
    "Arc",
    "Mail",
    "com.apple.mail",
  ];
  for (const seg of segs) {
    const match = known.find((k) => seg.toLowerCase().includes(k.toLowerCase()));
    if (match) return seg.replace(/^com\.apple\./, "").replace(/Software$/, "");
  }
  return null;
}

function shortenPath(path: string): string {
  const home = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (home) return `~${home[1] ?? ""}`;
  return path;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Lightweight toast: tries the shared host if present, otherwise paints its own
// transient banner so feedback never silently vanishes.
function toast(message: string, kind: "ok" | "warn" | "danger" = "ok"): void {
  let host = document.querySelector(".pv-toast-host") as HTMLElement | null;
  if (!host) {
    host = document.createElement("div");
    host.className = "pv-toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `pv-toast pv-toast-${kind}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("pv-toast-in"));
  setTimeout(() => {
    el.classList.remove("pv-toast-in");
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

const ICON_CHECK = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17.5 19 6.5"/></svg>`;

const ICON_SHIELD = `<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z"/><polyline points="9 12 11.2 14.2 15.5 9.6"/></svg>`;

const ICON_ALERT = `<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>`;

function template(): string {
  return `
    <style>${STYLES}</style>
    <header class="pv-header">
      <div class="pv-header-text">
        <h2>Privacy</h2>
        <p>Wipe the traces apps leave behind — caches, cookies, history and mail. Items marked <span class="pv-inline-personal">Personal</span> are left unchecked.</p>
      </div>
      <button type="button" class="pv-btn pv-btn-ghost pv-rescan">Re-scan</button>
    </header>
    <div class="pv-body"></div>
    <footer class="pv-footer" hidden>
      <span class="pv-summary">Nothing selected</span>
      <button type="button" class="pv-btn pv-btn-primary pv-clean" disabled>Clean selected</button>
    </footer>`;
}

const STYLES = `
.pv {
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: 100%;
  min-height: 0;
}
.pv-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}
.pv-header h2 { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
.pv-header p {
  margin: 6px 0 0;
  color: var(--text-dim);
  font-size: 13.5px;
  max-width: 60ch;
  line-height: 1.5;
}
.pv-inline-personal { color: var(--personal); font-weight: 600; }

.pv-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-right: 4px;
  margin-right: -4px;
}

.pv-group {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  overflow: hidden;
  animation: pv-rise var(--speed-slow, 240ms) var(--ease, ease) both;
}
@keyframes pv-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.pv-group-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--border);
}
.pv-group-meta { flex: 1; min-width: 0; }
.pv-group-meta h3 { margin: 0; font-size: 15px; }
.pv-group-meta p { margin: 3px 0 0; font-size: 12.5px; color: var(--text-dim); }
.pv-group-size {
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 600;
}

.pv-selectall, .pv-check {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--text-faint);
  display: grid;
  place-items: center;
  color: #fff;
  transition: background var(--speed, 180ms) var(--ease, ease),
    border-color var(--speed, 180ms) var(--ease, ease),
    transform var(--speed, 180ms) var(--ease, ease);
}
.pv-selectall { background: transparent; }
.pv-selectall[data-state="on"],
.pv-check[data-on="true"] {
  background: var(--accent-grad, linear-gradient(135deg, var(--accent), var(--accent-2)));
  border-color: transparent;
}
.pv-selectall[data-state="mixed"] {
  background: var(--accent-soft, rgba(124,92,255,0.16));
  border-color: var(--accent);
}
.pv-selectall[data-state="mixed"]::after {
  content: "";
  width: 9px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}
.pv-selectall:hover { transform: scale(1.08); }

.pv-list { display: flex; flex-direction: column; }
.pv-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 18px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--speed, 180ms) var(--ease, ease);
}
.pv-row:last-child { border-bottom: none; }
.pv-row:hover { background: var(--surface-2); }
.pv-check { cursor: pointer; }
.pv-row:active .pv-check { transform: scale(0.9); }

.pv-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.pv-row-name {
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pv-row-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.pv-row-path {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pv-row-note { font-size: 11px; color: var(--text-faint); white-space: nowrap; }
.pv-row-size {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  font-size: 13px;
}

.pv-row-personal .pv-row-name { color: var(--personal); }
.pv-tag {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 999px;
}
.pv-tag-personal {
  color: var(--personal);
  background: rgba(255, 138, 91, 0.14);
  border: 1px solid rgba(255, 138, 91, 0.3);
}

.pv-visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.pv-row:focus-within {
  outline: 2px solid var(--accent-ring, rgba(124,92,255,0.45));
  outline-offset: -2px;
  border-radius: 8px;
}

.pv-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
}
.pv-summary {
  font-size: 13.5px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.pv-summary-warn { color: var(--personal); }

.pv-btn {
  border: 1px solid transparent;
  border-radius: var(--radius);
  padding: 10px 18px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  font-family: inherit;
  transition: filter var(--speed, 180ms) var(--ease, ease),
    opacity var(--speed, 180ms) var(--ease, ease),
    transform var(--speed, 180ms) var(--ease, ease);
}
.pv-btn:active { transform: translateY(1px); }
.pv-btn-primary {
  background: var(--accent-grad, linear-gradient(90deg, var(--accent), var(--accent-2)));
}
.pv-btn-primary:hover { filter: brightness(1.08); }
.pv-btn-ghost { background: var(--surface-2); border-color: var(--border); }
.pv-btn-ghost:hover { filter: brightness(1.15); }
.pv-btn:disabled { opacity: 0.45; cursor: default; transform: none; filter: none; }

.pv-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
  color: var(--text-dim);
  padding: 48px 24px;
}
.pv-state h3 { margin: 4px 0 0; color: var(--text); font-size: 17px; }
.pv-state p { margin: 0; max-width: 42ch; line-height: 1.5; font-size: 13.5px; }
.pv-state .pv-btn { margin-top: 8px; }
.pv-state-icon { color: var(--text-faint); }
.pv-state-empty .pv-state-icon { color: var(--ok); }
.pv-state-error .pv-state-icon { color: var(--danger); }

.pv-spinner {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  animation: pv-spin 800ms linear infinite;
}
@keyframes pv-spin { to { transform: rotate(360deg); } }

.pv-toast-host {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 9999;
  pointer-events: none;
}
.pv-toast {
  pointer-events: auto;
  padding: 12px 18px;
  border-radius: var(--radius);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  font-size: 13.5px;
  color: var(--text);
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 200ms var(--ease, ease), transform 200ms var(--ease, ease);
}
.pv-toast-in { opacity: 1; transform: none; }
.pv-toast-ok { border-left: 3px solid var(--ok); }
.pv-toast-warn { border-left: 3px solid var(--warn); }
.pv-toast-danger { border-left: 3px solid var(--danger); }
`;
