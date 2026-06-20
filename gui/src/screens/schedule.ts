// Schedule screen — the Cyan/Indigo world. Lets the user install, inspect, or
// remove a recurring Smart clean that runs automatically in the background.
// All work goes through api.schedule(action, interval); the active/inactive
// status is reported by the failures field of the ActionResult it returns:
//   schedule("status","")        — read whether a schedule exists
//   schedule("install", interval) — install / update on the chosen cadence
//   schedule("remove","")        — tear the schedule down
// The idle/hero state owns the glossy clock illustration, an interval segmented
// control and the circular CTA; once a schedule is live we cross-fade to a
// compact "active" panel with a Remove action.

import type { Api } from "../api";
import type { ActionResult } from "../types";
import { spinner, toast } from "../components";
import heroRaw from "../assets/illustrations/schedule.svg?raw";

type Interval = "daily" | "weekly" | "monthly";

interface IntervalMeta {
  id: Interval;
  label: string;
  blurb: string;
}

const INTERVALS: IntervalMeta[] = [
  { id: "daily", label: "Daily", blurb: "Every night while you sleep" },
  { id: "weekly", label: "Weekly", blurb: "Once a week, on Sunday" },
  { id: "monthly", label: "Monthly", blurb: "Once a month, on the 1st" },
];

// What a scheduled Smart clean sweeps, surfaced as a friendly explanation.
const SWEEPS = [
  "System and application caches",
  "Developer tool & build artifacts",
  "Stale temporary files and logs",
  "Trash that has piled up",
];

