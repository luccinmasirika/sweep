// Glassy elevated container. Optional header (title + subtitle) and a body
// host that children are appended into. Styled by the .card classes in
// global.css.

import { el, type Child } from "./dom";

export interface CardOptions {
  title?: string;
  subtitle?: string;
  className?: string;
}

export function card(
  opts: CardOptions = {},
  children?: Child | Child[]
): HTMLElement {
  const root = el("div", {
    class: ["card", opts.className].filter(Boolean).join(" "),
  });

  if (opts.title || opts.subtitle) {
    root.appendChild(
      el("div", { class: "card-head" }, [
        opts.title && el("h3", { class: "card-title" }, opts.title),
        opts.subtitle && el("p", { class: "card-subtitle" }, opts.subtitle),
      ])
    );
  }

  const body = el("div", { class: "card-body" }, children);
  root.appendChild(body);
  return root;
}
