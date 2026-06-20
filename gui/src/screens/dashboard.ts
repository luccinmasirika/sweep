// Smart Care dashboard — the Violet hero world. Idle shows the glossy disc hero
// over a big animated scan ring and a circular "Smart Scan" CTA. After scan it
// cross-fades to the reclaimable total and a grid of glass result cards per
// category, with a circular "Clean safely" CTA running smartClean(false).

import type { Api } from "../api";
import type { Report } from "../types";
import { formatBytes, icon, toast } from "../components";
import heroRaw from "../assets/illustrations/dashboard.svg?raw";

// Reuse the last scan across navigations so returning to the dashboard is
// instant; "Rescan" forces a fresh walk.
let cachedSummary: ScanSummary | null = null;

const TARGET_ICON: Record<string, string> = {
  "system-caches": "cleanup",
  "app-caches": "cleanup",
  "dev-tools": "applications",
  xcode: "applications",
  projects: "files",
  "large-items": "files",
  privacy: "privacy",
  leftovers: "applications",
  logs: "maintenance",
  trash: "trash",
};

function iconFor(target: string): string {
  return TARGET_ICON[target] ?? "broom";
}

// The route a tile's "Review" jumps to so the user can act on that category.
const TARGET_ROUTE: Record<string, string> = {
  "system-caches": "cleanup",
  "app-caches": "cleanup",
  projects: "cleanup",
  logs: "maintenance",
  "dev-tools": "applications",
  xcode: "applications",
  leftovers: "applications",
  "large-items": "files",
  trash: "cleanup",
  privacy: "privacy",
};

function routeFor(target: string): string {
  return TARGET_ROUTE[target] ?? "cleanup";
}

const TARGET_LABEL: Record<string, string> = {
  "system-caches": "System Caches",
  "app-caches": "App Caches",
  "dev-tools": "Developer Tools",
  xcode: "Xcode",
  projects: "Project Junk",
  "large-items": "Large Items",
  logs: "Logs",
  trash: "Trash",
  privacy: "Privacy",
  leftovers: "Leftovers",
};

