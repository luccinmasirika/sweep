// Cleanup screen. Scans system caches, app caches, dev tools and Xcode, then
// presents each report as a collapsible card with a checkable list of findings.
// A master total drives "Clean selected", which re-confirms before removing
// anything and calls clean(selectedPaths, false). Risky findings start
// unchecked so a single sweep never trashes something it shouldn't.

import type { Api } from "../api";
import type { Finding, Report } from "../types";
import { button, formatBytes, spinner, toast } from "../components";

const TARGETS = ["system-caches", "app-caches", "dev-tools", "xcode"];

const TARGET_META: Record<string, { title: string; blurb: string; icon: string }> = {
  "system-caches": {
    title: "System Caches",
    blurb: "Temporary files the system rebuilds on demand",
    icon: iconCpu(),
  },
  "app-caches": {
    title: "Application Caches",
    blurb: "Per-app scratch data that apps recreate when needed",
    icon: iconApps(),
  },
  "dev-tools": {
    title: "Developer Tools",
    blurb: "Package manager and build tool caches",
    icon: iconTerminal(),
  },
  xcode: {
    title: "Xcode",
    blurb: "Derived data, archives and simulator leftovers",
    icon: iconHammer(),
  },
};

interface Row {
  finding: Finding;
  checked: boolean;
  input: HTMLInputElement;
  row: HTMLElement;
}

