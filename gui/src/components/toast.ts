// Transient notifications. A single bottom-centered host stacks toasts and
// auto-dismisses them. The host and animation styles are self-injected once so
// the component works regardless of which screen calls it first; visual tokens
// still come from the design system via CSS custom properties.

import { el } from "./dom";
import { icon } from "./icon";

export type ToastKind = "info" | "success" | "warn" | "error";

export interface ToastOptions {
  kind?: ToastKind;
  duration?: number;
}

const ICONS: Record<ToastKind, string> = {
  info: "info",
  success: "check",
  warn: "alert",
  error: "alert",
};

export function toast(message: string, opts: ToastOptions = {}): void {
  ensureStyles();
  const host = ensureHost();

  const kind = opts.kind ?? "info";
  const node = el("div", { class: `toast toast-${kind}`, role: "status" }, [
    icon(ICONS[kind], { size: 16, className: "toast-icon" }),
    el("span", { class: "toast-msg" }, message),
  ]);

  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("is-in"));

  const dismiss = () => {
    node.classList.remove("is-in");
    node.addEventListener("transitionend", () => node.remove(), { once: true });
    // Safety net if the transition never fires.
    setTimeout(() => node.remove(), 400);
  };

  node.addEventListener("click", dismiss);
  setTimeout(dismiss, opts.duration ?? 3200);
}

function ensureHost(): HTMLElement {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = el("div", { id: "toast-host", "aria-live": "polite" });
    document.body.appendChild(host);
  }
  return host;
}

function ensureStyles(): void {
  if (document.getElementById("toast-styles")) return;
  const style = document.createElement("style");
  style.id = "toast-styles";
  style.textContent = `
    #toast-host {
      position: fixed;
      left: 50%;
      bottom: 28px;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      z-index: 9999;
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: 420px;
      padding: 11px 16px;
      border-radius: var(--radius, 10px);
      background: var(--surface-2, #1e222b);
      color: var(--text, #f3f5f8);
      border: 1px solid var(--border, #2a2f3a);
      box-shadow: var(--shadow-lg, 0 18px 48px rgba(0,0,0,.55));
      font-size: 13.5px;
      font-weight: 500;
      cursor: pointer;
      opacity: 0;
      transform: translateY(12px) scale(.98);
      transition: opacity 200ms ease, transform 200ms ease;
    }
    .toast.is-in { opacity: 1; transform: translateY(0) scale(1); }
    .toast-icon { flex: none; }
    .toast-success .toast-icon { color: var(--ok, #34d399); }
    .toast-warn .toast-icon { color: var(--warn, #fbbf24); }
    .toast-error .toast-icon { color: var(--danger, #f87171); }
    .toast-info .toast-icon { color: var(--accent-2, #00d4ff); }
  `;
  document.head.appendChild(style);
}