function labelFor(target: string): string {
  if (TARGET_LABEL[target]) return TARGET_LABEL[target];
  return target
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type Phase = "idle" | "scanning" | "scanned" | "cleaning" | "cleaned" | "error";

interface Category {
  target: string;
  bytes: number;
  count: number;
}

interface ScanSummary {
  total: number;
  categories: Category[];
}

const RING_R = 116;
const RING_C = 2 * Math.PI * RING_R;

function summarize(reports: Report[]): ScanSummary {
  const categories: Category[] = [];
  let total = 0;
  for (const report of reports) {
    let bytes = 0;
    for (const f of report.findings) bytes += f.size;
    if (bytes <= 0 && report.findings.length === 0) continue;
    total += bytes;
    categories.push({ target: report.target, bytes, count: report.findings.length });
  }
  categories.sort((a, b) => b.bytes - a.bytes);
  return { total, categories };
}

export function renderDashboard(root: HTMLElement, api: Api): void {
  injectStyles();

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let phase: Phase = "idle";
  let summary: ScanSummary = { total: 0, categories: [] };
  // Cancels any in-flight ring count-up animation between renders/clicks.
  let stopAnim: (() => void) | null = null;

  const el = document.createElement("div");
  el.className = "screen screen-dash";
  el.innerHTML = layoutMarkup();
  root.appendChild(el);

  // --- references ------------------------------------------------------------
  const heroPane = el.querySelector<HTMLElement>(".dash-hero-pane")!;
  const resultsPane = el.querySelector<HTMLElement>(".dash-results-pane")!;

  const eyebrowEl = el.querySelector<HTMLElement>(".eyebrow")!;
  const titleEl = el.querySelector<HTMLElement>(".dash-title")!;
  const subEl = el.querySelector<HTMLElement>(".dash-sub")!;
  const hintEl = el.querySelector<HTMLElement>(".dash-hint")!;

  const artEl = el.querySelector<HTMLElement>(".hero-art")!;
  const ringScene = el.querySelector<HTMLElement>(".dash-ring")!;
  const ringProgress = el.querySelector<SVGCircleElement>(".dash-ring-progress")!;
  const amountEl = el.querySelector<HTMLElement>(".dash-amount")!;
  const unitEl = el.querySelector<HTMLElement>(".dash-unit")!;
  const readoutLabel = el.querySelector<HTMLElement>(".dash-readout-label")!;

  const ctaEl = el.querySelector<HTMLButtonElement>(".dash-cta")!;

  const resultsTitle = el.querySelector<HTMLElement>(".dash-results-title")!;
  const resultsSub = el.querySelector<HTMLElement>(".dash-results-sub")!;
  const gridEl = el.querySelector<HTMLElement>(".dash-grid")!;
  const cleanCta = el.querySelector<HTMLButtonElement>(".dash-clean-cta")!;
  const rescanBtn = el.querySelector<HTMLButtonElement>(".dash-rescan")!;

  ringProgress.style.strokeDasharray = `${RING_C}`;

  // --- ring + readout --------------------------------------------------------
  function setRing(p: number): void {
    const clamped = Math.max(0, Math.min(1, p));
    ringProgress.style.strokeDashoffset = `${RING_C * (1 - clamped)}`;
  }

  function setBig(bytes: number): void {
    const [value, unit] = splitBytes(bytes);
    amountEl.textContent = value;
    unitEl.textContent = unit;
  }

  function currentBig(): number {
    const v = parseFloat(amountEl.textContent || "0");
    const u = unitEl.textContent || "B";
    return rejoinBytes(v, u);
  }

  // Smoothly animate the ring fill and the headline byte counter in lockstep.
  function animateTo(targetBytes: number, durationMs: number): Promise<void> {
    if (stopAnim) stopAnim();
    if (reduceMotion) {
      setBig(targetBytes);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const from = currentBig();
      let raf = 0;
      let cancelled = false;
      const tick = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - start) / durationMs);
        const bytes = from + (targetBytes - from) * easeOutCubic(t);
        setBig(bytes);
        if (t >= 1) {
          stopAnim = null;
          resolve();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      stopAnim = () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        stopAnim = null;
        resolve();
      };
      raf = requestAnimationFrame(tick);
    });
  }

  // --- state switch ----------------------------------------------------------
  function showHero(): void {
    resultsPane.hidden = true;
    heroPane.hidden = false;
    heroPane.classList.remove("is-leaving");
  }

  function showResults(): void {
    heroPane.hidden = true;
    resultsPane.hidden = false;
    resultsPane.classList.remove("is-in");
    requestAnimationFrame(() => resultsPane.classList.add("is-in"));
  }

  // --- result grid -----------------------------------------------------------
  function renderGrid(): void {
    gridEl.replaceChildren();
    summary.categories.forEach((cat, idx) => {
      const pct = summary.total > 0 ? (cat.bytes / summary.total) * 100 : 0;
      const tile = document.createElement("article");
      tile.className = "glass-card result-tile";
      tile.style.setProperty("--stagger", `${idx * 40}ms`);
      tile.innerHTML = `
        <div class="tile-head">
          <span class="tile-chip" aria-hidden="true"></span>
          <div class="tile-meta">
            <span class="tile-label"></span>
            <span class="tile-count"></span>
          </div>
        </div>
        <div class="tile-size tnum"></div>
        <div class="sizebar"><div class="sizebar-fill"></div></div>
        <div class="tile-foot">
          <button type="button" class="btn btn-ghost btn-sm tile-review">Review</button>
        </div>`;
      tile.querySelector(".tile-chip")!.appendChild(icon(iconFor(cat.target), { size: 18 }));
      tile.querySelector(".tile-label")!.textContent = labelFor(cat.target);
      tile.querySelector(".tile-count")!.textContent =
        `${cat.count} ${cat.count === 1 ? "item" : "items"}`;
      tile.querySelector(".tile-size")!.textContent = formatBytes(cat.bytes);
      const fill = tile.querySelector<HTMLElement>(".sizebar-fill")!;
      requestAnimationFrame(() => {
        fill.style.width = `${Math.max(4, pct)}%`;
      });
      const review = tile.querySelector<HTMLButtonElement>(".tile-review")!;
      review.addEventListener("click", () => {
        location.hash = routeFor(cat.target);
      });
      gridEl.appendChild(tile);
    });
  }

  function renderResults(): void {
    const n = summary.categories.length;
    resultsTitle.textContent = "Your space is ready to reclaim";
    resultsSub.textContent = `${formatBytes(summary.total)} reclaimable across ${n} ${
      n === 1 ? "category" : "categories"
    }`;
    renderGrid();
    showResults();
  }

  // --- flows -----------------------------------------------------------------
  async function runScan(): Promise<void> {
    if (phase === "scanning" || phase === "cleaning") return;
    phase = "scanning";
    if (stopAnim) stopAnim();

    showHero();
    eyebrowEl.textContent = "SMART CARE";
    titleEl.textContent = "Scanning your Mac…";
    subEl.textContent = "Looking for cache, junk and reclaimable space.";
    hintEl.textContent = "";
    ringScene.classList.remove("is-error", "is-done");
    ringScene.classList.add("is-scanning");
    setRing(0);
    setBig(0);
    readoutLabel.textContent = "scanning";
    setCta(ctaEl, "scanning");

    try {
      const reports = await api.scan([]);
      summary = summarize(reports);
      cachedSummary = summary;
      phase = "scanned";
      ringScene.classList.remove("is-scanning");

      if (summary.total <= 0) {
        ringScene.classList.add("is-done");
        setRing(1);
        setBig(0);
        readoutLabel.textContent = "reclaimable";
        eyebrowEl.textContent = "SMART CARE";
        titleEl.textContent = "You're all clean.";
        subEl.textContent = "Nothing reclaimable was found across your Mac.";
        hintEl.textContent = "";
        setCta(ctaEl, "rescan");
        showHero();
        return;
      }

      ringScene.classList.add("is-done");
      setRing(1);
      readoutLabel.textContent = "reclaimable";
      await animateTo(summary.total, reduceMotion ? 0 : 1100);
      renderResults();
    } catch (err) {
      phase = "error";
      ringScene.classList.remove("is-scanning", "is-done");
      ringScene.classList.add("is-error");
      setRing(0);
      setBig(0);
      readoutLabel.textContent = "error";
      eyebrowEl.textContent = "SMART CARE";
      titleEl.textContent = "Scan failed.";
      subEl.textContent = messageOf(err);
      hintEl.textContent = "";
      setCta(ctaEl, "retry");
      showHero();
      toast("Scan failed");
    }
  }

  async function runClean(): Promise<void> {
    if (phase !== "scanned" || summary.total <= 0) return;
    const n = summary.categories.length;
    const ok = window.confirm(
      `Clean safely moves about ${formatBytes(summary.total)} of reclaimable junk to the Trash across ${n} ${
        n === 1 ? "category" : "categories"
      }.\n\nNothing is permanently deleted — you can restore from Trash. Continue?`
    );
    if (!ok) return;

    phase = "cleaning";
    setCleanBusy(true);
    resultsSub.textContent = "Moving junk to the Trash…";

    try {
      const result = await api.smartClean(false);
      phase = "cleaned";
      summary = { total: 0, categories: [] };
      cachedSummary = summary;

      // Return to the hero and celebrate the reclaimed space on the ring.
      showHero();
      ringScene.classList.remove("is-error", "is-scanning");
      ringScene.classList.add("is-done");
      setRing(1);
      readoutLabel.textContent = "reclaimed";
      await animateTo(result.freed > 0 ? result.freed : 0, reduceMotion ? 0 : 900);

      const parts: string[] = [];
      if (result.trashed > 0)
        parts.push(`Moved ${result.trashed} ${result.trashed === 1 ? "item" : "items"} to Trash.`);
      if (result.failures > 0) parts.push(`${result.failures} couldn't be removed.`);
      eyebrowEl.textContent = "SMART CARE";
      titleEl.textContent = "Space reclaimed.";
      subEl.textContent = parts.length ? parts.join(" ") : "Your Mac is clean.";
      hintEl.textContent = "";
      setCta(ctaEl, "rescan");
      toast(
        result.failures > 0
          ? `Freed ${formatBytes(result.freed)} · ${result.failures} failed`
          : `Freed ${formatBytes(result.freed)}`
      );
    } catch (err) {
      phase = "scanned";
      setCleanBusy(false);
      resultsSub.textContent = "Clean failed.";
      toast("Clean failed");
      window.alert(`Clean failed.\n\n${messageOf(err)}`);
    }
  }

  // --- CTA wiring ------------------------------------------------------------
  type CtaMode = "scan" | "scanning" | "rescan" | "retry";
  function setCta(btn: HTMLButtonElement, mode: CtaMode): void {
    btn.classList.toggle("is-busy", mode === "scanning");
    btn.disabled = mode === "scanning";
    const labels: Record<CtaMode, string> = {
      scan: "Smart<br>Scan",
      scanning: "Scanning…",
      rescan: "Scan<br>again",
      retry: "Try<br>again",
    };
    btn.innerHTML = mode === "scanning"
      ? `<span class="dash-cta-spin" aria-hidden="true"></span>`
      : `<span class="dash-cta-label">${labels[mode]}</span>`;
    btn.setAttribute(
      "aria-label",
      mode === "scanning" ? "Scanning" : mode === "rescan" ? "Scan again" : mode === "retry" ? "Try again" : "Smart Scan"
    );
  }

  function setCleanBusy(busy: boolean): void {
    cleanCta.classList.toggle("is-busy", busy);
    cleanCta.disabled = busy;
    rescanBtn.disabled = busy;
    cleanCta.innerHTML = busy
      ? `<span class="dash-cta-spin" aria-hidden="true"></span>`
      : `<span class="dash-cta-label">Clean<br>safely</span>`;
  }

  ctaEl.addEventListener("click", () => void runScan());
  cleanCta.addEventListener("click", () => void runClean());
  rescanBtn.addEventListener("click", () => void runScan());

  // --- pointer parallax on the hero art --------------------------------------
  if (!reduceMotion) {
    const onMove = (ev: MouseEvent) => {
      if (heroPane.hidden) return;
      const r = heroPane.getBoundingClientRect();
      const dx = (ev.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = (ev.clientY - (r.top + r.height / 2)) / (r.height / 2);
      artEl.style.setProperty("--px", `${Math.max(-8, Math.min(8, dx * 8))}px`);
      artEl.style.setProperty("--py", `${Math.max(-8, Math.min(8, dy * 8))}px`);
    };
    heroPane.addEventListener("mousemove", onMove);
    heroPane.addEventListener("mouseleave", () => {
      artEl.style.setProperty("--px", "0px");
      artEl.style.setProperty("--py", "0px");
    });
  }

  // --- initial paint ---------------------------------------------------------
  setCleanBusy(false);
  if (cachedSummary) {
    summary = cachedSummary;
    if (summary.total > 0) {
      phase = "scanned";
      ringScene.classList.add("is-done");
      setRing(1);
      setBig(summary.total);
      readoutLabel.textContent = "reclaimable";
      renderResults();
    } else {
      phase = "scanned";
      ringScene.classList.add("is-done");
      setRing(1);
      setBig(0);
      eyebrowEl.textContent = "SMART CARE";
      titleEl.textContent = "You're all clean.";
      subEl.textContent = "Nothing reclaimable was found across your Mac.";
      setCta(ctaEl, "rescan");
      showHero();
    }
  } else {
    // First visit kicks off a scan immediately — the dashboard is the entry point.
    setRing(0);
    setBig(0);
    setCta(ctaEl, "scan");
    void runScan();
  }
}