export function renderCleanup(root: HTMLElement, api: Api): void {
  injectStyles();

  const el = document.createElement("div");
  el.className = "screen screen-cleanup cl";
  el.innerHTML = `
    <header class="cl-head">
      <div>
        <h2 class="cl-title">Cleanup</h2>
        <p class="cl-sub">Reclaim space from caches and build artifacts. Safe items are pre-selected.</p>
      </div>
    </header>
    <div class="cl-body" data-body></div>
  `;
  root.appendChild(el);

  const body = el.querySelector<HTMLElement>("[data-body]")!;
  const rows: Row[] = [];
  let footer: HTMLElement | null = null;

  void load();

  async function load(): Promise<void> {
    rows.length = 0;
    body.innerHTML = "";
    body.appendChild(loadingState());

    let reports: Report[];
    try {
      reports = await api.scan(TARGETS);
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(errorState(message(err), () => void load()));
      return;
    }

    const withFindings = reports.filter((r) => r.findings.length > 0);
    body.innerHTML = "";

    if (withFindings.length === 0) {
      body.appendChild(emptyState());
      return;
    }

    for (const report of withFindings) {
      body.appendChild(buildCard(report));
    }

    footer = buildFooter();
    body.appendChild(footer);
    syncTotals();
  }

  function buildCard(report: Report): HTMLElement {
    const meta = TARGET_META[report.target] ?? {
      title: report.target,
      blurb: "",
      icon: iconApps(),
    };

    const findings = [...report.findings].sort((a, b) => b.size - a.size);
    const groupTotal = findings.reduce((acc, f) => acc + f.size, 0);

    const cardRows: Row[] = [];

    const card = document.createElement("section");
    card.className = "cl-card";
    card.dataset.open = "true";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "cl-card-head";
    head.setAttribute("aria-expanded", "true");
    head.innerHTML = `
      <span class="cl-card-icon">${meta.icon}</span>
      <span class="cl-card-meta">
        <span class="cl-card-title">${escapeHtml(meta.title)}</span>
        <span class="cl-card-blurb">${escapeHtml(meta.blurb)}</span>
      </span>
      <span class="cl-card-size" data-group-size>${formatBytes(groupTotal)}</span>
      <span class="cl-card-count">${findings.length} item${findings.length === 1 ? "" : "s"}</span>
      <span class="cl-chevron">${iconChevron()}</span>
    `;

    const list = document.createElement("div");
    list.className = "cl-list";

    // Per-card select-all toggle lives in its own header row.
    const selectAll = document.createElement("label");
    selectAll.className = "cl-item cl-item-all";
    const allBox = document.createElement("input");
    allBox.type = "checkbox";
    allBox.className = "cl-check";
    allBox.setAttribute("aria-label", `Select all in ${meta.title}`);
    selectAll.appendChild(allBox);
    const allText = document.createElement("span");
    allText.className = "cl-item-label";
    allText.innerHTML = `<span class="cl-item-name">Select all</span>`;
    selectAll.appendChild(allText);
    list.appendChild(selectAll);

    for (const finding of findings) {
      const row = buildRow(finding, () => {
        syncSelectAll();
        syncTotals();
      });
      cardRows.push(row);
      rows.push(row);
      list.appendChild(row.row);
    }

    allBox.addEventListener("change", () => {
      for (const r of cardRows) {
        if (r.checked !== allBox.checked) {
          r.checked = allBox.checked;
          r.input.checked = allBox.checked;
          r.row.classList.toggle("is-checked", allBox.checked);
        }
      }
      syncTotals();
    });

    function syncSelectAll(): void {
      const checkedCount = cardRows.filter((r) => r.checked).length;
      allBox.checked = checkedCount === cardRows.length;
      allBox.indeterminate = checkedCount > 0 && checkedCount < cardRows.length;
    }
    syncSelectAll();

    head.addEventListener("click", () => {
      const open = card.dataset.open === "true";
      card.dataset.open = open ? "false" : "true";
      head.setAttribute("aria-expanded", open ? "false" : "true");
    });

    card.appendChild(head);
    card.appendChild(list);
    return card;
  }

  function buildRow(finding: Finding, onChange: () => void): Row {
    const checked = !finding.risky;

    const row = document.createElement("label");
    row.className = "cl-item";
    if (checked) row.classList.add("is-checked");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cl-check";
    input.checked = checked;
    input.setAttribute("aria-label", prettyPath(finding.path));

    const label = document.createElement("span");
    label.className = "cl-item-label";

    const badges: string[] = [];
    if (finding.risky) badges.push(`<span class="cl-badge cl-badge-risky">Risky</span>`);
    if (finding.stale) badges.push(`<span class="cl-badge cl-badge-stale">Stale</span>`);

    label.innerHTML = `
      <span class="cl-item-name" title="${escapeHtml(finding.path)}">${escapeHtml(prettyPath(finding.path))}</span>
      <span class="cl-item-meta">
        ${badges.join("")}
        ${finding.note ? `<span class="cl-item-note">${escapeHtml(finding.note)}</span>` : ""}
      </span>
    `;

    const size = document.createElement("span");
    size.className = "cl-item-size";
    size.textContent = formatBytes(finding.size);

    row.appendChild(input);
    row.appendChild(label);
    row.appendChild(size);

    const r: Row = { finding, checked, input, row };
    input.addEventListener("change", () => {
      r.checked = input.checked;
      row.classList.toggle("is-checked", input.checked);
      onChange();
    });

    return r;
  }

  function buildFooter(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cl-footer";

    const summary = document.createElement("div");
    summary.className = "cl-footer-summary";
    summary.innerHTML = `
      <span class="cl-footer-size" data-total>0 B</span>
      <span class="cl-footer-count" data-count>Nothing selected</span>
    `;

    const actions = document.createElement("div");
    actions.className = "cl-footer-actions";

    const rescan = button({
      label: "Rescan",
      variant: "ghost",
      onClick: () => void load(),
    });

    const clean = button({
      label: "Clean selected",
      variant: "primary",
      onClick: () => void runClean(),
    });
    clean.classList.add("cl-clean-btn");
    clean.dataset.clean = "true";

    actions.appendChild(rescan);
    actions.appendChild(clean);
    bar.appendChild(summary);
    bar.appendChild(actions);
    return bar;
  }

  function selected(): Row[] {
    return rows.filter((r) => r.checked);
  }

  function syncTotals(): void {
    if (!footer) return;
    const picked = selected();
    const total = picked.reduce((acc, r) => acc + r.finding.size, 0);

    const totalEl = footer.querySelector<HTMLElement>("[data-total]")!;
    const countEl = footer.querySelector<HTMLElement>("[data-count]")!;
    const cleanBtn = footer.querySelector<HTMLButtonElement>("[data-clean]")!;

    totalEl.textContent = formatBytes(total);
    countEl.textContent = picked.length
      ? `${picked.length} item${picked.length === 1 ? "" : "s"} selected`
      : "Nothing selected";

    cleanBtn.disabled = picked.length === 0;
    cleanBtn.classList.toggle("is-disabled", picked.length === 0);
  }

  async function runClean(): Promise<void> {
    const picked = selected();
    if (picked.length === 0) return;

    const total = picked.reduce((acc, r) => acc + r.finding.size, 0);
    const riskyCount = picked.filter((r) => r.finding.risky).length;

    const ok = await confirmClean(picked.length, total, riskyCount);
    if (!ok) return;

    const cleanBtn = footer?.querySelector<HTMLButtonElement>("[data-clean]");
    const paths = picked.map((r) => r.finding.path);

    if (cleanBtn) {
      cleanBtn.disabled = true;
      cleanBtn.classList.add("is-busy");
      cleanBtn.textContent = "Cleaning…";
    }

    try {
      const result = await api.clean(paths, false);
      const freed = formatBytes(result.freed);
      if (result.failures > 0) {
        toast(`Freed ${freed}, but ${result.failures} item${result.failures === 1 ? "" : "s"} could not be removed.`);
      } else {
        toast(`Freed ${freed} across ${result.trashed} item${result.trashed === 1 ? "" : "s"}.`);
      }
    } catch (err) {
      toast(`Cleanup failed: ${message(err)}`);
      if (cleanBtn) {
        cleanBtn.disabled = false;
        cleanBtn.classList.remove("is-busy");
        cleanBtn.textContent = "Clean selected";
      }
      return;
    }

    // Re-scan so the lists reflect what's actually left on disk.
    await load();
  }
}

