// Inline SVG loader. Pulls the raw markup of every icon under assets/icons at
// build time (Vite glob, eager) so icon(name) is a synchronous lookup with no
// network/font dependency. The module-icons agent owns the .svg files; this
// stays decoupled by discovering whatever ships in that folder.

const FILES = import.meta.glob("../assets/icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const REGISTRY: Record<string, string> = {};
for (const [path, raw] of Object.entries(FILES)) {
  const name = path.split("/").pop()!.replace(/\.svg$/, "");
  REGISTRY[name] = raw;
}

export interface IconOptions {
  size?: number;
  className?: string;
  title?: string;
}

// Returns an <svg> element for the named icon, or a neutral placeholder square
// if the name is unknown so the layout never collapses.
export function icon(name: string, opts: IconOptions = {}): HTMLElement {
  const span = document.createElement("span");
  span.className = ["icon", opts.className].filter(Boolean).join(" ");
  span.setAttribute("aria-hidden", opts.title ? "false" : "true");
  if (opts.title) {
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", opts.title);
  }

  const size = opts.size ?? 18;
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.style.display = "inline-flex";

  span.innerHTML = REGISTRY[name] ?? FALLBACK;

  const svg = span.querySelector("svg");
  if (svg) {
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.style.display = "block";
  }
  return span;
}

const FALLBACK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';