// --- markup ------------------------------------------------------------------

function layoutMarkup(): string {
  return `
    <section class="dash-hero-pane hero" aria-live="polite">
      <p class="eyebrow">SMART CARE</p>
      <div class="dash-stage">
        <div class="hero-art" aria-hidden="true">${heroRaw}</div>
        <div class="dash-ring" role="img" aria-label="Reclaimable space">
          <svg class="dash-ring-svg" viewBox="0 0 260 260" aria-hidden="true">
            <defs>
              <linearGradient id="dashScanGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="var(--accent-2)" />
                <stop offset="100%" stop-color="var(--accent)" />
              </linearGradient>
            </defs>
            <circle class="dash-ring-track" cx="130" cy="130" r="${RING_R}" />
            <circle class="dash-ring-progress" cx="130" cy="130" r="${RING_R}" />
          </svg>
          <div class="dash-ring-center">
            <div class="dash-readout">
              <span class="dash-amount">0</span><span class="dash-unit">B</span>
            </div>
            <div class="dash-readout-label">reclaimable</div>
          </div>
        </div>
      </div>
      <h1 class="dash-title title">Five routines. One Smart Scan.</h1>
      <p class="dash-sub subtitle">Find cache, junk and reclaimable space across your Mac in one click.</p>
      <button type="button" class="cta-circle dash-cta">
        <span class="dash-cta-label">Smart<br>Scan</span>
      </button>
      <p class="dash-hint"></p>
    </section>

    <section class="dash-results-pane" hidden>
      <div class="results-head">
        <div>
          <h2 class="dash-results-title">Your space is ready to reclaim</h2>
          <p class="results-sub dash-results-sub"></p>
        </div>
        <div class="results-actions">
          <button type="button" class="btn btn-ghost dash-rescan">Rescan</button>
        </div>
      </div>
      <div class="grid dash-grid"></div>
      <div class="dash-clean-rail">
        <button type="button" class="cta-circle dash-clean-cta" aria-label="Clean safely">
          <span class="dash-cta-label">Clean<br>safely</span>
        </button>
        <p class="dash-hint">Nothing is deleted — items move to the Trash.</p>
      </div>
    </section>`;
}