// --- transient states ---

function loadingState(): HTMLElement {
  const el = document.createElement("div");
  el.className = "cl-state";
  el.appendChild(spinner());
  const p = document.createElement("p");
  p.className = "cl-state-text";
  p.textContent = "Scanning caches and build artifacts…";
  el.appendChild(p);
  return el;
}

function emptyState(): HTMLElement {
  const el = document.createElement("div");
  el.className = "cl-state cl-state-empty";
  el.innerHTML = `
    <div class="cl-state-glyph">${iconSparkle()}</div>
    <h3 class="cl-state-title">All clean</h3>
    <p class="cl-state-text">There's nothing to reclaim right now. Check back after a few days of use.</p>
  `;
  return el;
}

function errorState(msg: string, onRetry: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "cl-state cl-state-error";
  el.innerHTML = `
    <div class="cl-state-glyph cl-state-glyph-warn">${iconWarn()}</div>
    <h3 class="cl-state-title">Scan failed</h3>
    <p class="cl-state-text">${escapeHtml(msg)}</p>
  `;
  el.appendChild(button({ label: "Try again", variant: "ghost", onClick: onRetry }));
  return el;
}

// --- confirm dialog ---

function confirmClean(count: number, total: number, riskyCount: number): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "cl-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const dialog = document.createElement("div");
    dialog.className = "cl-modal";
    dialog.innerHTML = `
      <h3 class="cl-modal-title">Clean ${count} item${count === 1 ? "" : "s"}?</h3>
      <p class="cl-modal-text">
        This moves <strong>${formatBytes(total)}</strong> to the Trash. Items can be
        restored until you empty it.
      </p>
      ${
        riskyCount > 0
          ? `<div class="cl-modal-warn">${iconWarn()}<span>${riskyCount} risky item${riskyCount === 1 ? " is" : "s are"} included. Make sure the related apps are closed.</span></div>`
          : ""
      }
    `;

    const actions = document.createElement("div");
    actions.className = "cl-modal-actions";

    const finish = (value: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.classList.add("is-leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(value);
    };

    const cancel = button({ label: "Cancel", variant: "ghost", onClick: () => finish(false) });
    const confirm = button({ label: "Move to Trash", variant: "primary", onClick: () => finish(true) });

    actions.appendChild(cancel);
    actions.appendChild(confirm);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter") finish(true);
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(false);
    });

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("is-open"));
    requestAnimationFrame(() => confirm.focus());
  });
}

// --- helpers ---

function prettyPath(path: string): string {
  const home = "/Users/";
  let p = path;
  const idx = p.indexOf(home);
  if (idx === 0) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) p = "~" + rest.slice(slash);
  }
  return p;
}

