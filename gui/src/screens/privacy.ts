// Privacy screen — the Protection world (magenta/pink). Surfaces what the
// privacy() scan finds — browser caches, cookies & history, and mail residue —
// grouped onto glass cards. Risky (personal) findings start unchecked and are
// flagged so a sweep never wipes something personal by accident. The circular
// "Clean" CTA runs clean(selectedPaths, false). Layout follows DESIGN_SPEC:
// eyebrow → shield/hand hero → title → subtitle → circular CTA, cross-fading to
// a results grid of grouped cards once the scan returns.

import type { Api } from "../api";
import type { Finding } from "../types";
import { formatBytes, toast } from "../components";
import heroRaw from "../assets/illustrations/privacy.svg?raw";

type GroupId = "browser" | "cookies" | "mail";

interface Group {
  id: GroupId;
  title: string;
  blurb: string;
  findings: Finding[];
}

const GROUP_META: Record<GroupId, { title: string; blurb: string; icon: string }> = {
  browser: {
    title: "Browser caches",
    blurb: "Cached pages, images and service-worker data. Safe to clear.",
    icon: iconCache(),
  },
  cookies: {
    title: "Cookies & history",
    blurb: "Sign-in cookies and browsing history. Clearing signs you out.",
    icon: iconCookie(),
  },
  mail: {
    title: "Mail",
    blurb: "Mail caches, downloads and attachment residue.",
    icon: iconMail(),
  },
};

const GROUP_ORDER: GroupId[] = ["browser", "cookies", "mail"];

