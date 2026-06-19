// Buttons. button() is the general variant-driven factory; primaryButton() is
// the prominent gradient call-to-action used once per screen. Both support an
// optional leading icon and a busy state that swaps in a spinner.

import { el } from "./dom";
import { icon } from "./icon";
import { spinner } from "./spinner";

export type ButtonVariant = "primary" | "ghost" | "danger" | "subtle";

export interface ButtonOptions {
  label: string;
  variant?: ButtonVariant;
  icon?: string;
  disabled?: boolean;
  busy?: boolean;
  onClick?: (ev: MouseEvent) => void;
  className?: string;
}

export function button(opts: ButtonOptions): HTMLButtonElement {
  const node = el("button", {
    type: "button",
    class: ["btn", `btn-${opts.variant ?? "ghost"}`, opts.className]
      .filter(Boolean)
      .join(" "),
    disabled: opts.disabled || opts.busy || false,
  }) as HTMLButtonElement;

  render(node, opts);

  if (opts.onClick) {
    node.addEventListener("click", (ev) => opts.onClick!(ev as MouseEvent));
  }

  // Lightweight imperative handle for screens that toggle state after wiring.
  (node as ButtonHandle).setBusy = (busy: boolean) => {
    opts.busy = busy;
    node.disabled = busy || !!opts.disabled;
    render(node, opts);
  };
  (node as ButtonHandle).setDisabled = (disabled: boolean) => {
    opts.disabled = disabled;
    node.disabled = disabled || !!opts.busy;
    render(node, opts);
  };
  (node as ButtonHandle).setLabel = (label: string) => {
    opts.label = label;
    render(node, opts);
  };

  return node;
}

export function primaryButton(
  opts: Omit<ButtonOptions, "variant">
): HTMLButtonElement {
  return button({ ...opts, variant: "primary" });
}

export interface ButtonHandle extends HTMLButtonElement {
  setBusy(busy: boolean): void;
  setDisabled(disabled: boolean): void;
  setLabel(label: string): void;
}

function render(node: HTMLButtonElement, opts: ButtonOptions): void {
  node.replaceChildren();
  if (opts.busy) {
    const s = spinner({ size: 16 });
    s.classList.add("btn-spinner");
    node.appendChild(s);
  } else if (opts.icon) {
    node.appendChild(icon(opts.icon, { size: 16, className: "btn-icon" }));
  }
  node.appendChild(el("span", { class: "btn-label" }, opts.label));
}
