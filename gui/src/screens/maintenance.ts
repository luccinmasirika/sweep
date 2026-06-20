// Maintenance screen — the Performance world (orange/amber). A curated set of
// macOS housekeeping routines (flush DNS, rebuild Spotlight, reset Launch
// Services, run the periodic scripts) that free no space but keep the system
// healthy. Each routine is a glass card you can toggle on/off; the selected
// card labels are passed straight to maintenance(tasks) — the backend matches
// them by their exact human label. Several steps need root, so we warn up front
// and surface the failure count afterwards. If the result carries login-item
// info we show it; otherwise we point at System Settings, where removal belongs.

import type { Api } from "../api";
import type { ActionResult } from "../types";
import { button, toast } from "../components";
import heroRaw from "../assets/illustrations/maintenance.svg?raw";

// Task keys are the exact labels the sweep crate matches against. Keep them in
// sync with src/maintenance.rs::TASKS.
interface TaskDef {
  key: string;
  title: string;
  blurb: string;
  icon: string;
  sudo: boolean;
}

const TASKS: TaskDef[] = [
  {
    key: "Flush the DNS cache",
    title: "Flush DNS cache",
    blurb: "Clears stale name lookups so the system resolves fresh records.",
    icon: iconGlobe(),
    sudo: true,
  },
  {
    key: "Rebuild the Spotlight index",
    title: "Rebuild Spotlight index",
    blurb: "Reindexes the boot volume to fix slow or incomplete search.",
    icon: iconSearch(),
    sudo: true,
  },
  {
    key: 'Reset Launch Services (fix duplicate "Open With" entries)',
    title: "Reset Launch Services",
    blurb: 'Rebuilds the apps database to fix duplicate “Open With” entries.',
    icon: iconLayers(),
    sudo: false,
  },
  {
    key: "Run the periodic maintenance scripts",
    title: "Run periodic scripts",
    blurb: "Runs the daily, weekly and monthly system upkeep scripts.",
    icon: iconCalendar(),
    sudo: true,
  },
];

interface Card {
  def: TaskDef;
  selected: boolean;
  el: HTMLElement;
}

// The GUI maintenance() returns only a failure count, but a future backend may
// attach the read-only login-items list it already gathers. Read it defensively
// so we light up the panel the moment it ships, without breaking today.
interface LoginItemsCarrier {
  login_items?: string[];
}