export function renderSchedule(root: HTMLElement, api: Api): void {
  injectStyles();

  const screen = document.createElement("div");
  screen.className = "screen screen-schedule sch";
  root.appendChild(screen);

  // Local view state. `interval` is the user's pending choice for the
  // segmented control; `installed` reflects the last known backend status.
  let interval: Interval = "weekly";
  let installed = false;
  let busy = false;

  showLoading();
  void loadStatus();

  function showLoading(): void {
    const block = document.createElement("div");
    block.className = "sch-state";
    const sp = spinner({ size: 30 });
    const h = document.createElement("p");
    h.className = "sch-state-text";
    h.textContent = "Checking your schedule…";
    block.append(sp, h);
    screen.replaceChildren(block);
  }

  async function loadStatus(): Promise<void> {
    try {
      const res = await api.schedule("status", "");
      installed = isActive(res);
      render();
    } catch (err) {
      showError(err);
    }
  }

  function showError(err: unknown): void {
    const block = document.createElement("div");
    block.className = "sch-state";
    block.innerHTML = `
      <span class="sch-state-icon">${iconWarn()}</span>
      <p class="sch-state-text">Couldn’t read the schedule</p>
      <p class="sch-state-sub">${escapeHtml(message(err))}</p>
    `;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "sch-ghost";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      showLoading();
      void loadStatus();
    });
    block.appendChild(retry);
    screen.replaceChildren(block);
  }

  function render(): void {
    const el = document.createElement("div");
    el.className = "sch-wrap";
    el.innerHTML = `
      <section class="hero sch-hero">
        <span class="eyebrow">Schedule</span>
        <div class="hero-art" aria-hidden="true">${heroRaw}</div>
        <h1 class="title">${installed ? "Sweep runs on its own." : "Set it and forget it."}</h1>
        <p class="subtitle">${
          installed
            ? "A Smart clean runs automatically in the background, so your Mac stays tidy without lifting a finger."
            : "Let Sweep run a Smart clean on a schedule and keep your Mac tidy without lifting a finger."
        }</p>
      </section>
    `;

    const hero = el.querySelector<HTMLElement>(".sch-hero")!;

    if (installed) {
      hero.appendChild(buildActivePanel());
    } else {
      hero.appendChild(buildPicker());
      hero.appendChild(buildCta());
    }

    el.appendChild(buildExplainer());
    screen.replaceChildren(el);
  }

  // --- idle: interval picker + circular CTA -------------------------------

  function buildPicker(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "sch-picker";

    const seg = document.createElement("div");
    seg.className = "sch-seg";
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Cleanup frequency");

    const blurb = document.createElement("p");
    blurb.className = "sch-blurb";

    const buttons: HTMLButtonElement[] = [];
    const sync = () => {
      const meta = INTERVALS.find((i) => i.id === interval)!;
      blurb.textContent = meta.blurb;
      for (const b of buttons) {
        const on = b.dataset.id === interval;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      }
    };
    const move = (delta: number) => {
      const idx = INTERVALS.findIndex((i) => i.id === interval);
      interval = INTERVALS[(idx + delta + INTERVALS.length) % INTERVALS.length].id;
      sync();
      buttons.find((b) => b.dataset.id === interval)?.focus();
    };

    for (const meta of INTERVALS) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "sch-seg-opt";
      opt.textContent = meta.label;
      opt.setAttribute("role", "radio");
      opt.dataset.id = meta.id;
      opt.addEventListener("click", () => {
        if (busy) return;
        interval = meta.id;
        sync();
      });
      opt.addEventListener("keydown", (e) => {
        if (busy) return;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      });
      buttons.push(opt);
      seg.appendChild(opt);
    }

    sync();
    wrap.append(seg, blurb);
    return wrap;
  }

  function buildCta(): HTMLElement {
    const pedestal = document.createElement("div");
    pedestal.className = "sch-cta-pedestal";

    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "cta-circle sch-cta";
    cta.dataset.role = "cta";
    cta.textContent = "Install";
    cta.setAttribute("aria-label", "Install the automatic cleanup schedule");
    cta.addEventListener("click", () => void install());

    const hint = document.createElement("p");
    hint.className = "sch-hint";
    hint.textContent = "Runs a safe Smart clean — never touches your documents.";

    pedestal.append(cta, hint);
    return pedestal;
  }

  // --- active state: status panel + remove --------------------------------

  function buildActivePanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "sch-active glass";
    panel.innerHTML = `
      <span class="sch-active-badge">${iconCheck()}</span>
      <div class="sch-active-body">
        <span class="sch-active-title">Automatic cleanup is on</span>
        <span class="sch-active-text">You can turn it off any time. Nothing already cleaned is affected.</span>
      </div>
      <span class="chip is-ok sch-active-chip">${iconClock()}<span>Active</span></span>
    `;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cta-pill sch-remove";
    remove.dataset.role = "remove";
    remove.innerHTML = `${iconTrash()}<span>Remove schedule</span>`;
    remove.addEventListener("click", () => confirmRemove());

    const foot = document.createElement("div");
    foot.className = "sch-active-foot";
    foot.appendChild(remove);
    panel.appendChild(foot);
    return panel;
  }

  function buildExplainer(): HTMLElement {
    const c = document.createElement("section");
    c.className = "sch-explain glass";
    c.innerHTML = `
      <div class="sch-explain-head">
        <span class="sch-explain-icon">${iconBroom()}</span>
        <div class="sch-explain-text">
          <span class="sch-explain-title">What runs automatically</span>
          <span class="sch-explain-sub">Each run performs a Smart clean — the same safe sweep you get from the dashboard. It only touches caches and junk that are safe to remove.</span>
        </div>
      </div>
      <ul class="sch-sweeps">
        ${SWEEPS.map(
          (s) => `<li><span class="sch-tick">${iconCheck()}</span><span>${escapeHtml(s)}</span></li>`
        ).join("")}
      </ul>
    `;
    return c;
  }

  // --- api flows ----------------------------------------------------------

  async function install(): Promise<void> {
    if (busy) return;
    setBusy(true, "cta", "Installing…");
    try {
      const res = await api.schedule("install", interval);
      if (res.failures > 0) {
        toast(`Couldn’t install the schedule (${res.failures} step failed)`, {
          kind: "error",
        });
      } else {
        installed = true;
        const meta = INTERVALS.find((i) => i.id === interval)!;
        toast(`Smart clean scheduled — ${meta.label.toLowerCase()}.`, {
          kind: "success",
        });
      }
    } catch (err) {
      toast(`Install failed: ${message(err)}`, { kind: "error" });
    } finally {
      busy = false;
      render();
    }
  }

  function confirmRemove(): void {
    if (busy) return;
    void openConfirm({
      title: "Remove the automatic cleanup?",
      body: "Sweep will stop cleaning on its own. Nothing already cleaned is affected — you can re-enable a schedule any time.",
      confirmLabel: "Remove schedule",
    }).then((ok) => {
      if (ok) void remove();
    });
  }

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true, "remove", "Removing…");
    try {
      const res = await api.schedule("remove", "");
      if (res.failures > 0) {
        toast(`Couldn’t fully remove the schedule (${res.failures} step failed)`, {
          kind: "warn",
        });
      } else {
        installed = false;
        toast("Automatic cleanup removed.", { kind: "success" });
      }
    } catch (err) {
      toast(`Remove failed: ${message(err)}`, { kind: "error" });
    } finally {
      busy = false;
      render();
    }
  }

  function setBusy(next: boolean, role: string, label: string): void {
    busy = next;
    const btn = screen.querySelector<HTMLButtonElement>(`[data-role="${role}"]`);
    if (!btn) return;
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
    const sp = spinner({ size: role === "cta" ? 24 : 16 });
    if (role === "cta") {
      btn.replaceChildren(sp);
    } else {
      btn.replaceChildren(sp, withText(label));
    }
  }
}

