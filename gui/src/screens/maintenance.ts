// Maintenance screen. A checklist of macOS housekeeping tasks (flush DNS,
// rebuild Spotlight, reset Launch Services, run the periodic scripts) that free
// no space but keep the system healthy. The selected task labels are passed
// straight to maintenance(tasks) — the backend matches them by their exact
// human label. Several steps need root, so we warn up front and surface the
// failure count afterwards. If the result carries login-item info we show it;
// otherwise we point at System Settings, which is where removal belongs.

import type { Api } from "../api";
import type { ActionResult } from "../types";
import { button, toast, type ButtonHandle } from "../components";

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

interface Row {
  def: TaskDef;
  checked: boolean;
  input: HTMLInputElement;
  row: HTMLElement;
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
    <header class="mt-head">
      <div>
        <h2 class="mt-title">Maintenance</h2>
        <p class="mt-sub">Routine macOS housekeeping. These tasks free no space — they keep search, networking and the apps database healthy.</p>
      </div>
    </header>

    <div class="mt-note" role="note">
      <span class="mt-note-icon">${iconShield()}</span>
      <div class="mt-note-body">
        <span class="mt-note-title">Some tasks need administrator rights</span>
        <span class="mt-note-text">Steps that touch the whole system may prompt for your password or fail with a “try with sudo” hint. Nothing here deletes your files.</span>
      </div>
    </div>

    <section class="mt-card">
      <div class="mt-card-head">
        <label class="mt-all">
          <input type="checkbox" class="mt-check" data-all aria-label="Select all tasks" />
          <span class="mt-all-text">Select tasks</span>
        </label>
        <span class="mt-all-count" data-count></span>
      </div>
      <div class="mt-list" data-list></div>
    </section>

    <div class="mt-login" data-login hidden></div>