export function renderPrivacy(root: HTMLElement, api: Api): void {
  injectStyles();

  const el = document.createElement("div");
  el.className = "screen pv";
  el.innerHTML = `
    <section class="pv-stage" data-stage></section>
    <div class="pv-results" data-results hidden></div>
  `;
  root.appendChild(el);

  const stage = el.querySelector<HTMLElement>("[data-stage]")!;
  const resultsHost = el.querySelector<HTMLElement>("[data-results]")!;

  // path -> selection, kept on a Set so re-renders preserve choices.
  const selected = new Set<string>();
  let groups: Group[] = [];
  let busy = false;
  let detachParallax: (() => void) | null = null;

  showIdle();

  // --- phase: idle / hero ---------------------------------------------------

  function showIdle(): void {
    teardownParallax();
    resultsHost.hidden = true;
    resultsHost.innerHTML = "";
    stage.hidden = false;
    stage.innerHTML = heroMarkup({
      title: "Protect your privacy.",
      sub: "Wipe the traces apps leave behind — caches, cookies, history and mail. Nothing personal is touched unless you choose it.",
      cta: "Scan",
      hint: "We only read what privacy() reports. Nothing is removed until you clean.",
    });
    wireHero(() => void load());
  }

  function showScanning(): void {
    teardownParallax();
    resultsHost.hidden = true;
    stage.hidden = false;
    stage.innerHTML = heroMarkup({
      title: "Scanning privacy traces…",
      sub: "Looking through browser caches, cookies, history and mail residue.",
      scanning: true,
    });
    setupParallax();
  }

  function showEmpty(): void {
    teardownParallax();
    resultsHost.hidden = true;
    stage.hidden = false;
    stage.innerHTML = heroMarkup({
      title: "You're clean.",
      sub: "No browser, cookie or mail traces were found. Run another scan whenever you like.",
      cta: "Scan again",
      ctaTone: "ok",
    });
    wireHero(() => void load());
  }

  function showError(msg: string): void {
    teardownParallax();
    resultsHost.hidden = true;
    stage.hidden = false;
    stage.innerHTML = heroMarkup({
      title: "The privacy scan failed.",
      sub: msg,
      cta: "Try again",
      ctaTone: "danger",
    });
    wireHero(() => void load());
  }

  function heroMarkup(opts: {
    title: string;
    sub: string;
    cta?: string;
    hint?: string;
    scanning?: boolean;
    ctaTone?: "ok" | "danger";
  }): string {
    const cta = opts.scanning
      ? `<div class="pv-cta-scanning" role="status" aria-label="Scanning"><span class="pv-cta-spinner"></span></div>`
      : opts.cta
        ? `<button type="button" class="cta-circle pv-cta" data-cta>${escapeHtml(opts.cta)}</button>`
        : "";
    const hint = opts.hint
      ? `<p class="pv-hint">${escapeHtml(opts.hint)}</p>`
      : "";
    return `
      <div class="hero pv-hero">
        <div class="eyebrow">Protection</div>
        <div class="hero-art pv-art" data-art>${heroRaw}</div>
        <h1 class="title">${escapeHtml(opts.title)}</h1>
        <p class="subtitle">${escapeHtml(opts.sub)}</p>
        ${cta}
        ${hint}
      </div>`;
  }

  function wireHero(onCta: () => void): void {
    const cta = stage.querySelector<HTMLButtonElement>("[data-cta]");
    if (cta) cta.addEventListener("click", onCta);
    setupParallax();
  }

  // --- pointer parallax on the hero art ------------------------------------

  function setupParallax(): void {
    const art = stage.querySelector<HTMLElement>("[data-art]");
    if (!art) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    const onMove = (e: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
      const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
      art.style.setProperty("--px", `${(dx * 8).toFixed(2)}px`);
      art.style.setProperty("--py", `${(dy * 8).toFixed(2)}px`);
    };
    const onLeave = () => {
      art.style.setProperty("--px", "0px");
      art.style.setProperty("--py", "0px");
    };
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerleave", onLeave);
    detachParallax = () => {
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
    };
  }

  function teardownParallax(): void {
    if (detachParallax) {
      detachParallax();
      detachParallax = null;
    }
  }

  // --- data flow ------------------------------------------------------------

  async function load(): Promise<void> {
    if (busy) return;
    selected.clear();
    showScanning();
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
      showResults();
    } catch (err) {
      showError(errorMessage(err));
    }
  }

  // --- phase: results grid --------------------------------------------------

  function showResults(): void {
    teardownParallax();
    stage.hidden = true;
    stage.innerHTML = "";
    resultsHost.hidden = false;
    resultsHost.innerHTML = `
      <div class="results-head pv-head">
        <div>
          <h2>Traces ready to clear</h2>
          <p class="results-sub" data-sub></p>
        </div>
        <div class="results-actions">
          <button type="button" class="btn btn-ghost" data-rescan>Rescan</button>
        </div>
      </div>
      <div class="grid pv-grid" data-grid></div>
      <div class="pv-dock">
        <div class="pv-dock-summary" data-summary>Nothing selected</div>
        <button type="button" class="cta-circle pv-clean" data-clean disabled>Clean</button>
      </div>
    `;

    const grid = resultsHost.querySelector<HTMLElement>("[data-grid]")!;
    const rescan = resultsHost.querySelector<HTMLButtonElement>("[data-rescan]")!;
    const cleanBtn = resultsHost.querySelector<HTMLButtonElement>("[data-clean]")!;

    rescan.addEventListener("click", () => void load());
    cleanBtn.addEventListener("click", () => void cleanSelected());

    let i = 0;
    for (const id of GROUP_ORDER) {
      const group = groups.find((g) => g.id === id);
      if (!group || group.findings.length === 0) continue;
      const card = buildCard(group);
      card.style.animationDelay = `${i * 40}ms`;
      grid.appendChild(card);
      i++;
    }

    syncDock();
  }

  function buildCard(group: Group): HTMLElement {
    const meta = GROUP_META[group.id];
    const total = group.findings.reduce((s, f) => s + f.size, 0);
    const personal = group.findings.filter((f) => f.risky).length;

    const card = document.createElement("section");
    card.className = "glass-card pv-card";
    card.dataset.group = group.id;
    card.innerHTML = `
      <header class="pv-card-head">
        <span class="pv-card-icon">${meta.icon}</span>
        <span class="pv-card-meta">
          <span class="pv-card-title">${escapeHtml(meta.title)}</span>
          <span class="pv-card-blurb">${escapeHtml(meta.blurb)}</span>
        </span>
        <button type="button" class="pv-selectall" data-selectall
          aria-label="Toggle all in ${escapeHtml(meta.title)}"></button>
      </header>
      <div class="pv-card-stats">
        <span class="pv-card-size tnum">${formatBytes(total)}</span>
        <span class="pv-card-count">${group.findings.length} item${group.findings.length === 1 ? "" : "s"}${
          personal > 0 ? ` · ${personal} personal` : ""
        }</span>
      </div>
      <div class="pv-list" data-list></div>
    `;

    const list = card.querySelector<HTMLElement>("[data-list]")!;
    const selectAll = card.querySelector<HTMLButtonElement>("[data-selectall]")!;

    for (const finding of group.findings) {
      list.appendChild(buildRow(finding, syncSelectAll));
    }

    selectAll.addEventListener("click", () => {
      const allOn = group.findings.every((f) => selected.has(f.path));
      for (const f of group.findings) {
        if (allOn) selected.delete(f.path);
        else selected.add(f.path);
      }
      list.querySelectorAll<HTMLElement>(".pv-row").forEach((row) => {
        applyRowState(row, selected.has(row.dataset.path as string));
      });
      syncSelectAll();
      syncDock();
    });

    function syncSelectAll(): void {
      const on = group.findings.filter((f) => selected.has(f.path)).length;
      const state = on === 0 ? "off" : on === group.findings.length ? "on" : "mixed";
      selectAll.dataset.state = state;
      selectAll.innerHTML = state === "off" ? "" : ICON_CHECK;
    }
    syncSelectAll();

    return card;
  }

  function buildRow(finding: Finding, onChange: () => void): HTMLElement {
    const row = document.createElement("label");
    row.className = "pv-row";
    row.dataset.path = finding.path;
    if (finding.risky) row.classList.add("pv-row-personal");

    const checked = selected.has(finding.path);
    const noteBits: string[] = [];
    if (finding.note) noteBits.push(escapeHtml(finding.note));
    if (finding.stale) noteBits.push("stale");

    row.innerHTML = `
      <span class="pv-check" data-on="${checked}">${checked ? ICON_CHECK : ""}</span>
      <span class="pv-row-main">
        <span class="pv-row-name" title="${escapeHtml(finding.path)}">${escapeHtml(friendlyName(finding.path))}</span>
        <span class="pv-row-sub">
          <span class="pv-row-path">${escapeHtml(shortenPath(finding.path))}</span>
          ${finding.risky ? `<span class="pv-tag">Personal</span>` : ""}
          ${noteBits.length ? `<span class="pv-row-note">${noteBits.join(" · ")}</span>` : ""}
        </span>
      </span>
      <span class="pv-row-size tnum">${formatBytes(finding.size)}</span>
    `;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "pv-visually-hidden";
    checkbox.checked = checked;
    checkbox.setAttribute("aria-label", friendlyName(finding.path));
    row.prepend(checkbox);

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(finding.path);
      else selected.delete(finding.path);
      applyRowState(row, checkbox.checked);
      onChange();
      syncDock();
    });

    return row;
  }

  function syncDock(): void {
    const summary = resultsHost.querySelector<HTMLElement>("[data-summary]");
    const cleanBtn = resultsHost.querySelector<HTMLButtonElement>("[data-clean]");
    const sub = resultsHost.querySelector<HTMLElement>("[data-sub]");
    if (!summary || !cleanBtn) return;

    const all = groups.flatMap((g) => g.findings);
    const totalBytes = all.reduce((s, f) => s + f.size, 0);
    const chosen = all.filter((f) => selected.has(f.path));
    const bytes = chosen.reduce((s, f) => s + f.size, 0);
    const personal = chosen.filter((f) => f.risky).length;

    if (sub) {
      sub.textContent = `${all.length} trace${all.length === 1 ? "" : "s"} found · ${formatBytes(totalBytes)} reclaimable`;
    }

    if (chosen.length === 0) {
      summary.innerHTML = `<span class="pv-dock-count">Nothing selected</span>`;
    } else {
      summary.innerHTML = `
        <span class="pv-dock-size tnum">${formatBytes(bytes)}</span>
        <span class="pv-dock-count">${chosen.length} item${chosen.length === 1 ? "" : "s"} selected${
          personal > 0 ? ` · <span class="pv-dock-personal">${personal} personal</span>` : ""
        }</span>
      `;
    }

    cleanBtn.disabled = busy || chosen.length === 0;
    cleanBtn.textContent = busy ? "…" : "Clean";
    cleanBtn.classList.toggle("is-warn", personal > 0);
  }

  async function cleanSelected(): Promise<void> {
    if (busy) return;
    const all = groups.flatMap((g) => g.findings);
    const chosen = all.filter((f) => selected.has(f.path));
    if (chosen.length === 0) return;

    const bytes = chosen.reduce((s, f) => s + f.size, 0);
    const personal = chosen.filter((f) => f.risky).length;
    const ok = await confirmClean(chosen.length, bytes, personal);
    if (!ok) return;

    busy = true;
    syncDock();
    const rescan = resultsHost.querySelector<HTMLButtonElement>("[data-rescan]");
    if (rescan) rescan.disabled = true;

    try {
      const paths = chosen.map((f) => f.path);
      const result = await api.clean(paths, false);
      const freed = formatBytes(result.freed);
      if (result.failures > 0) {
        toast(
          `Cleared ${freed}, but ${result.failures} item${result.failures === 1 ? "" : "s"} couldn't be removed.`,
          { kind: "warn" }
        );
      } else {
        toast(`Cleared ${freed} of privacy traces.`, { kind: "success" });
      }
    } catch (err) {
      toast(`Clean failed: ${errorMessage(err)}`, { kind: "error" });
    } finally {
      busy = false;
      if (rescan) rescan.disabled = false;
      // Re-scan so the cards reflect what's actually left on disk.
      await load();
    }
  }
}

