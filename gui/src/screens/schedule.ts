// Schedule screen. Lets the user install, inspect, or remove a recurring
// Smart clean that runs automatically in the background. All work goes
// through api.schedule(action, interval); status is reported by the
// failures field of the ActionResult it returns.

import type { Api } from "../api";
import type { ActionResult } from "../types";
import { button, card, spinner, toast } from "../components";

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

const ICON_CLOCK = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5"/><path d="M9 3.5h6" opacity="0.5"/><path d="M12 3.5V5" opacity="0.5"/></svg>`;
const ICON_BROOM = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 4.5 12 12"/><path d="M14 6.5 17.5 10"/><path d="M11.5 11.5 6 17a3 3 0 0 0 0 0c-1 1-2.5 1.5-4 1.5 1-1.5 1.5-3 1.5-4l5.5-5.5"/><path d="m8 15 1.5 1.5"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>`;
const ICON_BOLT = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>`;
const ICON_WARN = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v5"/><path d="M12 18h.01"/></svg>`;

// What a Smart clean sweeps, surfaced as a friendly explanation.
const SWEEPS = [
  "System and application caches",
  "Developer tool & build artifacts",
  "Stale temporary files and logs",
  "Trash that has piled up",
];

export function renderSchedule(root: HTMLElement, api: Api): void {
  const screen = document.createElement("div");
  screen.className = "screen screen-schedule";
  root.appendChild(screen);

  injectStyles();

  // Local view state. `interval` is the user's pending choice for the
  // segmented control; `installed` reflects the last known backend status.
  let interval: Interval = "weekly";
  let installed = false;
  let busy = false;

  showLoading();
  void loadStatus();

  function showLoading(): void {
    screen.replaceChildren(
      stateBlock(() => {
        const sp = spinner();
        sp.classList.add("is-lg");
        return [sp, textNode("h3", "Checking your schedule…")];
      })
    );
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
    screen.replaceChildren(
      stateBlock(() => {
        const icon = svg(ICON_WARN, "state-icon");
        const retry = button({
          label: "Try again",
          variant: "ghost",
          onClick: () => {
            showLoading();
            void loadStatus();
          },
        });
        return [
          icon,
          textNode("h3", "Couldn’t read the schedule"),
          textNode("p", String(messageOf(err))),
          retry,
        ];
      })
    );
  }

  function render(): void {
    const frag = document.createDocumentFragment();
    frag.appendChild(buildHeader());
    frag.appendChild(buildStatusCard());
    frag.appendChild(buildPickerCard());
    frag.appendChild(buildExplainerCard());
    screen.replaceChildren(frag);
  }

  function buildHeader(): HTMLElement {
    const head = document.createElement("div");
    head.className = "sched-head";
    const title = document.createElement("div");
    title.className = "sched-head-text";
    title.innerHTML = `<h1>Automatic cleanups</h1>`;
    const sub = document.createElement("p");
    sub.textContent =
      "Let Sweep run a Smart clean on a schedule so your Mac stays tidy without lifting a finger.";
    title.appendChild(sub);
    head.appendChild(title);
    return head;
  }

  function buildStatusCard(): HTMLElement {
    const c = card({ className: "sched-status" });

    const badge = document.createElement("div");
    badge.className = `sched-badge ${installed ? "is-on" : "is-off"}`;
    badge.innerHTML = installed ? ICON_CHECK : ICON_CLOCK;

    const main = document.createElement("div");
    main.className = "sched-status-main";
    const h = document.createElement("h3");
    h.className = "card-title";
    h.style.margin = "0";
    h.textContent = installed ? "Schedule is active" : "No schedule yet";
    const p = document.createElement("p");
    p.className = "sched-status-sub";
    p.textContent = installed
      ? "Sweep automatically runs a Smart clean in the background. You can change how often, or remove it entirely."
      : "Sweep only cleans when you ask. Turn on a schedule below to keep things tidy automatically.";
    main.append(h, p);

    const pill = document.createElement("span");
    pill.className = `chip ${installed ? "is-ok" : ""}`;
    pill.textContent = installed ? "On" : "Off";

    const head = document.createElement("div");
    head.className = "sched-status-head";
    head.append(badge, main, pill);
    c.appendChild(head);

    if (installed) {
      const remove = button({
        label: "Remove schedule",
        variant: "danger",
        onClick: () => confirmRemove(),
      });
      remove.prepend(svg(ICON_TRASH));
      remove.dataset.role = "remove";
      const actions = document.createElement("div");
      actions.className = "sched-status-actions";
      actions.appendChild(remove);
      c.appendChild(actions);
    }

    return c;
  }

  function buildPickerCard(): HTMLElement {
    const c = card({ className: "sched-picker" });

    const label = document.createElement("div");
    label.className = "section-title";
    label.textContent = "How often";
    c.appendChild(label);

    const seg = document.createElement("div");
    seg.className = "segmented";
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "Cleanup frequency");

    const blurb = document.createElement("p");
    blurb.className = "sched-blurb";

    const buttons: HTMLButtonElement[] = [];
    const sync = () => {
      const meta = INTERVALS.find((i) => i.id === interval)!;
      blurb.textContent = meta.blurb;
      buttons.forEach((b) => {
        const on = b.dataset.id === interval;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      });
    };
    const move = (delta: number) => {
      const idx = INTERVALS.findIndex((i) => i.id === interval);
      interval =
        INTERVALS[(idx + delta + INTERVALS.length) % INTERVALS.length].id;
      sync();
      buttons.find((b) => b.dataset.id === interval)?.focus();
    };

    INTERVALS.forEach((meta) => {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "segmented-opt";
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
    });

    sync();

    c.append(seg, blurb);

    const cta = button({
      label: installed ? "Update schedule" : "Install schedule",
      variant: "primary",
      onClick: () => void install(),
    });
    cta.classList.add("btn-lg");
    cta.prepend(svg(installed ? ICON_BOLT : ICON_CLOCK));
    cta.dataset.role = "cta";

    const ctaRow = document.createElement("div");
    ctaRow.className = "sched-cta";
    ctaRow.appendChild(cta);
    c.appendChild(ctaRow);

    return c;
  }

  function buildExplainerCard(): HTMLElement {
    const c = card({ className: "sched-explain" });
    const head = document.createElement("div");
    head.className = "sched-explain-head";
    head.appendChild(svg(ICON_BROOM, "sched-explain-icon"));
    const ht = document.createElement("div");
    ht.innerHTML = `<h3 class="card-title" style="margin:0">What runs automatically</h3>`;
    const p = document.createElement("p");
    p.className = "sched-status-sub";
    p.textContent =
      "Each run performs a Smart clean — the same safe sweep you get from the dashboard. It only touches caches and junk that are safe to remove, and never your documents.";
    ht.appendChild(p);
    head.appendChild(ht);
    c.appendChild(head);

    const list = document.createElement("ul");
    list.className = "sched-sweeps";
    SWEEPS.forEach((s) => {
      const li = document.createElement("li");
      li.appendChild(svg(ICON_CHECK, "sched-sweep-tick"));
      const span = document.createElement("span");
      span.textContent = s;
      li.appendChild(span);
      list.appendChild(li);
    });
    c.appendChild(list);
    return c;
  }

  async function install(): Promise<void> {
    if (busy) return;
    setBusy(true, "cta", installed ? "Updating…" : "Installing…");
    try {
      const res = await api.schedule("install", interval);
      if (res.failures > 0) {
        toast(`Couldn’t install the schedule (${res.failures} step failed)`);
      } else {
        installed = true;
        const meta = INTERVALS.find((i) => i.id === interval)!;
        toast(`Smart clean scheduled — ${meta.label.toLowerCase()}.`);
      }
    } catch (err) {
      toast(`Install failed: ${messageOf(err)}`);
    } finally {
      setBusy(false);
      render();
    }
  }

  function confirmRemove(): void {
    openConfirm({
      title: "Remove the automatic cleanup?",
      body:
        "Sweep will stop cleaning on its own. Nothing already cleaned is affected — you can re-enable a schedule any time.",
      confirmLabel: "Remove schedule",
      onConfirm: () => void remove(),
    });
  }

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true, "remove", "Removing…");
    try {
      const res = await api.schedule("remove", "");
      if (res.failures > 0) {
        toast(`Couldn’t fully remove the schedule (${res.failures} step failed)`);
      } else {
        installed = false;
        toast("Automatic cleanup removed.");
      }
    } catch (err) {
      toast(`Remove failed: ${messageOf(err)}`);
    } finally {
      setBusy(false);
      render();
    }
  }

  function setBusy(next: boolean, role?: string, label?: string): void {
    busy = next;
    if (role && label) {
      const btn = screen.querySelector<HTMLButtonElement>(
        `[data-role="${role}"]`
      );
      if (btn) {
        btn.setAttribute("aria-disabled", "true");
        btn.disabled = true;
        const sp = spinner();
        sp.classList.add("is-sm");
        btn.replaceChildren(sp, document.createTextNode(` ${label}`));
      }
    }
  }
}