    <div class="mt-footer">
      <p class="mt-footer-hint">Selected tasks run in sequence and report any failures.</p>
      <div class="mt-footer-actions" data-actions></div>
    </div>
  `;
  root.appendChild(el);

  const list = el.querySelector<HTMLElement>("[data-list]")!;
  const allBox = el.querySelector<HTMLInputElement>("[data-all]")!;
  const countEl = el.querySelector<HTMLElement>("[data-count]")!;
  const actions = el.querySelector<HTMLElement>("[data-actions]")!;
  const loginPanel = el.querySelector<HTMLElement>("[data-login]")!;

  const rows: Row[] = TASKS.map((def) => buildRow(def, onRowChange));
  for (const r of rows) list.appendChild(r.row);

  const runBtn = button({
    label: "Run maintenance",
    variant: "primary",
    icon: "broom",
    onClick: () => void run(),
  }) as ButtonHandle;
  runBtn.classList.add("mt-run");
  actions.appendChild(runBtn);

  allBox.addEventListener("change", () => {
    for (const r of rows) setRow(r, allBox.checked);
    sync();
  });

  sync();

  function onRowChange(): void {
    sync();
  }

  function selected(): Row[] {
    return rows.filter((r) => r.checked);
  }

  function sync(): void {
    const picked = selected();
    countEl.textContent = picked.length
      ? `${picked.length} of ${rows.length} selected`
      : "None selected";

    allBox.checked = picked.length === rows.length;
    allBox.indeterminate = picked.length > 0 && picked.length < rows.length;

    runBtn.disabled = picked.length === 0;
    runBtn.classList.toggle("is-disabled", picked.length === 0);
  }

  async function run(): Promise<void> {
    const picked = selected();
    if (picked.length === 0) return;

    const needsSudo = picked.some((r) => r.def.sudo);
    const ok = await confirmRun(
      picked.map((r) => r.def.title),
      needsSudo
    );
    if (!ok) return;

    runBtn.setBusy(true);
    runBtn.setLabel("Running…");
    list.classList.add("is-busy");

    let result: ActionResult;
    try {
      result = await api.maintenance(picked.map((r) => r.def.key));
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
        `Maintenance complete — ${picked.length} task${picked.length === 1 ? "" : "s"} run.`,
        { kind: "success" }
      );
    }

    showLoginItems(result as ActionResult & LoginItemsCarrier);
    restore();
  }

  function restore(): void {
    runBtn.setBusy(false);
    runBtn.setLabel("Run maintenance");
    list.classList.remove("is-busy");
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
      tag.className = "mt-login-tag";
      tag.textContent = name;
      tags.appendChild(tag);
    }
    loginPanel.appendChild(tags);
  }
}

function buildRow(def: TaskDef, onChange: () => void): Row {
  const row = document.createElement("label");
  row.className = "mt-item";
  row.classList.add("is-checked");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "mt-check";
  input.checked = true;
  input.setAttribute("aria-label", def.title);

  const glyph = document.createElement("span");
  glyph.className = "mt-item-icon";
  glyph.innerHTML = def.icon;

  const label = document.createElement("span");
  label.className = "mt-item-label";
  label.innerHTML = `
    <span class="mt-item-title">
      ${escapeHtml(def.title)}
      ${def.sudo ? `<span class="mt-badge" title="Needs administrator rights">${iconLock()}sudo</span>` : ""}
    </span>
    <span class="mt-item-blurb">${escapeHtml(def.blurb)}</span>
  `;

  row.appendChild(input);
  row.appendChild(glyph);
  row.appendChild(label);

  const r: Row = { def, checked: true, input, row };
  input.addEventListener("change", () => {
    r.checked = input.checked;
    row.classList.toggle("is-checked", input.checked);
    onChange();
  });
  return r;
}

function setRow(r: Row, checked: boolean): void {
  if (r.checked === checked) return;
  r.checked = checked;
  r.input.checked = checked;
  r.row.classList.toggle("is-checked", checked);
}

// --- confirm dialog ---

function confirmRun(titles: string[], needsSudo: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "mt-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const dialog = document.createElement("div");
    dialog.className = "mt-modal";
    dialog.innerHTML = `
      <h3 class="mt-modal-title">Run ${titles.length} task${titles.length === 1 ? "" : "s"}?</h3>
      <p class="mt-modal-text">These steps modify system state but never delete your files:</p>
      <ul class="mt-modal-list">
        ${titles.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}
      </ul>
      ${
        needsSudo
          ? `<div class="mt-modal-warn">${iconShield()}<span>One or more tasks need administrator rights. macOS may prompt for your password, and a step can fail if it isn't granted.</span></div>`
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
      label: "Run tasks",
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
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>`;
}
function iconSearch(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>`;
}
function iconLayers(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>`;
}
function iconCalendar(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></svg>`;
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

// --- scoped styles ---

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.dataset.screen = "maintenance";
  style.textContent = `
.mt { display: flex; flex-direction: column; gap: 20px; padding-bottom: 40px; animation: mt-fade 220ms ease both; }
@keyframes mt-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.mt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.mt-title { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
.mt-sub { margin: 6px 0 0; color: var(--text-dim); font-size: 14px; max-width: 620px; line-height: 1.5; }

/* sudo note */
.mt-note {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 13px 15px;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--warn) 10%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--warn) 30%, var(--border));
}
.mt-note-icon { flex: none; color: var(--warn); display: grid; place-items: center; margin-top: 1px; }
.mt-note-body { display: flex; flex-direction: column; gap: 2px; }
.mt-note-title { font-size: 13.5px; font-weight: 600; }
.mt-note-text { font-size: 12.5px; color: var(--text-dim); line-height: 1.5; }

/* card */
.mt-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.mt-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 13px 18px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.mt-all { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.mt-all-text { font-size: 13px; font-weight: 600; }
.mt-all-count { font-size: 12px; color: var(--text-faint); font-variant-numeric: tabular-nums; }

.mt-list { display: flex; flex-direction: column; transition: opacity 160ms ease; }
.mt-list.is-busy { opacity: 0.6; pointer-events: none; }

.mt-item {
  display: grid;
  grid-template-columns: 22px 40px 1fr;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  cursor: pointer;
  transition: background 140ms ease;
}
.mt-item:last-child { border-bottom: none; }
.mt-item:hover { background: var(--surface-2); }
.mt-item.is-checked { background: color-mix(in srgb, var(--accent) 8%, transparent); }

.mt-item-icon {
  width: 40px; height: 40px;
  display: grid; place-items: center;
  border-radius: 12px;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.mt-item-label { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mt-item-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.mt-item-blurb { font-size: 12.5px; color: var(--text-dim); line-height: 1.4; }

.mt-badge {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 10px; font-weight: 700; text-transform: lowercase; letter-spacing: 0.02em;
  padding: 2px 7px; border-radius: 999px;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 16%, transparent);
}

/* checkbox (matches the app's accent-fill style) */
.mt-check {
  appearance: none;
  width: 18px; height: 18px;
  border-radius: 6px;
  border: 1.5px solid var(--text-faint);
  background: transparent;
  display: grid; place-items: center;
  cursor: pointer;
  transition: background 140ms ease, border-color 140ms ease;
}
.mt-check:hover { border-color: var(--accent); }
.mt-check:checked, .mt-check:indeterminate {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border-color: transparent;
}
.mt-check:checked::after {
  content: ""; width: 5px; height: 9px;
  border: solid #fff; border-width: 0 2px 2px 0;
  transform: rotate(45deg) translateY(-1px);
}
.mt-check:indeterminate::after { content: ""; width: 9px; height: 2px; background: #fff; border-radius: 1px; }
.mt-check:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }

/* login items */
.mt-login {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  padding: 16px 18px;
  animation: mt-fade 220ms ease both;
}
.mt-login-head { display: flex; gap: 12px; align-items: flex-start; }
.mt-login-icon { flex: none; color: var(--accent-2); display: grid; place-items: center; margin-top: 1px; }
.mt-login-title { display: block; font-size: 14px; font-weight: 600; margin-bottom: 2px; }
.mt-login-text { font-size: 12.5px; color: var(--text-dim); line-height: 1.5; }
.mt-login-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.mt-login-tag {
  font-size: 12px; padding: 4px 10px; border-radius: 999px;
  background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
}

/* footer */
.mt-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mt-footer-hint { margin: 0; font-size: 12.5px; color: var(--text-faint); }
.mt-footer-actions { display: flex; gap: 10px; }
.mt-run.is-disabled { opacity: 0.45; pointer-events: none; }

/* modal */
.mt-modal-overlay {
  position: fixed; inset: 0; z-index: 80;
  display: grid; place-items: center;
  background: rgba(0,0,0,0.5);
  opacity: 0; transition: opacity 160ms ease;
}
.mt-modal-overlay.is-open { opacity: 1; }
.mt-modal-overlay.is-leaving { opacity: 0; }
.mt-modal {
  width: min(440px, calc(100vw - 48px));
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 22px;
  transform: scale(0.96) translateY(8px);
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.mt-modal-overlay.is-open .mt-modal { transform: none; }
.mt-modal-title { margin: 0 0 8px; font-size: 17px; }
.mt-modal-text { margin: 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.5; }
.mt-modal-list { margin: 10px 0 0; padding-left: 18px; color: var(--text); font-size: 13px; line-height: 1.7; }
.mt-modal-warn {
  display: flex; gap: 10px; align-items: flex-start; margin-top: 16px;
  padding: 10px 12px; border-radius: var(--radius); font-size: 12.5px;
  color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent);
}
.mt-modal-warn svg { flex: 0 0 auto; margin-top: 1px; }
.mt-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
`;
  document.head.appendChild(style);
}