// ---------- helpers (module-scoped, no external deps) ----------

// A "status" call returns ActionResult; an active schedule reports no
// failures, while the absence of one surfaces as a non-zero failure count.
function isActive(res: ActionResult): boolean {
  return res.failures === 0;
}

function withText(text: string): Text {
  return document.createTextNode(` ${text}`);
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
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

// A scoped, accessible confirm dialog (the components barrel ships no modal).
// Premium fade/scale entrance; Esc and backdrop dismiss; returns the choice.
interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
}

function openConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "sch-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    const dialog = document.createElement("div");
    dialog.className = "sch-modal glass-strong";
    dialog.innerHTML = `
      <h3 class="sch-modal-title">${escapeHtml(opts.title)}</h3>
      <p class="sch-modal-text">${escapeHtml(opts.body)}</p>
    `;

    const actions = document.createElement("div");
    actions.className = "sch-modal-actions";

    const finish = (value: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.classList.add("is-leaving");
      window.setTimeout(() => overlay.remove(), 160);
      resolve(value);
    };

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "sch-ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => finish(false));

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cta-pill sch-modal-confirm";
    confirm.textContent = opts.confirmLabel;
    confirm.addEventListener("click", () => finish(true));

    actions.append(cancel, confirm);
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

// ---------- inline icons ----------

function iconClock(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`;
}
function iconCheck(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17.5 19 7"/></svg>`;
}
function iconBroom(): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 4.5 12 12"/><path d="M14 6.5 17.5 10"/><path d="M11.5 11.5 6 17c-1 1-2.5 1.5-4 1.5 1-1.5 1.5-3 1.5-4l5.5-5.5"/><path d="m8 15 1.5 1.5"/></svg>`;
}
function iconTrash(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>`;
}
function iconWarn(): string {
  return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v5"/><path d="M12 18h.01"/></svg>`;
}