export function renderMaintenance(root: HTMLElement, api: Api): void {
  injectStyles();

  const el = document.createElement("div");
  el.className = "screen screen-maintenance mt";
  el.innerHTML = `
    <section class="hero mt-hero">
      <span class="eyebrow">Performance</span>
      <div class="hero-art" aria-hidden="true">${heroRaw}</div>
      <h1 class="title">Tune up your Mac.</h1>
      <p class="subtitle">Routine housekeeping that keeps search, networking and the apps database fast. These tasks free no space — they keep things humming.</p>
      <div class="mt-cta-pedestal">
        <button type="button" class="cta-circle mt-cta" aria-label="Run selected maintenance tasks">Run</button>
      </div>
      <p class="mt-hint" data-hint></p>
    </section>

    <section class="mt-recos" aria-label="Maintenance routines">
      <div class="mt-recos-head">
        <span class="mt-recos-eyebrow">Recommended routines</span>
        <button type="button" class="mt-toggle-all" data-toggle-all></button>
      </div>
      <div class="grid mt-grid" data-grid></div>

      <div class="mt-note glass" role="note">
        <span class="mt-note-icon">${iconShield()}</span>
        <div class="mt-note-body">
          <span class="mt-note-title">Some routines need administrator rights</span>
          <span class="mt-note-text">System-wide steps may prompt for your password or fail with a “try with sudo” hint. Nothing here deletes your files.</span>
        </div>
      </div>

      <div class="mt-login glass" data-login hidden></div>
    </section>
  `;
  root.appendChild(el);

  const grid = el.querySelector<HTMLElement>("[data-grid]")!;
  const cta = el.querySelector<HTMLButtonElement>(".mt-cta")!;
  const hint = el.querySelector<HTMLElement>("[data-hint]")!;
  const toggleAll = el.querySelector<HTMLButtonElement>("[data-toggle-all]")!;
  const loginPanel = el.querySelector<HTMLElement>("[data-login]")!;

  const cards: Card[] = TASKS.map((def) => buildCard(def, onCardChange));
  for (const c of cards) grid.appendChild(c.el);

  cta.addEventListener("click", () => void run());
  toggleAll.addEventListener("click", () => {
    const allOn = cards.every((c) => c.selected);
    for (const c of cards) setCard(c, !allOn);
    sync();
  });

  let busy = false;
  sync();

  function onCardChange(): void {
    sync();
  }

  function selected(): Card[] {
    return cards.filter((c) => c.selected);
  }

  function sync(): void {
    const picked = selected();
    const all = picked.length === cards.length;

    toggleAll.textContent = all ? "Clear all" : "Select all";

    cta.textContent = busy ? "Running…" : "Run";
    const disabled = busy || picked.length === 0;
    cta.disabled = disabled;
    cta.setAttribute("aria-disabled", String(disabled));

    if (busy) {
      hint.textContent = "Running routines in sequence…";
    } else if (picked.length === 0) {
      hint.textContent = "Select at least one routine to run.";
    } else {
      const needsSudo = picked.some((c) => c.def.sudo);
      hint.textContent = needsSudo
        ? `${picked.length} routine${picked.length === 1 ? "" : "s"} selected · some need administrator rights`
        : `${picked.length} routine${picked.length === 1 ? "" : "s"} selected`;
    }
  }

  async function run(): Promise<void> {
    const picked = selected();
    if (picked.length === 0 || busy) return;

    const needsSudo = picked.some((c) => c.def.sudo);
    const ok = await confirmRun(picked.map((c) => c.def.title), needsSudo);
    if (!ok) return;

    busy = true;
    grid.classList.add("is-busy");
    sync();

    let result: ActionResult;
    try {
      result = await api.maintenance(picked.map((c) => c.def.key));
    } catch (err) {
      toast(`Maintenance failed: ${message(err)}`, { kind: "error" });
      restore();
      return;
    }

    if (result.failures > 0) {
      toast(
        `Finished with ${result.failures} step${result.failures === 1 ? "" : "s"} that need administrator rights.`,
        { kind: "warn" }
      );
    } else {
      toast(
        `Maintenance complete — ${picked.length} routine${picked.length === 1 ? "" : "s"} run.`,
        { kind: "success" }
      );
    }

    showLoginItems(result as ActionResult & LoginItemsCarrier);
    restore();
  }

  function restore(): void {
    busy = false;
    grid.classList.remove("is-busy");
    sync();
  }

  function showLoginItems(result: ActionResult & LoginItemsCarrier): void {
    const items = Array.isArray(result.login_items) ? result.login_items : [];
    if (items.length === 0) {
      loginPanel.hidden = true;
      loginPanel.innerHTML = "";
      return;
    }

    loginPanel.hidden = false;
    loginPanel.innerHTML = `
      <div class="mt-login-head">
        <span class="mt-login-icon">${iconPower()}</span>
        <div>
          <span class="mt-login-title">Login items</span>
          <span class="mt-login-text">These apps launch when you sign in. Remove unwanted ones in System Settings › General › Login Items.</span>
        </div>
      </div>
    `;
    const tags = document.createElement("div");
    tags.className = "mt-login-tags";
    for (const name of items) {
      const tag = document.createElement("span");
      tag.className = "chip mt-login-tag";
      tag.textContent = name;
      tags.appendChild(tag);
    }
    loginPanel.appendChild(tags);
  }
}

