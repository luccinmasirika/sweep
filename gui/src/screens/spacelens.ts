// Space Lens. A radial / sunburst view of disk usage: explore(path) from the
// home folder, arcs sized by bytes, click an arc to drill into a directory, a
// breadcrumb to climb back up, and a trash action that runs clean([path]).
// This is the signature visual of the app — every interaction is animated and
// the data is always live from the sweep backend.

import { homeDir } from "@tauri-apps/api/path";
import type { Api } from "../api";
import type { ExploreChild, ExploreNode } from "../types";
import { button, card, formatBytes, icon, spinner, toast } from "../components";

const SVG_NS = "http://www.w3.org/2000/svg";

// Geometry of the dial. The hub holds the current folder summary; the ring
// holds one arc per child, sized by its share of the total bytes.
const SIZE = 460;
const CENTER = SIZE / 2;
const HUB_R = 96;
const RING_INNER = 112;
const RING_OUTER = 206;
const GAP_DEG = 0.9; // tiny breathing room between arcs

// Slices smaller than this fraction of the total are folded into a single
// "Other" wedge so the dial never collapses into unclickable hairlines.
const MIN_SLICE = 0.012;
const MAX_SLICES = 22;

interface Slice {
  child: ExploreChild | null; // null => the synthetic "Other" bucket
  label: string;
  bytes: number;
  fraction: number;
  hue: number;
  start: number; // degrees
  end: number; // degrees
}