// ---------- helpers (module-scoped, no external deps) ----------

// A "status" call returns ActionResult; an active schedule reports no
// failures, while the absence of one surfaces as a non-zero failure count.
function isActive(res: ActionResult): boolean {
  return res.failures === 0;
}

function svg(markup: string, className?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = className ? `icon ${className}` : "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = markup;
  return span;
}

function textNode(tag: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

function stateBlock(make: () => HTMLElement[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "state";
  el.append(...make());
  return el;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

// A scoped, accessible confirm dialog (the components barrel ships no
// modal). Premium fade/scale entrance; Esc and backdrop dismiss.
interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}

function openConfirm(opts: ConfirmOptions): void {
  const overlay = document.createElement("div");
  overlay.className = "sched-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const dialog = card({ className: "sched-dialog" });
  const h = document.createElement("h3");
  h.className = "card-title";
  h.textContent = opts.title;
  const p = document.createElement("p");
  p.className = "sched-status-sub";
  p.textContent = opts.body;

  const actions = document.createElement("div");
  actions.className = "sched-dialog-actions";

  const cancel = button({
    label: "Cancel",
    variant: "ghost",
    onClick: () => close(),
  });
  const confirm = button({
    label: opts.confirmLabel,
    variant: "danger",
    onClick: () => {
      close();
      opts.onConfirm();
    },
  });

  actions.append(cancel, confirm);
  dialog.append(h, p, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    overlay.classList.add("is-leaving");
    document.removeEventListener("keydown", onKey);
    window.setTimeout(() => overlay.remove(), 160);
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  requestAnimationFrame(() => confirm.focus());
}

// ---------- scoped styling injected once ----------

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.dataset.screen = "schedule";
  style.textContent = `
  .screen-schedule { max-width: 760px; }
  .screen-schedule .icon { display: inline-flex; }
  .screen-schedule .icon svg { width: 1em; height: 1em; }

  .sched-head-text h1 { margin: 0; }
  .sched-head-text p { margin-top: 6px; max-width: 60ch; }

  .sched-status-head {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }
  .sched-badge {
    flex: none;
    width: 46px;
    height: 46px;
    display: grid;
    place-items: center;
    border-radius: 14px;
    border: 1px solid var(--border);
  }
  .sched-badge svg { width: 24px; height: 24px; }
  .sched-badge.is-on {
    color: #fff;
    background: var(--accent-grad);
    border-color: transparent;
    box-shadow: 0 6px 18px rgba(124, 92, 255, 0.4);
  }
  .sched-badge.is-off {
    color: var(--text-dim);
    background: var(--surface-2);
  }
  .sched-status-main { flex: 1; min-width: 0; }
  .sched-status-sub { margin-top: 5px; line-height: 1.45; }
  .sched-status-head .chip { align-self: center; }
  .sched-status-actions {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: flex-end;
  }

  .segmented {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 4px;
    border-radius: var(--radius);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--border);
  }
  .segmented-opt {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-weight: 600;
    font-size: 14px;
    padding: 9px 12px;
    border-radius: 8px;
    cursor: pointer;
    transition: color var(--speed) var(--ease),
      background var(--speed) var(--ease),
      box-shadow var(--speed) var(--ease);
  }
  .segmented-opt:hover { color: var(--text); }
  .segmented-opt.is-active {
    color: var(--text);
    background: var(--surface-2);
    box-shadow: var(--shadow), inset 0 0 0 1px rgba(255, 255, 255, 0.05);
  }
  .sched-blurb {
    margin-top: 10px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .sched-cta {
    margin-top: 18px;
    display: flex;
    justify-content: flex-end;
  }
  .sched-cta .btn { min-width: 200px; }

  .sched-explain-head {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    margin-bottom: 14px;
  }
  .sched-explain-icon {
    flex: none;
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    border-radius: 13px;
    color: var(--accent-2);
    background: var(--accent-soft);
    border: 1px solid rgba(124, 92, 255, 0.3);
  }
  .sched-explain-icon svg { width: 22px; height: 22px; }
  .sched-sweeps {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px 18px;
  }
  .sched-sweeps li {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 13.5px;
    color: var(--text);
  }
  .sched-sweep-tick {
    flex: none;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    color: var(--ok);
    background: rgba(47, 208, 127, 0.14);
  }
  .sched-sweep-tick svg { width: 13px; height: 13px; }

  .sched-overlay {
    position: fixed;
    inset: 0;
    z-index: 1100;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(4, 5, 8, 0.55);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    animation: fade-up var(--speed) var(--ease) both;
  }
  .sched-overlay.is-leaving { animation: toast-out var(--speed) var(--ease) both; }
  .sched-dialog {
    width: min(420px, 100%);
    animation: dialog-in var(--speed-slow) var(--ease) both;
  }
  .sched-dialog .sched-status-sub { margin: 8px 0 0; }
  .sched-dialog-actions {
    margin-top: 20px;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  @keyframes dialog-in {
    from { opacity: 0; transform: translateY(10px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @media (max-width: 560px) {
    .sched-sweeps { grid-template-columns: 1fr; }
  }
  `;
  document.head.appendChild(style);
}
