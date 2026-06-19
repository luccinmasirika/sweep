// Smart Care dashboard. A hero with a big animated circular progress ring, a
// "Smart Scan" that scans every target and tallies reclaimable bytes, per-category
// chips, and a "Clean safely" action that runs smartClean and reports the result.

import type { Api } from "../api";
import type { Report } from "../types";
import { button, card, formatBytes, icon, spinner, toast } from "../components";

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

const RING_R = 120;
const RING_C = 2 * Math.PI * RING_R;

// Friendly labels + accent hues for the targets sweep can return.
const TARGET_META: Record<string, { label: string; hue: number }> = {
  "system-caches": { label: "System Caches", hue: 256 },
  "app-caches": { label: "App Caches", hue: 280 },
  "dev-tools": { label: "Developer Tools", hue: 192 },
  xcode: { label: "Xcode", hue: 210 },
  projects: { label: "Project Junk", hue: 152 },
  "large-items": { label: "Large Items", hue: 38 },
  logs: { label: "Logs", hue: 320 },
  trash: { label: "Trash", hue: 8 },
};

function metaFor(target: string): { label: string; hue: number } {
  if (TARGET_META[target]) return TARGET_META[target];
  const label = target
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  // Stable pseudo-hue from the name so unknown targets still get a distinct tint.
  let h = 0;
  for (let i = 0; i < target.length; i++) h = (h * 31 + target.charCodeAt(i)) % 360;
  return { label, hue: h };
}

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

  let phase: Phase = "idle";
  let summary: ScanSummary = { total: 0, categories: [] };
  // Cancels any in-flight ring count-up animation between renders/clicks.
  let stopAnim: (() => void) | null = null;

  const el = document.createElement("div");
  el.className = "screen screen-dashboard";

  const hero = card({ className: "dash-hero" });
  hero.innerHTML = heroMarkup();
  el.appendChild(hero);

  const chipsWrap = document.createElement("div");
  chipsWrap.className = "dash-chips";
  el.appendChild(chipsWrap);

  root.appendChild(el);

  // --- ring handles ----------------------------------------------------------
  const ringProgress = hero.querySelector<SVGCircleElement>(".ring-progress")!;
  const ringScene = hero.querySelector<HTMLElement>(".dash-ring")!;
  const amountEl = hero.querySelector<HTMLElement>(".dash-amount")!;
  const unitEl = hero.querySelector<HTMLElement>(".dash-unit")!;
  const captionEl = hero.querySelector<HTMLElement>(".dash-caption")!;
  const actionsEl = hero.querySelector<HTMLElement>(".dash-actions")!;
  ringProgress.style.strokeDasharray = `${RING_C}`;

  function setRing(p: number): void {
    const clamped = Math.max(0, Math.min(1, p));
    ringProgress.style.strokeDashoffset = `${RING_C * (1 - clamped)}`;
  }

  function setBig(bytes: number): void {
    const [value, unit] = splitBytes(bytes);
    amountEl.textContent = value;
    unitEl.textContent = unit;
  }

  function setCaption(html: string): void {
    captionEl.innerHTML = html;
  }

  // Smoothly animate the ring fill and the headline byte counter in lockstep.
  function animateTo(targetBytes: number, durationMs: number): Promise<void> {
    if (stopAnim) stopAnim();
    return new Promise((resolve) => {
      const start = performance.now();
      const from = currentBig();
      let raf = 0;
      let cancelled = false;
      const tick = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - start) / durationMs);
        const eased = easeOutCubic(t);
        const bytes = from + (targetBytes - from) * eased;
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

  function currentBig(): number {
    const v = parseFloat(amountEl.textContent || "0");
    const u = unitEl.textContent || "B";
    return rejoinBytes(v, u);
  }

  // --- chips -----------------------------------------------------------------
  function renderChips(): void {
    chipsWrap.innerHTML = "";
    if (phase === "idle" || phase === "scanning") return;
    if (summary.categories.length === 0) return;
    for (const cat of summary.categories) {
      const meta = metaFor(cat.target);
      const chip = document.createElement("div");
      chip.className = "dash-chip";
      chip.style.setProperty("--chip-hue", String(meta.hue));
      const pct = summary.total > 0 ? (cat.bytes / summary.total) * 100 : 0;
      chip.innerHTML = `
        <span class="chip-dot" aria-hidden="true"></span>
        <span class="chip-body">
          <span class="chip-label"></span>
          <span class="chip-size"></span>
        </span>
        <span class="chip-bar" aria-hidden="true"><span class="chip-bar-fill"></span></span>`;
      chip.querySelector(".chip-dot")!.appendChild(icon(iconFor(cat.target), { size: 15 }));
      chip.querySelector(".chip-label")!.textContent = meta.label;
      chip.querySelector(".chip-size")!.textContent = formatBytes(cat.bytes);
      const fill = chip.querySelector<HTMLElement>(".chip-bar-fill")!;
      requestAnimationFrame(() => {
        fill.style.width = `${Math.max(3, pct)}%`;
      });
      chipsWrap.appendChild(chip);
    }
    requestAnimationFrame(() => chipsWrap.classList.add("is-in"));
  }

  // --- actions ---------------------------------------------------------------
  function renderActions(): void {
    actionsEl.innerHTML = "";
    if (phase === "scanning" || phase === "cleaning") {
      const sp = spinner();
      sp.classList.add("dash-spinner");
      actionsEl.appendChild(sp);
      const note = document.createElement("span");
      note.className = "dash-busy-note";
      note.textContent = phase === "scanning" ? "Scanning your Mac…" : "Cleaning safely…";
      actionsEl.appendChild(note);
      return;
    }

    if (phase === "scanned" && summary.total > 0) {
      const clean = button({
        label: "Clean safely",
        variant: "primary",
        onClick: () => void runClean(),
      });
      clean.classList.add("dash-cta", "is-primary");
      actionsEl.appendChild(clean);
      const rescan = button({
        label: "Rescan",
        variant: "ghost",
        onClick: () => void runScan(),
      });
      rescan.classList.add("dash-cta");
      actionsEl.appendChild(rescan);
      return;
    }

    // idle, empty-scan, cleaned and error all offer a (re)scan entry point.
    const label =
      phase === "cleaned" || phase === "scanned" ? "Scan again" : "Smart Scan";
    const scan = button({
      label,
      variant: "primary",
      onClick: () => void runScan(),
    });
    scan.classList.add("dash-cta", "is-primary");
    actionsEl.appendChild(scan);
  }

  // --- flows -----------------------------------------------------------------
  async function runScan(): Promise<void> {
    if (phase === "scanning" || phase === "cleaning") return;
    phase = "scanning";
    if (stopAnim) stopAnim();
    ringScene.classList.remove("is-error", "is-done");
    ringScene.classList.add("is-scanning");
    setRing(0);
    setBig(0);
    setCaption(`<span class="dash-status">Looking for reclaimable space…</span>`);
    renderChips();
    renderActions();

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
        setCaption(
          `<span class="dash-status ok">You're all clean.</span><span class="dash-sub">Nothing reclaimable was found.</span>`
        );
        renderChips();
        renderActions();
        return;
      }

      ringScene.classList.add("is-done");
      setRing(1);
      setCaption(
        `<span class="dash-status">Reclaimable across <strong>${summary.categories.length}</strong> ${
          summary.categories.length === 1 ? "category" : "categories"
        }</span>`
      );
      // Count the headline up to the real total while the ring sweeps full.
      await animateTo(summary.total, 1100);
      renderChips();
      renderActions();
    } catch (err) {
      phase = "error";
      ringScene.classList.remove("is-scanning", "is-done");
      ringScene.classList.add("is-error");
      setRing(0);
      setBig(0);
      setCaption(
        `<span class="dash-status danger">Scan failed.</span><span class="dash-sub">${escapeHtml(
          messageOf(err)
        )}</span>`
      );
      renderChips();
      renderActions();
      toast("Scan failed");
    }
  }

  async function runClean(): Promise<void> {
    if (phase !== "scanned" || summary.total <= 0) return;
    const ok = window.confirm(
      `Clean safely moves about ${formatBytes(
        summary.total
      )} of reclaimable junk to the Trash across ${summary.categories.length} ${
        summary.categories.length === 1 ? "category" : "categories"
      }.\n\nNothing is permanently deleted — you can restore from Trash. Continue?`
    );
    if (!ok) return;

    phase = "cleaning";
    ringScene.classList.remove("is-done", "is-error");
    ringScene.classList.add("is-cleaning");
    setCaption(`<span class="dash-status">Moving junk to the Trash…</span>`);
    renderChips();
    renderActions();
    // Drain the ring toward empty to signal space being reclaimed.
    setRing(0.08);

    try {
      const result = await api.smartClean(false);
      phase = "cleaned";
      ringScene.classList.remove("is-cleaning");
      ringScene.classList.add("is-done");
      setRing(1);
      summary = { total: 0, categories: [] };
      cachedSummary = summary;

      await animateTo(result.freed > 0 ? result.freed : result.trashed, 900);
      const parts: string[] = [];
      if (result.trashed > 0)
        parts.push(`moved ${result.trashed} ${result.trashed === 1 ? "item" : "items"} to Trash`);
      if (result.failures > 0)
        parts.push(`<span class="danger">${result.failures} couldn't be removed</span>`);
      const detail = parts.length
        ? parts.join(" · ")
        : "Nothing needed cleaning.";
      setCaption(
        `<span class="dash-status ok">Reclaimed space.</span><span class="dash-sub">${detail}</span>`
      );
      renderChips();
      renderActions();
      toast(
        result.failures > 0
          ? `Freed ${formatBytes(result.freed)} · ${result.failures} failed`
          : `Freed ${formatBytes(result.freed)}`
      );
    } catch (err) {
      phase = "error";
      ringScene.classList.remove("is-cleaning", "is-done");
      ringScene.classList.add("is-error");
      setCaption(
        `<span class="dash-status danger">Clean failed.</span><span class="dash-sub">${escapeHtml(
          messageOf(err)
        )}</span>`
      );
      renderActions();
      toast("Clean failed");
    }
  }

  // Initial paint.
  setRing(0);
  setBig(0);
  setCaption(
    `<span class="dash-status">Ready to scan.</span><span class="dash-sub">Find cache, junk and reclaimable space across your Mac.</span>`
  );
  renderActions();

  // Restore the last scan instantly if we have one; otherwise kick off a fresh
  // scan since the dashboard is the first thing a user sees.
  if (cachedSummary) {
    summary = cachedSummary;
    phase = "scanned";
    ringScene.classList.add("is-done");
    setRing(1);
    setBig(summary.total);
    if (summary.total > 0) {
      setCaption(
        `<span class="dash-status">Reclaimable across <strong>${summary.categories.length}</strong> ${
          summary.categories.length === 1 ? "category" : "categories"
        }</span>`
      );
    } else {
      setCaption(`<span class="dash-status ok">You're all clean.</span>`);
    }
    renderChips();
    renderActions();
  } else {
    void runScan();
  }
}