export function renderSpacelens(root: HTMLElement, api: Api): void {
  injectStyles();

  const screen = document.createElement("div");
  screen.className = "screen screen-spacelens";

  // Navigation stack of explored nodes; the last entry is what's on screen.
  const stack: ExploreNode[] = [];
  let busy = false;

  const head = card({ className: "lens-head" });
  head.appendChild(
    elFromHTML(`
      <div class="spread">
        <div>
          <div class="section-title">Space Lens</div>
          <h2 class="lens-title">Where your storage lives</h2>
        </div>
      </div>`)
  );
  const crumbs = document.createElement("nav");
  crumbs.className = "lens-crumbs";
  crumbs.setAttribute("aria-label", "Folder path");
  head.appendChild(crumbs);

  const stage = card({ className: "lens-stage" });
  const body = document.createElement("div");
  body.className = "lens-body";
  stage.appendChild(body);

  screen.append(head, stage);
  root.appendChild(screen);

  // ---- navigation -------------------------------------------------------

  async function explore(path: string, push: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    showLoading(path);
    try {
      const node = await api.explore(path);
      if (push) stack.push(node);
      else stack[stack.length - 1] = node;
      renderNode();
    } catch (err) {
      showError(path, String(err));
    } finally {
      busy = false;
    }
  }

  function drillInto(child: ExploreChild): void {
    if (!child.is_dir || busy) return;
    void explore(child.path, true);
  }

  function goUp(toDepth: number): void {
    if (busy || toDepth >= stack.length - 1) return;
    stack.length = toDepth + 1;
    renderNode();
  }

  async function trash(child: ExploreChild): Promise<void> {
    if (busy) return;
    const ok = window.confirm(
      `Move to Trash?\n\n${child.path}\n\nThis frees ${formatBytes(
        child.size
      )}. The item goes to the Trash and is recoverable until you empty it.`
    );
    if (!ok) return;

    busy = true;
    const current = stack[stack.length - 1];
    showLoading(current.path);
    try {
      const result = await api.clean([child.path]);
      if (result.failures > 0 && result.trashed === 0 && result.freed === 0) {
        toast("Nothing was removed — the item may be protected");
      } else {
        toast(`Trashed ${formatBytes(result.freed)} from ${baseName(child.path)}`);
      }
    } catch (err) {
      toast("Couldn't move the item to Trash");
      console.error(err);
    } finally {
      busy = false;
      // Re-read the current folder so the dial reflects what's left.
      await explore(current.path, false);
    }
  }

  // ---- rendering --------------------------------------------------------

  function renderNode(): void {
    renderCrumbs();
    const node = stack[stack.length - 1];
    body.replaceChildren();

    if (!node.children || node.children.length === 0) {
      body.appendChild(emptyState(node));
      return;
    }

    const slices = buildSlices(node);

    const layout = document.createElement("div");
    layout.className = "lens-layout";

    const dial = buildDial(node, slices);
    const legend = buildLegend(node, slices);

    layout.append(dial.root, legend);
    body.appendChild(layout);

    // Wire cross-highlighting between the legend rows and their arcs.
    dial.attachLegend(legend);
  }

  function renderCrumbs(): void {
    crumbs.replaceChildren();
    stack.forEach((node, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "lens-crumb-sep";
        sep.appendChild(icon("chevron", { size: 14 }));
        crumbs.appendChild(sep);
      }
      const isLast = i === stack.length - 1;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lens-crumb" + (isLast ? " is-current" : "");
      btn.textContent = i === 0 ? "Home" : baseName(node.path);
      btn.title = node.path;
      if (!isLast) btn.addEventListener("click", () => goUp(i));
      else btn.setAttribute("aria-current", "page");
      crumbs.appendChild(btn);
    });
  }

  // Build the SVG sunburst. Returns the root node plus a hook to bind legend
  // rows so hovering either side lights up the matching arc.
  function buildDial(node: ExploreNode, slices: Slice[]) {
    const wrap = document.createElement("div");
    wrap.className = "lens-dial";

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute("class", "lens-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      `${baseName(node.path)} — ${formatBytes(node.size)} across ${
        node.children.length
      } items`
    );

    // Soft track behind the ring so partial dials still read as a circle.
    svg.appendChild(
      annulusArc(0, 360, RING_INNER, RING_OUTER, { class: "lens-track" })
    );

    const tip = document.createElement("div");
    tip.className = "lens-tip";

    const arcByKey = new Map<string, SVGPathElement>();

    slices.forEach((slice) => {
      const path = annulusArc(slice.start, slice.end, RING_INNER, RING_OUTER, {
        class: "lens-arc",
      });
      path.style.fill = `hsl(${slice.hue} 78% 62%)`;
      path.style.setProperty("--arc-delay", `${Math.random() * 90}ms`);

      const key = sliceKey(slice);
      arcByKey.set(key, path);

      const interactive = !!slice.child;
      if (interactive) {
        path.classList.add("is-interactive");
        path.setAttribute("tabindex", "0");
        path.setAttribute("role", "button");
        const dir = slice.child!.is_dir;
        path.setAttribute(
          "aria-label",
          `${slice.label}, ${formatBytes(slice.bytes)}${
            dir ? ", open folder" : ""
          }`
        );
      }

      const enter = () => focusSlice(key, slice);
      const leave = () => blurSlice();
      path.addEventListener("mouseenter", enter);
      path.addEventListener("mousemove", (e) => moveTip(e));
      path.addEventListener("mouseleave", leave);
      path.addEventListener("focus", enter);
      path.addEventListener("blur", leave);

      if (slice.child && slice.child.is_dir) {
        path.addEventListener("click", () => drillInto(slice.child!));
        path.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            drillInto(slice.child!);
          }
        });
      }

      svg.appendChild(path);
    });

    // Hub: the current folder's total, doubling as an "up" affordance.
    const hub = document.createElementNS(SVG_NS, "g");
    hub.setAttribute("class", "lens-hub");
    const hubCircle = document.createElementNS(SVG_NS, "circle");
    hubCircle.setAttribute("cx", String(CENTER));
    hubCircle.setAttribute("cy", String(CENTER));
    hubCircle.setAttribute("r", String(HUB_R));
    hubCircle.setAttribute("class", "lens-hub-bg");
    hub.appendChild(hubCircle);

    if (stack.length > 1) {
      hub.classList.add("is-up");
      hub.setAttribute("role", "button");
      hub.setAttribute("tabindex", "0");
      hub.setAttribute("aria-label", "Go up one folder");
      const up = () => goUp(stack.length - 2);
      hub.addEventListener("click", up);
      hub.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          up();
        }
      });
    }
    svg.appendChild(hub);

    const center = document.createElement("div");
    center.className = "lens-center";
    center.innerHTML = `
      <div class="lens-center-size">${escapeHTML(formatBytes(node.size))}</div>
      <div class="lens-center-name" title="${escapeHTML(node.path)}">${escapeHTML(
      baseName(node.path)
    )}</div>
      ${
        stack.length > 1
          ? `<div class="lens-center-up">Click center to go up</div>`
          : `<div class="lens-center-up text-faint">${node.children.length} items</div>`
      }`;

    wrap.append(svg, center, tip);

    function focusSlice(key: string, slice: Slice): void {
      for (const [k, p] of arcByKey) {
        p.classList.toggle("is-dim", k !== key);
        p.classList.toggle("is-active", k === key);
      }
      tip.classList.add("is-on");
      const action = slice.child
        ? slice.child.is_dir
          ? "Click to open"
          : "File"
        : "Smaller items";
      tip.innerHTML = `
        <div class="lens-tip-name">${escapeHTML(slice.label)}</div>
        <div class="lens-tip-size">${escapeHTML(formatBytes(slice.bytes))} · ${(
        slice.fraction * 100
      ).toFixed(slice.fraction < 0.1 ? 1 : 0)}%</div>
        <div class="lens-tip-hint text-faint">${action}</div>`;
      legendHighlight?.(key);
    }
    function blurSlice(): void {
      for (const p of arcByKey.values()) {
        p.classList.remove("is-dim", "is-active");
      }
      tip.classList.remove("is-on");
      legendHighlight?.(null);
    }
    function moveTip(e: MouseEvent): void {
      const rect = wrap.getBoundingClientRect();
      tip.style.left = `${e.clientX - rect.left}px`;
      tip.style.top = `${e.clientY - rect.top}px`;
    }

    let legendHighlight: ((key: string | null) => void) | null = null;

    return {
      root: wrap,
      attachLegend(legend: HTMLElement) {
        const rows = Array.from(
          legend.querySelectorAll<HTMLElement>(".lens-row")
        );
        legendHighlight = (key) => {
          rows.forEach((r) =>
            r.classList.toggle("is-active", !!key && r.dataset.key === key)
          );
        };
        rows.forEach((row) => {
          const key = row.dataset.key!;
          const slice = slices.find((s) => sliceKey(s) === key);
          if (!slice) return;
          row.addEventListener("mouseenter", () => focusSlice(key, slice));
          row.addEventListener("mouseleave", () => blurSlice());
        });
      },
    };
  }

  function buildLegend(node: ExploreNode, slices: Slice[]): HTMLElement {
    const legend = document.createElement("div");
    legend.className = "lens-legend";

    const head = document.createElement("div");
    head.className = "lens-legend-head spread";
    head.innerHTML = `<span class="section-title">Breakdown</span><span class="lens-legend-total">${escapeHTML(
      formatBytes(node.size)
    )}</span>`;
    legend.appendChild(head);

    const rows = document.createElement("div");
    rows.className = "lens-rows";
    legend.appendChild(rows);

    slices.forEach((slice) => {
      const row = document.createElement("div");
      row.className = "lens-row";
      row.dataset.key = sliceKey(slice);

      const swatch = `<span class="lens-swatch" style="background:hsl(${slice.hue} 78% 62%)"></span>`;
      const isDir = slice.child?.is_dir;
      const name = escapeHTML(slice.label);

      row.innerHTML = `
        <button type="button" class="lens-row-main"${
          slice.child && isDir ? "" : " disabled"
        } title="${escapeHTML(slice.child ? slice.child.path : slice.label)}">
          ${swatch}
          <span class="lens-row-name">${
            isDir ? `<span class="lens-row-icon"></span>` : ""
          }${name}</span>
          <span class="lens-row-size">${escapeHTML(formatBytes(slice.bytes))}</span>
        </button>`;

      const bar = document.createElement("div");
      bar.className = "lens-row-bar";
      const fill = document.createElement("div");
      fill.className = "lens-row-bar-fill";
      fill.style.width = `${Math.max(2, slice.fraction * 100)}%`;
      fill.style.background = `hsl(${slice.hue} 78% 62%)`;
      bar.appendChild(fill);
      row.appendChild(bar);

      const main = row.querySelector(".lens-row-main") as HTMLButtonElement;
      if (isDir) {
        const ico = row.querySelector(".lens-row-icon");
        if (ico) ico.appendChild(icon("folder", { size: 14 }));
        main.addEventListener("click", () => drillInto(slice.child!));
      }

      if (slice.child) {
        const trashBtn = document.createElement("button");
        trashBtn.type = "button";
        trashBtn.className = "lens-row-trash";
        trashBtn.title = `Move ${baseName(slice.child.path)} to Trash`;
        trashBtn.setAttribute("aria-label", `Move ${slice.label} to Trash`);
        trashBtn.appendChild(icon("trash", { size: 15 }));
        trashBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          void trash(slice.child!);
        });
        row.appendChild(trashBtn);
      }

      rows.appendChild(row);
    });

    return legend;
  }

  // ---- transient states -------------------------------------------------

  function showLoading(path: string): void {
    renderCrumbs();
    body.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "state lens-state";
    wrap.appendChild(spinner());
    const p = document.createElement("p");
    p.className = "text-dim";
    p.textContent = `Measuring ${baseName(path)}…`;
    wrap.appendChild(p);
    body.appendChild(wrap);
  }

  function emptyState(node: ExploreNode): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "state lens-state";
    wrap.appendChild(icon("folder", { size: 44, className: "state-icon" }));
    const h = document.createElement("h3");
    h.textContent = "Nothing to see here";
    const p = document.createElement("p");
    p.textContent =
      node.size > 0
        ? "This folder's contents can't be measured."
        : "This folder is empty.";
    wrap.append(h, p);
    if (stack.length > 1) {
      wrap.appendChild(
        button({ label: "Go up", variant: "ghost", onClick: () => goUp(stack.length - 2) })
      );
    }
    return wrap;
  }

  function showError(path: string, detail: string): void {
    renderCrumbs();
    body.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "state lens-state";
    wrap.appendChild(icon("spacelens", { size: 44, className: "state-icon" }));
    const h = document.createElement("h3");
    h.textContent = "Couldn't read that folder";
    const p = document.createElement("p");
    p.className = "text-dim";
    p.textContent = baseName(path) || path;
    wrap.append(h, p);
    wrap.appendChild(
      button({
        label: "Retry",
        variant: "ghost",
        onClick: () => {
          const back = stack.length ? false : true;
          void explore(path, back);
        },
      })
    );
    if (stack.length > 1) {
      wrap.appendChild(
        button({
          label: "Go up",
          onClick: () => goUp(stack.length - 2),
        })
      );
    }
    console.error("explore failed", path, detail);
  }

  // ---- boot -------------------------------------------------------------

  showLoading("Home");
  resolveHome()
    .then((home) => explore(home, true))
    .catch(() => showError("Home", "home directory not found"));
}

// ---- slice math ---------------------------------------------------------

function buildSlices(node: ExploreNode): Slice[] {
  const total =
    node.children.reduce((s, c) => s + Math.max(0, c.size), 0) || 1;

  const sorted = [...node.children]
    .filter((c) => c.size > 0)
    .sort((a, b) => b.size - a.size);

  const kept: ExploreChild[] = [];
  let otherBytes = 0;
  for (const child of sorted) {
    const frac = child.size / total;
    if (kept.length < MAX_SLICES && frac >= MIN_SLICE) kept.push(child);
    else otherBytes += child.size;
  }
  // Folders with only tiny children still deserve at least one real slice.
  if (kept.length === 0 && sorted.length) kept.push(sorted[0]);

  const entries: { child: ExploreChild | null; label: string; bytes: number }[] =
    kept.map((c) => ({ child: c, label: baseName(c.path), bytes: c.size }));
  if (otherBytes > 0) {
    entries.push({ child: null, label: "Other", bytes: otherBytes });
  }

  const drawnTotal = entries.reduce((s, e) => s + e.bytes, 0) || 1;
  const gaps = entries.length > 1 ? entries.length * GAP_DEG : 0;
  const usable = 360 - gaps;

  let cursor = -90; // start at 12 o'clock
  return entries.map((e, i) => {
    const fraction = e.bytes / drawnTotal;
    const span = fraction * usable;
    const start = cursor;
    const end = cursor + span;
    cursor = end + GAP_DEG;
    const hue = e.child ? hueFor(e.label, i) : 222;
    return { ...e, fraction, hue, start, end };
  });
}

function hueFor(name: string, index: number): number {
  // Stable, well-spaced hues seeded by name so colors stay put across re-reads.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (h % 320) + ((index * 7) % 40);
}

function sliceKey(s: Slice): string {
  return s.child ? s.child.path : "__other__";
}

// ---- svg helpers ---------------------------------------------------------

function annulusArc(
  startDeg: number,
  endDeg: number,
  rInner: number,
  rOuter: number,
  attrs: Record<string, string>
): SVGPathElement {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", annulusPath(startDeg, endDeg, rInner, rOuter));
  for (const [k, v] of Object.entries(attrs)) path.setAttribute(k, v);
  return path;
}

function annulusPath(
  startDeg: number,
  endDeg: number,
  rInner: number,
  rOuter: number
): string {
  // Full-circle tracks can't be drawn with a single arc; split into two halves.
  if (endDeg - startDeg >= 359.999) {
    return (
      annulusPath(startDeg, startDeg + 180, rInner, rOuter) +
      annulusPath(startDeg + 180, startDeg + 360, rInner, rOuter)
    );
  }
  const so = polar(CENTER, CENTER, rOuter, startDeg);
  const eo = polar(CENTER, CENTER, rOuter, endDeg);
  const si = polar(CENTER, CENTER, rInner, startDeg);
  const ei = polar(CENTER, CENTER, rInner, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${so.x} ${so.y}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${eo.x} ${eo.y}`,
    `L ${ei.x} ${ei.y}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${si.x} ${si.y}`,
    "Z",
  ].join(" ");
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// ---- misc helpers --------------------------------------------------------