// --- helpers -----------------------------------------------------------------

function splitBytes(bytes: number): [string, string] {
  const s = formatBytes(Math.max(0, bytes));
  const idx = s.lastIndexOf(" ");
  return [s.slice(0, idx), s.slice(idx + 1)];
}

const UNIT_POW: Record<string, number> = {
  B: 0,
  KB: 1,
  MB: 2,
  GB: 3,
  TB: 4,
  PB: 5,
};

function rejoinBytes(value: number, unit: string): number {
  const pow = UNIT_POW[unit] ?? 0;
  return value * Math.pow(1024, pow);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unexpected error.";
  }
}

function injectStyles(): void {
  if (document.getElementById("dash-styles")) return;
  const style = document.createElement("style");
  style.id = "dash-styles";
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen-dash {
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
  padding: 12px 0 var(--s-6);
}

/* hero pane uses the foundation .hero grammar; tighten its top padding so the
   ring + art read as one stage */
.dash-hero-pane {
  padding-top: 12px;
}
.dash-hero-pane[hidden] { display: none; }

/* the stage stacks the floating glossy hero behind the live scan ring */
.dash-stage {
  position: relative;
  width: 300px;
  height: 300px;
  display: grid;
  place-items: center;
  margin: var(--s-2) 0 var(--s-2);
}

.dash-stage .hero-art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0.9;
  transform: translate(var(--px, 0px), var(--py, 0px));
  transition: transform 220ms var(--ease);
  animation: hero-float 6s ease-in-out infinite alternate;
}
.dash-stage .hero-art svg {
  width: 78%;
  height: 78%;
  margin: 11%;
}

