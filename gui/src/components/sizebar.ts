// Thin horizontal proportion bar. Takes a 0..1 fraction and animates its fill
// width. Optional accent override for category-colored bars (e.g. personal).

import { el } from "./dom";

export interface SizeBarOptions {
  color?: string;
  className?: string;
}

export interface SizeBarHandle {
  element: HTMLElement;
  set(fraction: number): void;
}

export function sizeBar(
  fraction: number,
  opts: SizeBarOptions = {}
): SizeBarHandle {
  const fill = el("div", { class: "sizebar-fill" });
  if (opts.color) fill.style.background = opts.color;

  const root = el(
    "div",
    {
      class: ["sizebar", opts.className].filter(Boolean).join(" "),
      role: "progressbar",
      "aria-valuemin": "0",
      "aria-valuemax": "100",
    },
    fill
  );

  const apply = (f: number) => {
    const pct = Math.max(0, Math.min(1, Number.isFinite(f) ? f : 0)) * 100;
    fill.style.width = `${pct}%`;
    root.setAttribute("aria-valuenow", String(Math.round(pct)));
  };

  // Defer the first paint a frame so the width transition animates from 0.
  requestAnimationFrame(() => apply(fraction));

  return {
    element: root,
    set: apply,
  };
}