function applyRowState(row: HTMLElement, on: boolean): void {
  const box = row.querySelector<HTMLElement>(".pv-check")!;
  const input = row.querySelector<HTMLInputElement>("input")!;
  box.dataset.on = String(on);
  box.innerHTML = on ? ICON_CHECK : "";
  input.checked = on;
}

// --- confirm dialog ---------------------------------------------------------

function confirmClean(count: number, bytes: number, personal: number): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pv-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const dialog = document.createElement("div");
    dialog.className = "glass-strong pv-modal";
    dialog.innerHTML = `
      <h3 class="pv-modal-title">Clear ${count} item${count === 1 ? "" : "s"}?</h3>
      <p class="pv-modal-text">
        This moves <strong>${formatBytes(bytes)}</strong> of privacy traces to the Trash.
        Items can be restored until you empty it.
      </p>
      ${
        personal > 0
          ? `<div class="pv-modal-warn">${ICON_ALERT}<span>${personal} personal item${
              personal === 1 ? " is" : "s are"
            } included — clearing them will sign you out and erase that data.</span></div>`
          : ""
      }
    `;

    const actions = document.createElement("div");
    actions.className = "pv-modal-actions";

    const finish = (value: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.classList.add("is-leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(value);
    };

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => finish(false));

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cta-pill";
    confirm.textContent = "Move to Trash";
    confirm.addEventListener("click", () => finish(true));

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