// --- helpers -----------------------------------------------------------------

function heroMarkup(): string {
  return `
    <div class="dash-hero-glow" aria-hidden="true"></div>
    <div class="dash-eyebrow">Smart Care</div>
    <div class="dash-ring" role="img" aria-label="Reclaimable space">
      <svg class="ring-svg" viewBox="0 0 280 280" aria-hidden="true">
        <defs>
          <linearGradient id="dashRingGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="var(--accent)" />
            <stop offset="100%" stop-color="var(--accent-2)" />
          </linearGradient>
        </defs>
        <circle class="ring-track" cx="140" cy="140" r="${RING_R}" />
        <circle class="ring-progress" cx="140" cy="140" r="${RING_R}" />
      </svg>
      <div class="dash-ring-center">
        <div class="dash-readout">
          <span class="dash-amount">0</span><span class="dash-unit">B</span>
        </div>
        <div class="dash-readout-label">reclaimable</div>
      </div>
    </div>
    <div class="dash-caption"></div>
    <div class="dash-actions"></div>`;
}

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function injectStyles(): void {
  if (document.getElementById("dash-styles")) return;
  const style = document.createElement("style");
  style.id = "dash-styles";
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen-dashboard {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  padding: 28px;
  max-width: 880px;
  margin: 0 auto;
}

.dash-hero {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40px 32px 36px;
  border-radius: var(--radius-lg);
  background:
    radial-gradient(120% 90% at 50% -10%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 60%),
    var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
}

.dash-hero-glow {
  position: absolute;
  inset: -40% 10% auto 10%;
  height: 320px;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 30%, transparent), transparent);
  filter: blur(40px);
  opacity: 0.55;
  pointer-events: none;
  animation: dashGlow 8s ease-in-out infinite alternate;
}
@keyframes dashGlow {
  from { transform: translateY(0) scale(1); opacity: 0.45; }
  to   { transform: translateY(20px) scale(1.08); opacity: 0.7; }
}