function message(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- inline icons ---

function iconChevron(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
}
function iconCpu(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>`;
}
function iconApps(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
}
function iconTerminal(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
}
function iconHammer(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l4 4"/><path d="M3 21l9-9"/><path d="M11.5 4.5l8 8 2-2-8-8z"/></svg>`;
}
function iconSparkle(): string {
  return `<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 14l.8 1.9 1.9.8-1.9.8L19 19.4l-.8-1.9-1.9-.8 1.9-.8z"/></svg>`;
}
function iconWarn(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
}

// --- scoped styles ---

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.dataset.screen = "cleanup";
  style.textContent = `
.cl { display: flex; flex-direction: column; gap: 22px; padding-bottom: 96px; animation: cl-fade 220ms ease both; }
@keyframes cl-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.cl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cl-title { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
.cl-sub { margin: 6px 0 0; color: var(--text-dim); font-size: 14px; }

.cl-body { display: flex; flex-direction: column; gap: 14px; }

/* cards */
.cl-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  overflow: hidden;
  transition: border-color 180ms ease, box-shadow 180ms ease;
}
.cl-card:hover { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }

.cl-card-head {
  display: grid;
  grid-template-columns: 40px 1fr auto auto 22px;
  align-items: center;
  gap: 14px;
  width: 100%;
  background: transparent;
  border: none;
  padding: 16px 18px;
  text-align: left;
  color: var(--text);
}
.cl-card-icon {
  width: 40px; height: 40px;
  display: grid; place-items: center;
  border-radius: 12px;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.cl-card-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cl-card-title { font-size: 15px; font-weight: 600; }
.cl-card-blurb { font-size: 12.5px; color: var(--text-dim); }
.cl-card-size { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; background: linear-gradient(90deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.cl-card-count { font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.cl-chevron { display: grid; place-items: center; color: var(--text-faint); transition: transform 200ms ease; }
.cl-card[data-open="false"] .cl-chevron { transform: rotate(-90deg); }

.cl-list {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 240ms ease;
  border-top: 1px solid var(--border);
}
.cl-card[data-open="false"] .cl-list { grid-template-rows: 0fr; border-top-color: transparent; }
.cl-list > * { min-height: 0; }
.cl-card[data-open="false"] .cl-list { overflow: hidden; }

.cl-item {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 11px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  cursor: pointer;
  transition: background 140ms ease;
}
.cl-item:last-child { border-bottom: none; }
.cl-item:hover { background: var(--surface-2); }
.cl-item.is-checked { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.cl-item-all { background: var(--surface-2); font-weight: 600; }
.cl-item-all:hover { background: color-mix(in srgb, var(--surface-2) 80%, var(--accent)); }

.cl-check {
  appearance: none;
  width: 18px; height: 18px;
  border-radius: 6px;
  border: 1.5px solid var(--text-faint);
  background: transparent;
  display: grid; place-items: center;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}
.cl-check:hover { border-color: var(--accent); }
.cl-check:checked, .cl-check:indeterminate {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border-color: transparent;
}
.cl-check:checked::after {
  content: ""; width: 5px; height: 9px;
  border: solid #fff; border-width: 0 2px 2px 0;
  transform: rotate(45deg) translateY(-1px);
}
.cl-check:indeterminate::after { content: ""; width: 9px; height: 2px; background: #fff; border-radius: 1px; }
.cl-check:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }

.cl-item-label { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cl-item-name { font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--mono); }
.cl-item-all .cl-item-name { font-family: var(--font); }
.cl-item-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cl-item-note { font-size: 11.5px; color: var(--text-faint); }
.cl-item-size { font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

.cl-badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 999px; }
.cl-badge-risky { color: var(--danger); background: color-mix(in srgb, var(--danger) 16%, transparent); }
.cl-badge-stale { color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }

/* footer */
.cl-footer {
  position: sticky;
  bottom: 0;
  margin-top: 6px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 18px;
  background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}
.cl-footer-summary { display: flex; flex-direction: column; gap: 2px; }
.cl-footer-size { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.cl-footer-count { font-size: 12.5px; color: var(--text-dim); }
.cl-footer-actions { display: flex; gap: 10px; }
.cl-clean-btn.is-disabled { opacity: 0.45; pointer-events: none; }
.cl-clean-btn.is-busy { opacity: 0.8; pointer-events: none; }

/* states */
.cl-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 72px 20px; text-align: center; }
.cl-state-text { margin: 0; color: var(--text-dim); font-size: 14px; max-width: 380px; }
.cl-state-title { margin: 0; font-size: 18px; }
.cl-state-glyph { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 20px; color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
.cl-state-glyph-warn { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }

/* modal */
.cl-modal-overlay {
  position: fixed; inset: 0; z-index: 80;
  display: grid; place-items: center;
  background: rgba(0,0,0,0.5);
  opacity: 0; transition: opacity 160ms ease;
}
.cl-modal-overlay.is-open { opacity: 1; }
.cl-modal-overlay.is-leaving { opacity: 0; }
.cl-modal {
  width: min(420px, calc(100vw - 48px));
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 22px;
  transform: scale(0.96) translateY(8px);
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.cl-modal-overlay.is-open .cl-modal { transform: none; }
.cl-modal-title { margin: 0 0 8px; font-size: 17px; }
.cl-modal-text { margin: 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.5; }
.cl-modal-text strong { color: var(--text); }
.cl-modal-warn { display: flex; gap: 10px; align-items: flex-start; margin-top: 14px; padding: 10px 12px; border-radius: var(--radius); font-size: 12.5px; color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.cl-modal-warn svg { flex: 0 0 auto; margin-top: 1px; }
.cl-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
`;
  document.head.appendChild(style);
}