/* the scan ring sits on top of the art, centered on the stage */
.dash-ring {
  position: relative;
  width: 260px;
  height: 260px;
  display: grid;
  place-items: center;
  z-index: 1;
}
.dash-ring-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
  overflow: visible;
}
.dash-ring-track {
  fill: none;
  stroke: rgba(255, 255, 255, 0.12);
  stroke-width: 12;
}
.dash-ring-progress {
  fill: none;
  stroke: url(#dashScanGrad);
  stroke-width: 12;
  stroke-linecap: round;
  transition: stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1);
  filter: drop-shadow(0 0 12px var(--glow));
}
.dash-ring.is-scanning .dash-ring-progress {
  transition: none;
  stroke-dasharray: ${RING_C * 0.26} ${RING_C * 0.74};
  animation: dashSweep 1.1s linear infinite;
}
.dash-ring.is-scanning .dash-ring-svg {
  animation: dashSpin 2.6s linear infinite;
}
@keyframes dashSweep {
  from { stroke-dashoffset: ${RING_C}; }
  to   { stroke-dashoffset: 0; }
}
@keyframes dashSpin {
  from { transform: rotate(-90deg); }
  to   { transform: rotate(270deg); }
}
.dash-ring.is-error .dash-ring-progress {
  stroke: var(--danger);
  filter: drop-shadow(0 0 12px color-mix(in srgb, var(--danger) 55%, transparent));
}