.dash-eyebrow {
  position: relative;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: 18px;
}

.dash-ring {
  position: relative;
  width: 280px;
  height: 280px;
  display: grid;
  place-items: center;
}
.ring-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.ring-track {
  fill: none;
  stroke: color-mix(in srgb, var(--border) 80%, transparent);
  stroke-width: 14;
}
.ring-progress {
  fill: none;
  stroke: url(#dashRingGrad);
  stroke-width: 14;
  stroke-linecap: round;
  transition: stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1);
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--accent) 50%, transparent));
}
.dash-ring.is-scanning .ring-progress {
  transition: none;
  animation: dashSweep 1.1s linear infinite;
  stroke-dasharray: ${RING_C * 0.28} ${RING_C * 0.72};
}
@keyframes dashSweep {
  from { stroke-dashoffset: ${RING_C}; }
  to   { stroke-dashoffset: 0; }
}
.dash-ring.is-scanning .ring-svg {
  animation: dashSpin 2.4s linear infinite;
}
@keyframes dashSpin {
  from { transform: rotate(-90deg); }
  to   { transform: rotate(270deg); }
}
.dash-ring.is-done .ring-progress {
  stroke: url(#dashRingGrad);
}
.dash-ring.is-error .ring-progress {
  stroke: var(--danger);
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--danger) 50%, transparent));
}

