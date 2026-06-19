// Animated SVG progress ring — the hero gauge on the dashboard. Draws a track
// plus a gradient-stroked arc whose dash offset animates to the target
// percent. Center holds a caption (e.g. "62%" + a sublabel) that callers can
// update live via the handle.

const NS = "http://www.w3.org/2000/svg";

export interface ProgressRingOptions {
  size?: number;
  stroke?: number;
  label?: string;
  sublabel?: string;
  className?: string;
}

export interface ProgressRingHandle {
  element: HTMLElement;
  set(percent: number, label?: string, sublabel?: string): void;
}

let gradientSeq = 0;

export function progressRing(
  percent: number,
  opts: ProgressRingOptions = {}
): ProgressRingHandle {
  const size = opts.size ?? 200;
  const stroke = opts.stroke ?? 12;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const gradId = `ring-grad-${gradientSeq++}`;

  const root = document.createElement("div");
  root.className = ["ring", opts.className].filter(Boolean).join(" ");
  root.style.width = `${size}px`;
  root.style.height = `${size}px`;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.classList.add("ring-svg");

  const defs = document.createElementNS(NS, "defs");
  const grad = document.createElementNS(NS, "linearGradient");
  grad.setAttribute("id", gradId);
  grad.setAttribute("x1", "0%");
  grad.setAttribute("y1", "0%");
  grad.setAttribute("x2", "100%");
  grad.setAttribute("y2", "100%");
  const stop1 = document.createElementNS(NS, "stop");
  stop1.setAttribute("offset", "0%");
  stop1.setAttribute("stop-color", "var(--accent)");
  const stop2 = document.createElementNS(NS, "stop");
  stop2.setAttribute("offset", "100%");
  stop2.setAttribute("stop-color", "var(--accent-2)");
  grad.append(stop1, stop2);
  defs.appendChild(grad);

  const track = circle(size / 2, r, stroke);
  track.classList.add("ring-track");

  const arc = circle(size / 2, r, stroke);
  arc.classList.add("ring-arc");
  arc.setAttribute("stroke", `url(#${gradId})`);
  arc.setAttribute("stroke-linecap", "round");
  arc.setAttribute("stroke-dasharray", String(circumference));
  arc.setAttribute("stroke-dashoffset", String(circumference));
  // Start the sweep at 12 o'clock.
  arc.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);

  svg.append(defs, track, arc);

  const center = document.createElement("div");
  center.className = "ring-center";
  const labelEl = document.createElement("div");
  labelEl.className = "ring-label";
  const subEl = document.createElement("div");
  subEl.className = "ring-sublabel";
  center.append(labelEl, subEl);

  root.append(svg, center);

  const apply = (p: number, label?: string, sublabel?: string) => {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(p) ? p : 0));
    arc.setAttribute(
      "stroke-dashoffset",
      String(circumference * (1 - clamped / 100))
    );
    labelEl.textContent =
      label !== undefined ? label : opts.label ?? `${Math.round(clamped)}%`;
    const sub = sublabel !== undefined ? sublabel : opts.sublabel;
    subEl.textContent = sub ?? "";
    subEl.style.display = sub ? "" : "none";
    root.setAttribute("role", "progressbar");
    root.setAttribute("aria-valuenow", String(Math.round(clamped)));
  };

  // Animate from empty on first paint.
  requestAnimationFrame(() => apply(percent, opts.label, opts.sublabel));

  return {
    element: root,
    set: apply,
  };
}

function circle(c: number, r: number, stroke: number): SVGCircleElement {
  const el = document.createElementNS(NS, "circle");
  el.setAttribute("cx", String(c));
  el.setAttribute("cy", String(c));
  el.setAttribute("r", String(r));
  el.setAttribute("fill", "none");
  el.setAttribute("stroke-width", String(stroke));
  return el;
}
