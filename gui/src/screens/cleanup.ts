// Cleanup screen — the Green world. An idle hero (eyebrow → glossy broom → title
// → subtitle → circular Scan CTA) cross-fades into a results grid of glass
// category cards. Each card holds a checkable list of findings; a master total
// drives the pill "Clean" CTA, which re-confirms before calling clean(paths,
// false). Risky findings start unchecked so a single sweep never trashes
// something it shouldn't. Data wiring (scan/clean) is unchanged.

import type { Api } from "../api";
import type { Finding, Report } from "../types";
import { button, formatBytes, icon, spinner, toast } from "../components";
import heroRaw from "../assets/illustrations/cleanup.svg?raw";

const TARGETS = ["system-caches", "app-caches", "dev-tools", "xcode"];

const TARGET_META: Record<string, { title: string; blurb: string; icon: string }> = {
  "system-caches": {
    title: "System Caches",
    blurb: "Temporary files the system rebuilds on demand",
    icon: "broom",
  },
  "app-caches": {
    title: "Application Caches",
    blurb: "Per-app scratch data that apps recreate when needed",
    icon: "applications",
  },
  "dev-tools": {
    title: "Developer Tools",
    blurb: "Package manager and build tool caches",
    icon: "files",
  },
  xcode: {
    title: "Xcode",
    blurb: "Derived data, archives and simulator leftovers",
    icon: "maintenance",
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

  type Phase = "idle" | "scanning" | "results" | "empty" | "error";
  let phase: Phase = "idle";

  const el = document.createElement("div");
  el.className = "screen cl";
  el.innerHTML = `
    <section class="cl-hero" data-hero>
      <div class="cl-eyebrow">Cleanup</div>
      <div class="hero-art cl-art">${heroRaw}</div>
      <h1 class="cl-title">Reclaim space, safely.</h1>
      <p class="cl-sub">Sweep caches and build artifacts you don't need. Safe items are pre-selected — nothing leaves your Trash.</p>
      <div class="cl-cta-wrap" data-cta></div>
      <p class="cl-hint" data-hint>Nothing is deleted — items move to Trash.</p>
    </section>
    <section class="cl-results" data-results hidden></section>
  `;
  root.appendChild(el);

  const heroEl = el.querySelector<HTMLElement>("[data-hero]")!;
  const ctaWrap = el.querySelector<HTMLElement>("[data-cta]")!;
  const hintEl = el.querySelector<HTMLElement>("[data-hint]")!;
  const results = el.querySelector<HTMLElement>("[data-results]")!;

  const rows: Row[] = [];
  let cleanPill: HTMLButtonElement | null = null;
  let totalEl: HTMLElement | null = null;
  let countEl: HTMLElement | null = null;

  renderScanCta();

  function renderScanCta(): void {
    ctaWrap.replaceChildren();
    const scan = document.createElement("button");
    scan.type = "button";
    scan.className = "cta-circle cl-scan";
    scan.textContent = "Scan";
    scan.setAttribute("aria-label", "Scan for reclaimable space");
    scan.addEventListener("click", () => void load());
    ctaWrap.appendChild(scan);
  }

  function showHero(scanning: boolean): void {
    phase = scanning ? "scanning" : phase;
    results.hidden = true;
    heroEl.hidden = false;
    heroEl.classList.remove("is-out");
    if (scanning) {
      ctaWrap.replaceChildren();
      const sp = spinner({ size: 28 });
      sp.classList.add("cl-scan-spin");
      ctaWrap.appendChild(sp);
      hintEl.textContent = "Scanning caches and build artifacts…";
    } else {
      hintEl.textContent = "Nothing is deleted — items move to Trash.";
    }
  }

  // Cross-fade the hero out and the results grid in (§5).
  function crossToResults(): void {
    heroEl.classList.add("is-out");
    window.setTimeout(() => {
      heroEl.hidden = true;
      results.hidden = false;
      results.classList.remove("is-in");
      requestAnimationFrame(() => results.classList.add("is-in"));
    }, 200);
  }

  async function load(): Promise<void> {
    rows.length = 0;
    cleanPill = null;
    totalEl = null;
    countEl = null;
    showHero(true);

    let reports: Report[];
    try {
      reports = await api.scan(TARGETS);
    } catch (err) {
      phase = "error";
      renderScanCta();
      heroEl.classList.remove("is-out");
      hintEl.textContent = "";
      results.innerHTML = "";
      results.appendChild(errorState(message(err), () => void load()));
      crossToResults();
      return;
    }

    const withFindings = reports.filter((r) => r.findings.length > 0);

    if (withFindings.length === 0) {
      phase = "empty";
      results.innerHTML = "";
      results.appendChild(emptyState(() => void load()));
      crossToResults();
      return;
    }

    phase = "results";
    const grandTotal = withFindings.reduce(
      (acc, r) => acc + r.findings.reduce((s, f) => s + f.size, 0),
      0
    );

    results.innerHTML = "";
    results.appendChild(buildHead());

    const grid = document.createElement("div");
    grid.className = "grid cl-grid";
    let delay = 0;
    for (const report of withFindings) {
      const card = buildCard(report, grandTotal);
      card.style.animationDelay = `${delay}ms`;
      delay += 40;
      grid.appendChild(card);
    }
    results.appendChild(grid);

    crossToResults();
    syncTotals();
  }

  function buildHead(): HTMLElement {
    const head = document.createElement("div");
    head.className = "results-head cl-head";
    head.innerHTML = `
      <div class="cl-head-info">
        <h2>Reclaimable space</h2>
        <p class="results-sub"><span data-count>Nothing selected</span> · <span class="cl-total" data-total>0 B</span> selected</p>
      </div>
    `;

    const actions = document.createElement("div");
    actions.className = "results-actions";

    const rescan = button({
      label: "Rescan",
      variant: "ghost",
      icon: "refresh",
      onClick: () => void load(),
    });

    const clean = document.createElement("button");
    clean.type = "button";
    clean.className = "cta-pill cl-clean";
    clean.innerHTML = `<span class="cl-clean-label">Clean</span>`;
    clean.addEventListener("click", () => void runClean());

    actions.appendChild(rescan);
    actions.appendChild(clean);
    head.appendChild(actions);

    cleanPill = clean;
    totalEl = head.querySelector<HTMLElement>("[data-total]");
    countEl = head.querySelector<HTMLElement>("[data-count]");
    return head;
  }

  function buildCard(report: Report, grandTotal: number): HTMLElement {
    const meta = TARGET_META[report.target] ?? {
      title: report.target,
      blurb: "",
      icon: "broom",
    };

    const findings = [...report.findings].sort((a, b) => b.size - a.size);
    const groupTotal = findings.reduce((acc, f) => acc + f.size, 0);
    const cardRows: Row[] = [];

    const card = document.createElement("section");
    card.className = "glass-card cl-card";

    const head = document.createElement("div");
    head.className = "cl-card-head";
    head.innerHTML = `
      <span class="cl-card-icon"></span>
      <span class="cl-card-meta">
        <span class="cl-card-title">${escapeHtml(meta.title)}</span>
        <span class="cl-card-blurb">${escapeHtml(meta.blurb)}</span>
      </span>
      <span class="cl-card-size" data-group-size>${formatBytes(groupTotal)}</span>
    `;
    head.querySelector(".cl-card-icon")!.appendChild(icon(meta.icon, { size: 20 }));

    // Per-card share of the grand total — a thin sizebar under the header.
    const share = grandTotal > 0 ? (groupTotal / grandTotal) * 100 : 0;
    const bar = document.createElement("div");
    bar.className = "sizebar cl-card-bar";
    bar.innerHTML = `<div class="sizebar-fill"></div>`;
    const fill = bar.querySelector<HTMLElement>(".sizebar-fill")!;
    requestAnimationFrame(() => {
      fill.style.width = `${Math.max(3, share)}%`;
    });

    const list = document.createElement("div");
    list.className = "list cl-list";

    // Per-card "Select all" row.
    const selectAll = document.createElement("label");
    selectAll.className = "row cl-item cl-item-all is-interactive";
    const allBox = document.createElement("input");
    allBox.type = "checkbox";
    allBox.className = "check cl-check";
    allBox.setAttribute("aria-label", `Select all in ${meta.title}`);
    const allText = document.createElement("span");
    allText.className = "row-main";
    allText.innerHTML = `<span class="row-title">Select all</span>`;
    selectAll.appendChild(allBox);
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
          r.row.classList.toggle("is-selected", allBox.checked);
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

    card.appendChild(head);
    card.appendChild(bar);
    card.appendChild(list);
    return card;
  }

  function buildRow(finding: Finding, onChange: () => void): Row {
    const checked = !finding.risky;

    const row = document.createElement("label");
    row.className = "row cl-item is-interactive";
    if (checked) row.classList.add("is-selected");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "check cl-check";
    input.checked = checked;
    input.setAttribute("aria-label", prettyPath(finding.path));

    const main = document.createElement("span");
    main.className = "row-main";

    const badges: string[] = [];
    if (finding.risky) badges.push(`<span class="chip is-danger cl-badge">Risky</span>`);
    if (finding.stale) badges.push(`<span class="chip is-warn cl-badge">Stale</span>`);

    main.innerHTML = `
      <span class="row-title mono" title="${escapeHtml(finding.path)}">${escapeHtml(prettyPath(finding.path))}</span>
      <span class="cl-item-meta">
        ${badges.join("")}
        ${finding.note ? `<span class="cl-item-note">${escapeHtml(finding.note)}</span>` : ""}
      </span>
    `;

    const size = document.createElement("span");
    size.className = "row-size cl-item-size";
    size.textContent = formatBytes(finding.size);

    row.appendChild(input);
    row.appendChild(main);
    row.appendChild(size);

    const r: Row = { finding, checked, input, row };
    input.addEventListener("change", () => {
      r.checked = input.checked;
      row.classList.toggle("is-selected", input.checked);
      onChange();
    });

    return r;
  }

  function selected(): Row[] {
    return rows.filter((r) => r.checked);
  }

  function syncTotals(): void {
    if (!cleanPill || !totalEl || !countEl) return;
    const picked = selected();
    const total = picked.reduce((acc, r) => acc + r.finding.size, 0);

    totalEl.textContent = formatBytes(total);
    countEl.textContent = picked.length
      ? `${picked.length} item${picked.length === 1 ? "" : "s"}`
      : "Nothing selected";

    const empty = picked.length === 0;
    cleanPill.disabled = empty;
    cleanPill.setAttribute("aria-disabled", String(empty));
    const label = cleanPill.querySelector(".cl-clean-label");
    if (label) label.textContent = empty ? "Clean" : `Clean ${formatBytes(total)}`;
  }

  async function runClean(): Promise<void> {
    const picked = selected();
    if (picked.length === 0) return;

    const total = picked.reduce((acc, r) => acc + r.finding.size, 0);
    const riskyCount = picked.filter((r) => r.finding.risky).length;

    const ok = await confirmClean(picked.length, total, riskyCount);
    if (!ok) return;

    const paths = picked.map((r) => r.finding.path);

    if (cleanPill) {
      cleanPill.disabled = true;
      cleanPill.classList.add("is-busy");
      const label = cleanPill.querySelector(".cl-clean-label");
      if (label) label.textContent = "Cleaning…";
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
      if (cleanPill) {
        cleanPill.disabled = false;
        cleanPill.classList.remove("is-busy");
      }
      syncTotals();
      return;
    }

    // Re-scan so the lists reflect what's actually left on disk.
    await load();
  }
}

// --- transient states ---

function emptyState(onRescan: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "state cl-state";
  el.innerHTML = `
    <div class="cl-state-glyph cl-state-glyph-ok"></div>
    <h3>All clean</h3>
    <p>There's nothing to reclaim right now. Check back after a few days of use.</p>
  `;
  el.querySelector(".cl-state-glyph")!.appendChild(icon("check", { size: 30 }));
  el.appendChild(button({ label: "Rescan", variant: "ghost", icon: "refresh", onClick: onRescan }));
  return el;
}

function errorState(msg: string, onRetry: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "state cl-state";
  el.innerHTML = `
    <div class="cl-state-glyph cl-state-glyph-warn">${iconWarn()}</div>
    <h3>Scan failed</h3>
    <p>${escapeHtml(msg)}</p>
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
    dialog.className = "glass-strong cl-modal";
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
.cl { padding: 12px 0 var(--s-6); max-width: 960px; margin: 0 auto; width: 100%; }

/* --- idle / hero --- */
.cl-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  transition: opacity var(--t-base) var(--ease), transform var(--t-base) var(--ease);
}
.cl-hero.is-out { opacity: 0; transform: translateY(-8px); pointer-events: none; }
.cl-eyebrow {
  font-size: 13px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.14em; color: var(--text-faint); margin-bottom: var(--s-3);
}
.cl-art { width: 240px; height: 240px; }
.cl-title {
  font-size: clamp(30px, 3.4vw, 40px); font-weight: 700;
  letter-spacing: -0.02em; line-height: 1.1; color: var(--text);
  margin-top: var(--s-4);
}
.cl-sub {
  font-size: 17px; font-weight: 400; color: var(--text-dim);
  max-width: 460px; margin: var(--s-2) auto 0;
}
.cl-cta-wrap {
  margin-top: var(--s-6); min-height: 128px;
  display: grid; place-items: center;
}
.cl-scan-spin { width: 28px; height: 28px; }
.cl-hint { font-size: 13px; color: var(--text-faint); margin-top: var(--s-3); }

/* --- results --- */
.cl-results { opacity: 0; }
.cl-results.is-in { animation: fade-up var(--t-slow) var(--ease) both; opacity: 1; }
.cl-head-info h2 { margin: 0; }
.cl-total { color: var(--accent-2); font-weight: 700; font-variant-numeric: tabular-nums; }
.cl-head [data-count] { font-variant-numeric: tabular-nums; }

.cl-clean.is-busy { pointer-events: none; opacity: 0.8; }

.cl-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-items: start; }
.cl-card { animation: fade-up var(--t-slow) var(--ease) both; }

.cl-card-head {
  display: grid;
  grid-template-columns: 44px 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 18px 18px 12px;
}
.cl-card-icon {
  width: 44px; height: 44px;
  display: grid; place-items: center;
  border-radius: 13px;
  color: #fff;
  background: color-mix(in srgb, var(--accent) 24%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-2) 40%, transparent);
}
.cl-card-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cl-card-title { font-size: 15px; font-weight: 600; color: var(--text); }
.cl-card-blurb { font-size: 12.5px; color: var(--text-dim); }
.cl-card-size {
  font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.cl-card-bar { margin: 0 18px 14px; width: auto; }

.cl-list {
  border-top: 1px solid var(--hairline);
  border-radius: 0;
  max-height: 320px;
  overflow-y: auto;
}
.cl-item { padding: 10px 18px; }
.cl-item-all { font-weight: 600; background: rgba(255, 255, 255, 0.03); }
.cl-item-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cl-badge.cl-badge { padding: 2px 7px; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; }
.cl-item-note { font-size: 11.5px; color: var(--text-faint); }
.cl-item-size { font-size: 13px; color: var(--text-dim); font-weight: 600; }

/* --- states --- */
.cl-state { gap: 14px; }
.cl-state-glyph { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 20px; }
.cl-state-glyph-ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); }
.cl-state-glyph-warn { color: var(--danger); background: color-mix(in srgb, var(--danger) 16%, transparent); }
.cl-state p { max-width: 380px; }

/* --- modal --- */
.cl-modal-overlay {
  position: fixed; inset: 0; z-index: 80;
  display: grid; place-items: center;
  background: rgba(0, 0, 0, 0.5);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  opacity: 0; transition: opacity 160ms var(--ease);
}
.cl-modal-overlay.is-open { opacity: 1; }
.cl-modal-overlay.is-leaving { opacity: 0; }
.cl-modal {
  width: min(420px, calc(100vw - 48px));
  padding: 24px;
  transform: scale(0.96) translateY(8px);
  transition: transform 180ms var(--ease);
}
.cl-modal-overlay.is-open .cl-modal { transform: none; }
.cl-modal-title { margin: 0 0 8px; font-size: 18px; }
.cl-modal-text { margin: 0; color: var(--text-dim); font-size: 14px; line-height: 1.5; }
.cl-modal-text strong { color: var(--text); }
.cl-modal-warn {
  display: flex; gap: 10px; align-items: flex-start; margin-top: 16px;
  padding: 11px 13px; border-radius: 14px; font-size: 12.5px;
  color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent);
}
.cl-modal-warn svg { flex: 0 0 auto; margin-top: 1px; }
.cl-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }

@media (prefers-reduced-motion: reduce) {
  .cl-card, .cl-results.is-in { animation: none; }
  .cl-hero { transition: none; }
}
`;
  document.head.appendChild(style);
}