// ---------- scoped styling injected once ----------

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.dataset.screen = "schedule";
  style.textContent = `
.sch {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 880px;
  margin: 0 auto;
  padding: var(--s-5) var(--s-4) var(--s-7);
}
.sch-wrap {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  animation: fade-up var(--t-slow) var(--ease) both;
}

/* hero */
.sch-hero { padding-top: var(--s-4); padding-bottom: var(--s-4); width: 100%; }
.sch-hero .hero-art { width: 240px; height: 240px; }

/* loading / error state */
.sch-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-7) var(--s-4);
  text-align: center;
  animation: fade-up var(--t-slow) var(--ease) both;
}
.sch-state-icon { color: var(--warn); display: grid; place-items: center; }
.sch-state-text { margin: 0; font-size: 17px; font-weight: 600; color: var(--text); }
.sch-state-sub { margin: 0; font-size: 13.5px; color: var(--text-dim); max-width: 46ch; }

/* segmented interval control */
.sch-picker {
  margin-top: var(--s-5);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-2);
}
.sch-seg {
  display: inline-grid;
  grid-auto-flow: column;
  gap: 4px;
  padding: 5px;
  border-radius: var(--radius-pill);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--hairline);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  backdrop-filter: blur(20px) saturate(1.4);
}
.sch-seg-opt {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  padding: 9px 22px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition:
    color var(--t-fast) var(--ease),
    background var(--t-base) var(--ease),
    box-shadow var(--t-base) var(--ease);
}
.sch-seg-opt:hover { color: var(--text); }
.sch-seg-opt.is-active {
  color: #fff;
  background: linear-gradient(150deg, var(--accent), var(--accent-2));
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.18) inset,
    0 6px 18px var(--glow);
}
.sch-seg-opt:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 3px; }
.sch-blurb {
  margin: 0;
  min-height: 1.2em;
  font-size: 13px;
  color: var(--text-faint);
  text-align: center;
}

/* circular CTA */
.sch-cta-pedestal {
  margin-top: var(--s-6);
  margin-bottom: calc(-1 * var(--s-2));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-4);
}
.sch-cta { --size: 132px; }
.sch-cta .spinner { --spinner-track: rgba(255, 255, 255, 0.35); }
.sch-hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-faint);
  text-align: center;
}

/* active panel */
.sch-active {
  width: 100%;
  max-width: 560px;
  margin-top: var(--s-5);
  padding: 20px;
  display: grid;
  grid-template-columns: 48px 1fr auto;
  align-items: center;
  gap: var(--s-3);
  animation: fade-up var(--t-base) var(--ease) both;
}
.sch-active-badge {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  color: #fff;
  background: linear-gradient(150deg, var(--accent), var(--accent-2));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    0 8px 22px var(--glow);
}
.sch-active-badge svg { width: 22px; height: 22px; }
.sch-active-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.sch-active-title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.sch-active-text { font-size: 13px; color: var(--text-dim); line-height: 1.45; }
.sch-active-chip { align-self: center; }
.sch-active-foot {
  grid-column: 1 / -1;
  margin-top: 4px;
  padding-top: var(--s-3);
  border-top: 1px solid var(--hairline);
  display: flex;
  justify-content: flex-end;
}
.sch-remove {
  height: 42px;
  padding: 0 18px;
  font-size: 14px;
  background:
    radial-gradient(120% 120% at 30% 22%, rgba(255, 255, 255, 0.22), transparent 55%),
    linear-gradient(150deg, color-mix(in srgb, var(--danger) 92%, #000), var(--danger));
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.16) inset,
    0 8px 22px color-mix(in srgb, var(--danger) 45%, transparent),
    0 2px 6px rgba(0, 0, 0, 0.32);
}

/* explainer */
.sch-explain {
  width: 100%;
  margin-top: var(--s-5);
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  animation: fade-up var(--t-slow) var(--ease) both;
}
.sch-explain-head { display: flex; gap: var(--s-3); align-items: flex-start; }
.sch-explain-icon {
  flex: none;
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 15px;
  color: var(--accent-2);
  background:
    radial-gradient(120% 120% at 30% 20%, rgba(255, 255, 255, 0.18), transparent 60%),
    color-mix(in srgb, var(--accent) 22%, transparent);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.sch-explain-text { display: flex; flex-direction: column; gap: 4px; }
.sch-explain-title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.sch-explain-sub { font-size: 13px; color: var(--text-dim); line-height: 1.5; }
.sch-sweeps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px 20px;
}
.sch-sweeps li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13.5px;
  color: var(--text);
}
.sch-tick {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-pill);
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 16%, transparent);
}

/* shared ghost button */
.sch-ghost {
  appearance: none;
  border: 1px solid var(--hairline);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  padding: 10px 18px;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition:
    background var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease),
    transform var(--t-fast) var(--ease);
}
.sch-ghost:hover { background: rgba(255, 255, 255, 0.1); }
.sch-ghost:active { transform: scale(0.98); }
.sch-ghost:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 3px; }

/* confirm modal */
.sch-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(4, 5, 12, 0.55);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  opacity: 0;
  transition: opacity 160ms ease;
}
.sch-modal-overlay.is-open { opacity: 1; }
.sch-modal-overlay.is-leaving { opacity: 0; }
.sch-modal {
  width: min(420px, calc(100vw - 48px));
  padding: 24px;
  transform: scale(0.96) translateY(8px);
  transition: transform 180ms var(--ease-soft);
}
.sch-modal-overlay.is-open .sch-modal { transform: none; }
.sch-modal-title { margin: 0 0 8px; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
.sch-modal-text { margin: 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.55; }
.sch-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
.sch-modal-confirm {
  height: 42px;
  padding: 0 18px;
  font-size: 14px;
  background:
    radial-gradient(120% 120% at 30% 22%, rgba(255, 255, 255, 0.22), transparent 55%),
    linear-gradient(150deg, color-mix(in srgb, var(--danger) 92%, #000), var(--danger));
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.16) inset,
    0 8px 22px color-mix(in srgb, var(--danger) 45%, transparent),
    0 2px 6px rgba(0, 0, 0, 0.32);
}

@media (max-width: 560px) {
  .sch-active { grid-template-columns: 48px 1fr; }
  .sch-active-chip { grid-column: 2; justify-self: start; }
  .sch-sweeps { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .sch-wrap, .sch-state, .sch-active, .sch-explain { animation-duration: 0.01ms; }
}
`;
  document.head.appendChild(style);
}