function buildCard(def: TaskDef, onChange: () => void): Card {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "glass-card is-hoverable is-selected mt-card";
  node.setAttribute("role", "switch");
  node.setAttribute("aria-checked", "true");
  node.setAttribute("aria-label", def.title);
  node.innerHTML = `
    <span class="mt-card-icon">${def.icon}</span>
    <span class="mt-card-body">
      <span class="mt-card-title">
        ${escapeHtml(def.title)}
        ${def.sudo ? `<span class="mt-badge" title="Needs administrator rights">${iconLock()}sudo</span>` : ""}
      </span>
      <span class="mt-card-blurb">${escapeHtml(def.blurb)}</span>
    </span>
    <span class="mt-card-mark" aria-hidden="true">${iconCheck()}</span>
  `;

  const c: Card = { def, selected: true, el: node };
  node.addEventListener("click", () => {
    setCard(c, !c.selected);
    onChange();
  });
  return c;
}

function setCard(c: Card, selected: boolean): void {
  if (c.selected === selected) return;
  c.selected = selected;
  c.el.classList.toggle("is-selected", selected);
  c.el.setAttribute("aria-checked", String(selected));
}

// --- confirm dialog ---

function confirmRun(titles: string[], needsSudo: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "mt-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const dialog = document.createElement("div");
    dialog.className = "mt-modal glass-strong";
    dialog.innerHTML = `
      <h3 class="mt-modal-title">Run ${titles.length} routine${titles.length === 1 ? "" : "s"}?</h3>
      <p class="mt-modal-text">These steps modify system state but never delete your files:</p>
      <ul class="mt-modal-list">
        ${titles.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}
      </ul>
      ${
        needsSudo
          ? `<div class="mt-modal-warn">${iconShield()}<span>One or more routines need administrator rights. macOS may prompt for your password, and a step can fail if it isn't granted.</span></div>`
          : ""
      }
    `;

    const actions = document.createElement("div");
    actions.className = "mt-modal-actions";

    const finish = (value: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.classList.add("is-leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(value);
    };

    const cancel = button({
      label: "Cancel",
      variant: "ghost",
      onClick: () => finish(false),
    });
    const confirm = button({
      label: "Run routines",
      variant: "primary",
      onClick: () => finish(true),
    });

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

function iconGlobe(): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>`;
}
function iconSearch(): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>`;
}
function iconLayers(): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>`;
}
function iconCalendar(): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>`;
}
function iconShield(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"/><path d="M9.5 12l1.7 1.7L15 10"/></svg>`;
}
function iconLock(): string {
  return `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
}
function iconPower(): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>`;
}
function iconCheck(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17.5 19 7"/></svg>`;
}