// --- grouping + helpers -----------------------------------------------------

function groupFindings(findings: Finding[]): Group[] {
  const buckets: Record<GroupId, Finding[]> = { browser: [], cookies: [], mail: [] };
  for (const f of findings) buckets[classify(f)].push(f);
  for (const id of GROUP_ORDER) buckets[id].sort((a, b) => b.size - a.size);
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

// --- inline glyphs ----------------------------------------------------------

const ICON_CHECK = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17.5 19 6.5"/></svg>`;

const ICON_ALERT = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

function iconCache(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>`;
}

function iconCookie(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9 4 4 0 0 1-4-4 4 4 0 0 1-4-4 9 9 0 0 0-1-1z"/><circle cx="9" cy="11" r="0.8" fill="currentColor"/><circle cx="13.5" cy="15" r="0.8" fill="currentColor"/><circle cx="8.5" cy="15.5" r="0.8" fill="currentColor"/></svg>`;
}

function iconMail(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>`;
}

// --- scoped styles ----------------------------------------------------------

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.dataset.screen = "privacy";
  style.textContent = STYLES;
  document.head.appendChild(style);
}

const STYLES = `
.pv { gap: 0; }

/* hero stage cross-fades against the results grid */
.pv-stage { animation: fade-up var(--t-slow) var(--ease) both; }
.pv-results { animation: fade-up var(--t-slow) var(--ease) both; }

.pv-hero { padding-top: var(--s-6); padding-bottom: var(--s-7); }
.pv-art {
  transform: translate(var(--px, 0px), var(--py, 0px));
  transition: transform 240ms var(--ease-soft);
}
/* layer the gentle float on top of the parallax offset */
.pv-art > svg { animation: hero-float 6s ease-in-out infinite alternate; }

.pv-cta { margin-top: var(--s-6); }
.pv-cta-scanning {
  margin-top: var(--s-6);
  width: 128px;
  height: 128px;
  border-radius: var(--radius-pill);
  display: grid;
  place-items: center;
  background:
    radial-gradient(120% 120% at 30% 22%, rgba(255,255,255,0.28), transparent 55%),
    linear-gradient(150deg, var(--accent), var(--accent-2));
  box-shadow:
    0 0 0 1px rgba(255,255,255,0.18) inset,
    0 10px 30px var(--glow),
    0 2px 6px rgba(0,0,0,0.35);
  animation: cta-pulse 3.2s var(--ease-soft) infinite;
}
.pv-cta-spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid rgba(255,255,255,0.32);
  border-top-color: #fff;
  animation: spin 800ms linear infinite;
}
.pv-hint {
  margin-top: var(--s-3);
  font-size: 13px;
  color: var(--text-faint);
}

/* --- results grid --- */
.pv-head { margin-bottom: var(--s-4); }
.pv-results { padding-bottom: 132px; }

.pv-card {
  display: flex;
  flex-direction: column;
  padding: 18px 18px 6px;
  animation: fade-up var(--t-slow) var(--ease) both;
}
.pv-card-head {
  display: grid;
  grid-template-columns: 44px 1fr 28px;
  align-items: center;
  gap: 12px;
}
.pv-card-icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  box-shadow: 0 1px 0 0 rgba(255,255,255,0.14) inset;
}
.pv-card-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pv-card-title { font-size: 15px; font-weight: 600; }
.pv-card-blurb {
  font-size: 12.5px;
  color: var(--text-dim);
  line-height: 1.35;
}

