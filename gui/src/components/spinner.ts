// Indeterminate loading spinner. Pure CSS rotation via the .spinner class in
// global.css; size is applied inline so call sites can scale it.

export interface SpinnerOptions {
  size?: number;
  className?: string;
}

export function spinner(opts: SpinnerOptions = {}): HTMLElement {
  const node = document.createElement("div");
  node.className = ["spinner", opts.className].filter(Boolean).join(" ");
  node.setAttribute("role", "status");
  node.setAttribute("aria-label", "Loading");
  const size = opts.size ?? 22;
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  return node;
}