async function resolveHome(): Promise<string> {
  const home = await homeDir();
  return home.replace(/\/+$/, "");
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || "/" : trimmed;
}

function escapeHTML(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ] as string)
  );
}

function elFromHTML(html: string): HTMLElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild as HTMLElement;
}

// Screen-scoped styling. Lives here (not global.css) because this file owns the
// signature visual end-to-end; everything references the shared design tokens.
const STYLE_ID = "lens-styles";
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.screen-spacelens .lens-head { display: flex; flex-direction: column; gap: 14px; }
.screen-spacelens .lens-title { margin: 2px 0 0; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }

.lens-crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
.lens-crumb {
  font: inherit; font-size: 13px; font-weight: 550; color: var(--text-dim);
  background: transparent; border: 0; padding: 4px 9px; border-radius: 8px;
  cursor: pointer; transition: background var(--speed) var(--ease), color var(--speed) var(--ease);
}
.lens-crumb:hover { color: var(--text); background: var(--surface-2); }
.lens-crumb.is-current { color: var(--text); cursor: default; }
.lens-crumb.is-current:hover { background: transparent; }
.lens-crumb:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: 1px; }
.lens-crumb-sep { display: inline-flex; color: var(--text-faint); opacity: 0.7; }
.lens-crumb-sep svg { stroke: currentColor; }