.dash-ring-center {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.dash-readout {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}
.dash-amount {
  font-size: 56px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.02em;
  background: linear-gradient(120deg, var(--text), color-mix(in srgb, var(--accent-2) 60%, var(--text)));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.dash-unit {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-dim);
}
.dash-readout-label {
  font-size: 13px;
  color: var(--text-faint);
  letter-spacing: 0.04em;
}

.dash-caption {
  position: relative;
  min-height: 44px;
  margin-top: 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  animation: dashFade 320ms ease;
}
@keyframes dashFade {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.dash-status { font-size: 16px; font-weight: 600; color: var(--text); }
.dash-status strong { color: var(--accent-2); }
.dash-status.ok { color: var(--ok); }
.dash-status.danger { color: var(--danger); }
.dash-sub { font-size: 13px; color: var(--text-dim); max-width: 420px; }
.dash-sub .danger { color: var(--danger); }

.dash-actions {
  position: relative;
  margin-top: 24px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.dash-cta {
  min-width: 150px;
  height: 44px;
  border-radius: 999px;
  font-size: 15px;
  font-weight: 600;
  transition: transform 160ms ease, box-shadow 200ms ease, filter 200ms ease;
}
.dash-cta:hover { transform: translateY(-1px); }
.dash-cta:active { transform: translateY(0); }
.dash-cta.is-primary {
  background: linear-gradient(120deg, var(--accent), var(--accent-2));
  color: #0b0c0f;
  border: none;
  box-shadow: 0 10px 28px color-mix(in srgb, var(--accent) 40%, transparent);
}
.dash-cta.is-primary:hover {
  filter: brightness(1.05);
  box-shadow: 0 14px 34px color-mix(in srgb, var(--accent) 50%, transparent);
}
.dash-cta.is-primary:focus-visible {
  outline: 2px solid var(--accent-2);
  outline-offset: 3px;
}

.dash-spinner { width: 22px; height: 22px; }
.dash-busy-note { font-size: 14px; color: var(--text-dim); }

.dash-chips {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 320ms ease, transform 320ms ease;
}
.dash-chips.is-in { opacity: 1; transform: translateY(0); }

.dash-chip {
  --chip-color: hsl(var(--chip-hue, 256) 80% 64%);
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  align-items: center;
  column-gap: 12px;
  row-gap: 8px;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
}
.dash-chip:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--chip-color) 50%, var(--border));
  background: var(--surface-2);
}
.chip-dot {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  color: var(--chip-color);
  background: color-mix(in srgb, var(--chip-color) 16%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--chip-color) 30%, transparent);
}
.chip-dot svg { display: block; }
.chip-body { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.chip-label { font-size: 14px; font-weight: 600; color: var(--text); }
.chip-size { font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.chip-bar {
  grid-column: 1 / -1;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--border) 70%, transparent);
  overflow: hidden;
}
.chip-bar-fill {
  display: block;
  height: 100%;
  width: 0;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--chip-color), color-mix(in srgb, var(--chip-color) 50%, var(--accent-2)));
  transition: width 700ms cubic-bezier(0.22, 1, 0.36, 1);
}

@media (prefers-reduced-motion: reduce) {
  .dash-hero-glow,
  .dash-ring.is-scanning .ring-svg,
  .dash-ring.is-scanning .ring-progress { animation: none; }
  .ring-progress { transition: stroke-dashoffset 200ms linear; }
}
`;