// --- scoped styles ---

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.dataset.screen = "maintenance";
  style.textContent = `
.mt {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 880px;
  margin: 0 auto;
  padding: var(--s-5) var(--s-4) var(--s-7);
  animation: fade-up var(--t-slow) var(--ease) both;
}

/* hero */
.mt-hero { padding-top: var(--s-4); padding-bottom: var(--s-4); }
.mt-hero .hero-art { width: 240px; height: 240px; }

.mt-cta-pedestal {
  margin-top: var(--s-6);
  margin-bottom: calc(-1 * var(--s-2));
  display: grid;
  place-items: center;
}
.mt-cta { --size: 132px; }

.mt-hint {
  margin: var(--s-4) 0 0;
  min-height: 1.2em;
  font-size: 13px;
  color: var(--text-faint);
  text-align: center;
  transition: opacity var(--t-base) var(--ease);
}

/* curated routines */
.mt-recos {
  width: 100%;
  margin-top: var(--s-6);
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  animation: fade-up var(--t-slow) var(--ease) both;
}
.mt-recos-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-3);
  padding: 0 var(--s-1);
}
.mt-recos-eyebrow {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
}
.mt-toggle-all {
  background: none;
  border: none;
  padding: 4px 2px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-2);
  cursor: pointer;
  border-radius: 8px;
  transition: color var(--t-fast) var(--ease), opacity var(--t-fast) var(--ease);
}
.mt-toggle-all:hover { opacity: 0.82; }
.mt-toggle-all:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 3px; }

.mt-grid { transition: opacity var(--t-base) var(--ease); }
.mt-grid.is-busy { opacity: 0.55; pointer-events: none; }

/* routine card */
.mt-card {
  display: grid;
  grid-template-columns: 52px 1fr 24px;
  align-items: center;
  gap: var(--s-3);
  width: 100%;
  text-align: left;
  padding: 18px 20px;
  color: var(--text);
  font: inherit;
}
.mt-card-icon {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  color: var(--accent-2);
  background:
    radial-gradient(120% 120% at 30% 20%, rgba(255, 255, 255, 0.18), transparent 60%),
    color-mix(in srgb, var(--accent) 22%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.mt-card-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.mt-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.mt-card-blurb { font-size: 13px; color: var(--text-dim); line-height: 1.45; }

.mt-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 700;
  text-transform: lowercase;
  letter-spacing: 0.02em;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 18%, transparent);
}

/* selection mark */
.mt-card-mark {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-pill);
  color: transparent;
  border: 1.5px solid var(--text-faint);
  background: transparent;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.mt-card.is-selected .mt-card-mark {
  color: #fff;
  border-color: transparent;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
}
.mt-card:not(.is-selected) {
  border-color: var(--hairline);
  box-shadow:
    0 1px 0 0 rgba(255, 255, 255, 0.08) inset,
    0 14px 38px rgba(0, 0, 0, 0.3);
}
.mt-card:not(.is-selected) .mt-card-icon { color: var(--text-faint); background: rgba(255, 255, 255, 0.06); box-shadow: none; }
.mt-card:not(.is-selected) .mt-card-blurb { color: var(--text-faint); }

/* sudo note */
.mt-note {
  display: flex;
  gap: var(--s-3);
  align-items: flex-start;
  padding: 14px 18px;
  margin-top: var(--s-2);
}
.mt-note-icon { flex: none; color: var(--warn); display: grid; place-items: center; margin-top: 1px; }
.mt-note-body { display: flex; flex-direction: column; gap: 3px; }
.mt-note-title { font-size: 13.5px; font-weight: 600; }
.mt-note-text { font-size: 12.5px; color: var(--text-dim); line-height: 1.5; }

/* login items */
.mt-login { padding: 18px; animation: fade-up var(--t-slow) var(--ease) both; }
.mt-login-head { display: flex; gap: var(--s-3); align-items: flex-start; }
.mt-login-icon { flex: none; color: var(--accent-2); display: grid; place-items: center; margin-top: 1px; }
.mt-login-title { display: block; font-size: 14px; font-weight: 600; margin-bottom: 2px; }
.mt-login-text { font-size: 12.5px; color: var(--text-dim); line-height: 1.5; }
.mt-login-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.mt-login-tag { color: var(--text); }

/* modal */
.mt-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.5);
  opacity: 0;
  transition: opacity 160ms ease;
}
.mt-modal-overlay.is-open { opacity: 1; }
.mt-modal-overlay.is-leaving { opacity: 0; }
.mt-modal {
  width: min(440px, calc(100vw - 48px));
  padding: 24px;
  transform: scale(0.96) translateY(8px);
  transition: transform 180ms var(--ease-soft);
}
.mt-modal-overlay.is-open .mt-modal { transform: none; }
.mt-modal-title { margin: 0 0 8px; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
.mt-modal-text { margin: 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.5; }
.mt-modal-list { margin: 12px 0 0; padding-left: 18px; color: var(--text); font-size: 13px; line-height: 1.7; }
.mt-modal-warn {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-top: 16px;
  padding: 11px 13px;
  border-radius: var(--radius-tile);
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}
.mt-modal-warn svg { flex: 0 0 auto; margin-top: 1px; }
.mt-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }

@media (prefers-reduced-motion: reduce) {
  .mt, .mt-recos, .mt-login { animation-duration: 0.01ms; }
}
`;
  document.head.appendChild(style);
}