.pv-card-stats {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 14px 0 4px;
}
.pv-card-size {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  background: linear-gradient(120deg, var(--accent-2), #fff);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.pv-card-count { font-size: 12.5px; color: var(--text-dim); }

/* per-card select-all toggle */
.pv-selectall {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1.5px solid var(--text-faint);
  background: transparent;
  display: grid;
  place-items: center;
  color: #fff;
  cursor: pointer;
  transition:
    background var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease),
    transform var(--t-fast) var(--ease);
}
.pv-selectall:hover { transform: scale(1.08); border-color: var(--accent-2); }
.pv-selectall[data-state="on"] {
  background: linear-gradient(150deg, var(--accent), var(--accent-2));
  border-color: transparent;
}
.pv-selectall[data-state="mixed"] {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border-color: var(--accent-2);
}
.pv-selectall[data-state="mixed"]::after {
  content: "";
  width: 10px;
  height: 2px;
  border-radius: 2px;
  background: #fff;
}
.pv-selectall:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }

/* finding rows */
.pv-list {
  display: flex;
  flex-direction: column;
  margin: 8px -18px 0;
  border-top: 1px solid var(--hairline);
}
.pv-row {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 11px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--hairline) 55%, transparent);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.pv-row:last-child { border-bottom: none; }
.pv-row:hover { background: rgba(255,255,255,0.05); }