.lens-stage { min-height: 540px; padding: 22px; }
.lens-body { min-height: 500px; display: flex; }
.lens-state { flex: 1; }

.lens-layout {
  flex: 1; display: grid; grid-template-columns: ${SIZE}px minmax(280px, 1fr);
  gap: 28px; align-items: center;
}
@media (max-width: 980px) {
  .lens-layout { grid-template-columns: 1fr; justify-items: center; }
}

.lens-dial { position: relative; width: ${SIZE}px; height: ${SIZE}px; }
.lens-svg { width: 100%; height: 100%; overflow: visible; }
.lens-track { fill: rgba(255,255,255,0.035); }

.lens-arc {
  stroke: var(--bg-elev); stroke-width: 1.5; stroke-linejoin: round;
  transform-origin: ${CENTER}px ${CENTER}px;
  transition: opacity var(--speed) var(--ease), filter var(--speed) var(--ease),
    transform var(--speed) var(--ease);
  animation: lens-arc-in 420ms var(--ease) both; animation-delay: var(--arc-delay, 0ms);
}
@keyframes lens-arc-in { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
.lens-arc.is-interactive { cursor: pointer; }
.lens-arc.is-dim { opacity: 0.32; }
.lens-arc.is-active { filter: brightness(1.12) saturate(1.1); transform: scale(1.035); }
.lens-arc:focus { outline: none; }
.lens-arc:focus-visible { stroke: var(--text); stroke-width: 2.5; }

.lens-hub-bg {
  fill: var(--bg-elev); stroke: var(--border); stroke-width: 1;
  transition: fill var(--speed) var(--ease), stroke var(--speed) var(--ease);
}
.lens-hub.is-up { cursor: pointer; }
.lens-hub.is-up:hover .lens-hub-bg { fill: var(--surface-2); stroke: var(--accent-ring); }
.lens-hub.is-up:focus-visible .lens-hub-bg { stroke: var(--accent); stroke-width: 2; }

.lens-center {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: ${HUB_R * 1.7}px; text-align: center; pointer-events: none;
  display: flex; flex-direction: column; gap: 3px; align-items: center;
}
.lens-center-size {
  font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.05;
  background: var(--accent-grad); -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
.lens-center-name {
  font-size: 13px; font-weight: 600; color: var(--text);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lens-center-up { font-size: 11px; color: var(--text-dim); }

.lens-tip {
  position: absolute; pointer-events: none; z-index: 5;
  transform: translate(14px, -50%); padding: 9px 12px; min-width: 130px;
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-lg); opacity: 0; transition: opacity var(--speed) var(--ease);
}
.lens-tip.is-on { opacity: 1; }
.lens-tip-name { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 2px;
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lens-tip-size { font-size: 12px; color: var(--text-dim); }
.lens-tip-hint { font-size: 11px; margin-top: 3px; }

.lens-legend { width: 100%; align-self: stretch; display: flex; flex-direction: column; gap: 10px; padding-top: 4px; }
.lens-legend-head { align-items: baseline; }
.lens-legend-total { font-size: 13px; font-weight: 650; color: var(--text); }
.lens-rows { display: flex; flex-direction: column; gap: 2px; max-height: 460px; overflow-y: auto; padding-right: 4px; }
.lens-rows::-webkit-scrollbar { width: 8px; }
.lens-rows::-webkit-scrollbar-thumb { background: var(--surface-2); border-radius: 8px; }

.lens-row {
  position: relative; border-radius: var(--radius); padding: 7px 8px 9px;
  transition: background var(--speed) var(--ease);
}
.lens-row:hover, .lens-row.is-active { background: var(--surface); }
.lens-row-main {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
  width: 100%; background: transparent; border: 0; padding: 0; font: inherit; color: var(--text);
  text-align: left; cursor: pointer;
}
.lens-row-main[disabled] { cursor: default; }
.lens-row-main:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: 3px; border-radius: 6px; }
.lens-swatch { width: 11px; height: 11px; border-radius: 3px; flex: none; box-shadow: 0 0 0 1px rgba(0,0,0,0.25) inset; }
.lens-row-name {
  display: inline-flex; align-items: center; gap: 7px; min-width: 0;
  font-size: 13.5px; font-weight: 550; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lens-row-icon { display: inline-flex; color: var(--text-dim); flex: none; }
.lens-row-icon svg { stroke: currentColor; }
.lens-row-size { font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--text-dim); white-space: nowrap; }
.lens-row-bar { margin: 7px 0 0; height: 3px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.lens-row-bar-fill { height: 100%; border-radius: 3px; transition: width var(--speed-slow) var(--ease); }

.lens-row-trash {
  position: absolute; top: 6px; right: 6px; width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 0; border-radius: 8px; color: var(--text-faint);
  cursor: pointer; opacity: 0; transform: scale(0.9);
  transition: opacity var(--speed) var(--ease), background var(--speed) var(--ease),
    color var(--speed) var(--ease), transform var(--speed) var(--ease);
}
.lens-row:hover .lens-row-trash, .lens-row:focus-within .lens-row-trash { opacity: 1; transform: scale(1); }
.lens-row-trash:hover { background: rgba(255, 93, 108, 0.16); color: var(--danger); }
.lens-row-trash:focus-visible { outline: 2px solid var(--danger); outline-offset: 1px; opacity: 1; }
.lens-row-trash svg { stroke: currentColor; }
`;
  document.head.appendChild(style);
}