.dash-ring-center {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.dash-readout {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-variant-numeric: tabular-nums;
}
.dash-amount {
  font-size: 52px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.03em;
  color: var(--text);
}
.dash-unit {
  font-size: 21px;
  font-weight: 600;
  color: var(--text-dim);
}
.dash-readout-label {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.dash-title { margin-top: var(--s-3); }
.dash-sub { margin-top: var(--s-2); }

/* the circular CTAs sit on a small pedestal and may overrun a touch */
.dash-cta {
  margin-top: var(--s-5);
  line-height: 1.1;
}
.dash-cta-label { display: inline-block; }
.dash-cta.is-busy { animation: none; }

.dash-cta-spin {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.32);
  border-top-color: #fff;
  animation: spin 720ms linear infinite;
}

.dash-hint {
  margin-top: var(--s-3);
  font-size: 13px;
  color: var(--text-faint);
  min-height: 18px;
}

/* ---- results pane -------------------------------------------------------- */
.dash-results-pane {
  padding-top: 0;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--t-slow) var(--ease), transform var(--t-slow) var(--ease);
}
.dash-results-pane[hidden] { display: none; }
.dash-results-pane.is-in {
  opacity: 1;
  transform: translateY(0);
}

.result-tile {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  opacity: 0;
  animation: fade-up var(--t-slow) var(--ease) forwards;
  animation-delay: var(--stagger, 0ms);
}
.tile-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.tile-chip {
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 12px;
  display: grid;
  place-items: center;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-2) 38%, transparent);
}
.tile-chip svg { display: block; }
.tile-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.tile-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.tile-count {
  font-size: 13px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.tile-size {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
}
.result-tile .sizebar { height: 6px; }
.tile-foot {
  display: flex;
  justify-content: flex-end;
}

.dash-clean-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  margin-top: var(--s-6);
}
.dash-clean-cta { line-height: 1.1; }
.dash-clean-cta.is-busy { animation: none; }

@media (prefers-reduced-motion: reduce) {
  .dash-stage .hero-art,
  .dash-ring.is-scanning .dash-ring-svg,
  .dash-ring.is-scanning .dash-ring-progress { animation: none; }
  .dash-ring-progress { transition: stroke-dashoffset 200ms linear; }
  .result-tile { opacity: 1; animation: none; }
}
`;