.pv-check {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--text-faint);
  display: grid;
  place-items: center;
  color: #fff;
  transition:
    background var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease),
    transform var(--t-fast) var(--ease);
}
.pv-check[data-on="true"] {
  background: linear-gradient(150deg, var(--accent), var(--accent-2));
  border-color: transparent;
}
.pv-row:hover .pv-check[data-on="false"] { border-color: var(--accent-2); }
.pv-row:active .pv-check { transform: scale(0.9); }

.pv-row-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pv-row-name {
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pv-row-sub { display: flex; align-items: center; gap: 8px; min-width: 0; }
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
  font-size: 13px;
  color: var(--text-dim);
  white-space: nowrap;
}

.pv-row-personal .pv-row-name { color: var(--accent-2); }
.pv-tag {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  color: #fff;
  background: color-mix(in srgb, var(--accent) 30%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-2) 45%, transparent);
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
  outline: 2px solid var(--accent-2);
  outline-offset: -2px;
  border-radius: 10px;
}

/* sticky clean dock */
.pv-dock {
  position: sticky;
  bottom: 0;
  margin-top: var(--s-4);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 14px 14px 24px;
  border-radius: var(--radius-card);
  background: rgba(20, 22, 32, 0.6);
  border: 1px solid var(--hairline);
  -webkit-backdrop-filter: blur(28px) saturate(1.6);
  backdrop-filter: blur(28px) saturate(1.6);
  box-shadow:
    0 1px 0 0 rgba(255,255,255,0.12) inset,
    0 18px 48px rgba(0,0,0,0.42);
}
.pv-dock-summary { display: flex; flex-direction: column; gap: 2px; }
.pv-dock-size {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.pv-dock-count { font-size: 12.5px; color: var(--text-dim); }
.pv-dock-personal { color: var(--accent-2); font-weight: 600; }

.pv-clean {
  --size: 92px;
  font-size: 16px;
}
.pv-clean.is-warn {
  background:
    radial-gradient(120% 120% at 30% 22%, rgba(255,255,255,0.35), transparent 55%),
    linear-gradient(150deg, var(--accent), var(--warn));
}

/* confirm modal */
.pv-modal-overlay {
  position: fixed; inset: 0; z-index: 80;
  display: grid; place-items: center;
  background: rgba(0,0,0,0.5);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  opacity: 0;
  transition: opacity 160ms var(--ease);
}
.pv-modal-overlay.is-open { opacity: 1; }
.pv-modal-overlay.is-leaving { opacity: 0; }
.pv-modal {
  width: min(440px, calc(100vw - 48px));
  padding: 24px;
  transform: scale(0.96) translateY(8px);
  transition: transform 180ms var(--ease-soft);
}
.pv-modal-overlay.is-open .pv-modal { transform: none; }
.pv-modal-title { margin: 0 0 8px; font-size: 18px; }
.pv-modal-text { margin: 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.5; }
.pv-modal-text strong { color: var(--text); }
.pv-modal-warn {
  display: flex; gap: 10px; align-items: flex-start;
  margin-top: 16px; padding: 11px 13px;
  border-radius: var(--radius-tile);
  font-size: 12.5px; line-height: 1.45;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}
.pv-modal-warn svg { flex: 0 0 auto; margin-top: 1px; }
.pv-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }

@media (prefers-reduced-motion: reduce) {
  .pv-art { transform: none; }
}
`;
