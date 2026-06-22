// Applications / Uninstaller — the Blue colour world.
//
// Idle/hero: the glassy app-X hexagon floats over its halo with a circular
// "Scan apps" CTA. Running it calls api.apps() and cross-fades into a glass grid
// of app cards with a live search field. Selecting a card opens a centered glass
// modal that resolves the app's full footprint via api.footprint(), totals it,
// and offers a confirmed Uninstall → api.uninstall(query, false) that removes the
// bundle and every leftover. Colours come from the world theme vars only.

import type { Api } from "../api";
import type { AppInfo, Footprint } from "../types";
import { button, formatBytes, icon, spinner, toast } from "../components";
import heroRaw from "../assets/illustrations/applications.svg?raw";

const STYLE_ID = "applications-screen-styles";

const STYLES = `
.screen-applications {
  position: relative;
  display: flex;
  flex-direction: column;
  max-width: 960px;
  width: 100%;
  margin: 0 auto;
  padding: 12px 0 var(--s-6);
}

/* ---- idle / hero ---- */
.ap-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 880px;
  margin: 0 auto;
  padding: 12px var(--s-4) var(--s-7);
}
.ap-hero-art {
  position: relative;
  width: 240px;
  height: 240px;
  display: grid;
  place-items: center;
  animation: hero-float 6s ease-in-out infinite alternate;
}
.ap-hero-art svg {
  width: 100%;
  height: 100%;
  display: block;
  filter: drop-shadow(0 24px 40px rgba(0, 0, 0, 0.4));
  transition: transform var(--t-slow) var(--ease-soft);
}
.ap-hero-art::after {
  content: "";
  position: absolute;
  inset: 4%;
  z-index: -1;
  border-radius: 50%;
  background: radial-gradient(circle, var(--glow), transparent 68%);
  filter: blur(30px);
  animation: halo-breathe 8s ease-in-out infinite alternate;
}
.ap-hero .ap-cta-wrap {
  margin-top: var(--s-6);
}
.ap-hint {
  margin-top: var(--s-3);
  font-size: 13px;
  color: var(--text-faint);
}

/* ---- results layout ---- */
.ap-results {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0;
  animation: fade-up var(--t-slow) var(--ease) both;
}
.ap-results-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
  flex-wrap: wrap;
}
.ap-results-head .ap-eyebrow {
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-faint);
}
.ap-results-head h2 {
  margin: 6px 0 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.ap-results-head .ap-sub {
  margin: 4px 0 0;
  color: var(--text-dim);
  font-size: 14px;
}
.ap-head-actions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}

.ap-search {
  position: relative;
  width: 260px;
  max-width: 42vw;
}
.ap-search .icon {
  position: absolute;
  left: 13px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-faint);
  pointer-events: none;
}
.ap-search input {
  width: 100%;
  height: 42px;
  padding: 0 14px 0 38px;
  border-radius: var(--radius-pill);
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.07);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  outline: none;
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  backdrop-filter: blur(20px) saturate(1.4);
  transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.ap-search input::placeholder { color: var(--text-faint); }
.ap-search input:focus {
  border-color: color-mix(in srgb, var(--accent-2) 70%, transparent);
  background: rgba(255, 255, 255, 0.1);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
}

.ap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: var(--s-3);
  align-content: start;
  padding: 2px 4px 32px;
}
.ap-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 14px 18px;
  cursor: pointer;
  text-align: center;
  border-radius: var(--radius-tile);
  animation: fade-up var(--t-base) var(--ease) both;
}
.ap-card.is-hoverable:hover { transform: translateY(-3px); }
.ap-card.is-selected { transform: translateY(-1px); }
.ap-glyph {
  position: relative;
  display: grid;
  place-items: center;
  width: 60px;
  height: 60px;
  border-radius: 17px;
  font-size: 23px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #fff;
  background:
    radial-gradient(120% 120% at 30% 22%, rgba(255, 255, 255, 0.4), transparent 55%),
    linear-gradient(150deg, var(--accent), var(--accent-2));
  box-shadow:
    var(--sheen),
    0 2px 6px rgba(0, 0, 0, 0.22),
    0 8px 22px var(--glow);
}
/* Real bundle icon: let the artwork fill the tile, drop the accent fill/glow. */
.ap-glyph.has-icon {
  background: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
}
.ap-glyph-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: inherit;
  display: block;
}
.ap-name {
  position: relative;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ap-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-height: 280px;
  color: var(--text-dim);
  text-align: center;
  padding: 40px;
}
.ap-state h3 { margin: 0; color: var(--text); font-size: 18px; font-weight: 700; }
.ap-state p { margin: 0; max-width: 380px; font-size: 14px; line-height: 1.5; }

/* ---- detail modal ---- */
.ap-scrim {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.5);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms var(--ease);
}
.ap-scrim[hidden] { display: none; }
.ap-scrim.is-open { opacity: 1; pointer-events: auto; }
.ap-panel {
  width: min(520px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: rgba(22, 22, 26, 0.72);
  -webkit-backdrop-filter: blur(28px) saturate(140%);
  backdrop-filter: blur(28px) saturate(140%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: var(--el-3);
  opacity: 0;
  transform: scale(0.98);
  transition: opacity 180ms ease-out, transform 180ms ease-out;
}
.ap-scrim.is-open .ap-panel { opacity: 1; transform: scale(1); }

.ap-detail-top { flex: 0 0 auto; }
.ap-detail-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px 16px;
}
.ap-detail-header .ap-glyph {
  width: 48px;
  height: 48px;
  border-radius: 11px;
  font-size: 19px;
  flex: 0 0 auto;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.ap-detail-heading { flex: 1; min-width: 0; }
.ap-detail-heading h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ap-detail-id {
  margin: 3px 0 0;
  font-family: var(--mono);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ap-close {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.ap-close:hover { background: rgba(255, 255, 255, 0.1); color: var(--text); }
.ap-close svg { width: 18px; height: 18px; stroke: currentColor; }

.ap-total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  margin: 0 20px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--hairline);
}
.ap-total .ap-total-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
}
.ap-total .ap-total-count {
  font-size: 12px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.ap-total .ap-total-value {
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(120deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.ap-detail-content {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 0 4px;
  border-top: 1px solid var(--hairline);
}
.ap-fp-list { display: flex; flex-direction: column; padding: 6px 0; }
.ap-fp-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 8px 20px;
  border-radius: 8px;
  transition: background var(--t-fast) var(--ease);
}
.ap-fp-item:hover { background: rgba(255, 255, 255, 0.05); }
.ap-fp-path {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  font-size: 13px;
  color: var(--text);
}
.ap-fp-path .ap-path-head {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ap-fp-path .ap-path-tail {
  flex: 0 0 auto;
  white-space: nowrap;
}
.ap-fp-size {
  flex: 0 0 auto;
  min-width: 64px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--text-dim);
}
.ap-detail-footer {
  position: relative;
  flex: 0 0 auto;
  padding: 16px 20px 18px;
  border-top: 1px solid var(--hairline);
}
.ap-detail-footer .btn { width: 100%; height: 44px; border-radius: var(--radius-pill); }
.ap-detail-footer .ap-footer-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-faint);
  text-align: center;
  line-height: 1.4;
}
.ap-detail-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 24px;
  color: var(--text-dim);
  text-align: center;
}
.ap-detail-state h3 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.ap-detail-state p { margin: 0; max-width: 320px; font-size: 13px; line-height: 1.5; }

@media (prefers-reduced-motion: reduce) {
  .ap-hero-art { animation: none; }
  .ap-hero-art::after { animation: none; }
  .ap-panel, .ap-scrim, .ap-card { transition: none; animation: none; }
  .ap-scrim.is-open .ap-panel { transform: none; }
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const tag = document.createElement("style");
  tag.id = STYLE_ID;
  tag.textContent = STYLES;
  document.head.appendChild(tag);
}

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function initials(name: string): string {
  const words = name.trim().split(/[\s.-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function glyph(app: AppInfo): HTMLElement {
  const el = document.createElement("div");
  el.className = "ap-glyph";
  el.setAttribute("aria-hidden", "true");
  if (app.icon) {
    el.classList.add("has-icon");
    const img = document.createElement("img");
    img.className = "ap-glyph-img";
    img.src = app.icon;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    // Fall back to initials if the data URI ever fails to decode.
    img.onerror = () => {
      el.classList.remove("has-icon");
      el.textContent = initials(app.name);
    };
    el.appendChild(img);
  } else {
    el.textContent = initials(app.name);
  }
  return el;
}

// Collapse the user's home prefix and split a path into a flexible head and a
// pinned tail (last 1–2 segments) so the middle ellipsis keeps both ends legible.
function pathParts(raw: string): { full: string; head: string; tail: string } {
  const full = raw;
  const display = raw.replace(/^\/Users\/[^/]+\//, "~/");
  const segs = display.split("/");
  const tailCount = Math.min(2, Math.max(1, segs.length - 1));
  if (segs.length <= tailCount) {
    return { full, head: "", tail: display };
  }
  const tailSegs = segs.slice(segs.length - tailCount);
  const headSegs = segs.slice(0, segs.length - tailCount);
  return { full, head: headSegs.join("/") + "/", tail: tailSegs.join("/") };
}

function stateBlock(title: string, message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "ap-state";
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = message;
  el.append(h, p);
  return el;
}

export function renderApplications(root: HTMLElement, api: Api): void {
  ensureStyles();

  const screen = document.createElement("div");
  screen.className = "screen screen-applications";
  root.appendChild(screen);

  // Stage holds whichever state is live (hero / loading / results).
  const stage = document.createElement("div");
  stage.style.display = "flex";
  stage.style.flexDirection = "column";
  screen.appendChild(stage);

  // ---- Detail panel (shared across the results state) --------------------
  let selected: AppInfo | null = null;
  let footprintToken = 0;

  const scrim = document.createElement("div");
  scrim.className = "ap-scrim";
  scrim.hidden = true;
  const panel = document.createElement("div");
  panel.className = "ap-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Application details");
  scrim.appendChild(panel);

  function closeDetail(): void {
    footprintToken += 1;
    selected = null;
    scrim.classList.remove("is-open");
    screen
      .querySelectorAll<HTMLElement>(".ap-card.is-selected")
      .forEach((c) => c.classList.remove("is-selected"));
    window.setTimeout(() => {
      if (!selected) scrim.hidden = true;
    }, 200);
  }

  // Clicks on the scrim dismiss; clicks inside the modal don't bubble out.
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) closeDetail();
  });
  document.addEventListener("keydown", function onKey(e) {
    if (!screen.isConnected) {
      document.removeEventListener("keydown", onKey);
      return;
    }
    if (e.key === "Escape" && selected) closeDetail();
  });

  function renderFootprint(app: AppInfo, fp: Footprint): void {
    panel.innerHTML = "";

    const items = [...fp.items].sort((a, b) => b.size - a.size);
    const total = items.reduce((sum, it) => sum + it.size, 0);

    // Top region (header + total) does not scroll.
    const top = document.createElement("div");
    top.className = "ap-detail-top";

    const header = document.createElement("div");
    header.className = "ap-detail-header";
    header.appendChild(glyph(app));
    const heading = document.createElement("div");
    heading.className = "ap-detail-heading";
    const h3 = document.createElement("h3");
    h3.textContent = fp.name || app.name;
    const idLine = document.createElement("p");
    idLine.className = "ap-detail-id";
    idLine.textContent = fp.id || app.id || app.path;
    heading.append(h3, idLine);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ap-close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = CLOSE_ICON;
    close.addEventListener("click", closeDetail);
    header.append(heading, close);

    const totalRow = document.createElement("div");
    totalRow.className = "ap-total";
    const count = items.length
      ? `<span class="ap-total-count">${items.length} item${
          items.length === 1 ? "" : "s"
        }</span>`
      : "";
    totalRow.innerHTML = `<span class="ap-total-label">Total footprint</span>${count}<span class="ap-total-value">${formatBytes(
      total
    )}</span>`;

    top.append(header, totalRow);

    const content = document.createElement("div");
    content.className = "ap-detail-content";

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ap-detail-state";
      empty.innerHTML =
        "<p>No leftover files found — only the app itself.</p>";
      content.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "ap-fp-list";
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "ap-fp-item";
        const path = document.createElement("span");
        path.className = "ap-fp-path";
        path.title = it.path;
        const parts = pathParts(it.path);
        if (parts.head) {
          const head = document.createElement("span");
          head.className = "ap-path-head";
          head.textContent = parts.head;
          path.appendChild(head);
        }
        const tail = document.createElement("span");
        tail.className = "ap-path-tail";
        tail.textContent = parts.tail;
        path.appendChild(tail);
        const size = document.createElement("span");
        size.className = "ap-fp-size";
        size.textContent = formatBytes(it.size);
        row.append(path, size);
        list.appendChild(row);
      }
      content.appendChild(list);
    }

    const footer = document.createElement("div");
    footer.className = "ap-detail-footer";
    const uninstallBtn = button({
      label: `Uninstall ${fp.name || app.name}`,
      variant: "danger",
      onClick: () => runUninstall(app, fp, uninstallBtn),
    });
    const hint = document.createElement("p");
    hint.className = "ap-footer-hint";
    hint.textContent =
      "Moves the app and all listed files to the Trash. You can restore them until you empty it.";
    footer.append(uninstallBtn, hint);

    panel.append(top, content, footer);
  }

  async function runUninstall(
    app: AppInfo,
    fp: Footprint,
    trigger: HTMLButtonElement
  ): Promise<void> {
    const name = fp.name || app.name;
    const total = fp.items.reduce((sum, it) => sum + it.size, 0);
    const confirmed = window.confirm(
      `Uninstall ${name}?\n\nThis moves the application and ${
        fp.items.length
      } associated item(s) — about ${formatBytes(
        total
      )} — to the Trash. You can restore them from the Trash if needed.`
    );
    if (!confirmed) return;

    trigger.disabled = true;
    const original = trigger.textContent;
    trigger.textContent = "Uninstalling…";
    try {
      const result = await api.uninstall(app.id || app.path, false);
      if (result.failures > 0) {
        toast(
          `${name}: removed ${formatBytes(result.freed)}, but ${
            result.failures
          } item(s) could not be removed.`
        );
      } else {
        toast(`${name} uninstalled — ${formatBytes(result.freed)} reclaimed.`);
      }
      closeDetail();
      void load();
    } catch (err) {
      trigger.disabled = false;
      trigger.textContent = original;
      toast(`Failed to uninstall ${name}: ${String(err)}`);
    }
  }

  async function openDetail(app: AppInfo, cardEl: HTMLElement): Promise<void> {
    selected = app;
    const token = ++footprintToken;

    screen
      .querySelectorAll<HTMLElement>(".ap-card.is-selected")
      .forEach((c) => c.classList.remove("is-selected"));
    cardEl.classList.add("is-selected");

    scrim.hidden = false;
    panel.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "ap-detail-state";
    loading.append(spinner());
    const p = document.createElement("p");
    p.textContent = `Scanning ${app.name}…`;
    loading.appendChild(p);
    panel.appendChild(loading);

    // Allow the element to paint before triggering the fade/scale enter.
    requestAnimationFrame(() => {
      scrim.classList.add("is-open");
    });

    try {
      const fp = await api.footprint(app.id || app.path);
      if (token !== footprintToken) return; // superseded or closed
      renderFootprint(app, fp);
    } catch (err) {
      if (token !== footprintToken) return;
      panel.innerHTML = "";
      const top = document.createElement("div");
      top.className = "ap-detail-top";
      const header = document.createElement("div");
      header.className = "ap-detail-header";
      header.appendChild(glyph(app));
      const heading = document.createElement("div");
      heading.className = "ap-detail-heading";
      const h3 = document.createElement("h3");
      h3.textContent = app.name;
      heading.appendChild(h3);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "ap-close";
      close.setAttribute("aria-label", "Close");
      close.innerHTML = CLOSE_ICON;
      close.addEventListener("click", closeDetail);
      header.append(heading, close);
      top.appendChild(header);

      const content = document.createElement("div");
      content.className = "ap-detail-content";
      const block = document.createElement("div");
      block.className = "ap-detail-state";
      const title = document.createElement("h3");
      title.textContent = "Couldn’t read footprint";
      const msg = document.createElement("p");
      msg.textContent = String(err);
      const retry = button({
        label: "Retry",
        variant: "ghost",
        onClick: () => void openDetail(app, cardEl),
      });
      block.append(title, msg, retry);
      content.appendChild(block);
      panel.append(top, content);
    }
  }

  // ---- Results grid ------------------------------------------------------
  let allApps: AppInfo[] = [];
  let searchInput: HTMLInputElement | null = null;
  let gridEl: HTMLElement | null = null;

  function renderGrid(): void {
    if (!gridEl) return;
    gridEl.innerHTML = "";

    const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const filtered = query
      ? allApps.filter(
          (a) =>
            a.name.toLowerCase().includes(query) ||
            a.id.toLowerCase().includes(query)
        )
      : allApps;

    if (allApps.length === 0) {
      gridEl.style.display = "block";
      gridEl.appendChild(
        stateBlock(
          "No applications found",
          "Sweep didn’t detect any installed applications on this Mac."
        )
      );
      return;
    }
    if (filtered.length === 0) {
      gridEl.style.display = "block";
      gridEl.appendChild(
        stateBlock(
          "No matches",
          `No applications match “${searchInput?.value.trim()}”. Try a different search.`
        )
      );
      return;
    }

    gridEl.style.display = "grid";
    filtered.forEach((app, i) => {
      const cardEl = document.createElement("div");
      cardEl.className = "ap-card glass-card is-hoverable";
      cardEl.setAttribute("role", "listitem");
      cardEl.tabIndex = 0;
      cardEl.setAttribute("aria-label", `Inspect ${app.name}`);
      cardEl.style.animationDelay = `${Math.min(i, 16) * 30}ms`;
      cardEl.appendChild(glyph(app));
      const nameEl = document.createElement("div");
      nameEl.className = "ap-name";
      nameEl.textContent = app.name;
      nameEl.title = app.name;
      cardEl.appendChild(nameEl);
      cardEl.addEventListener("click", () => void openDetail(app, cardEl));
      cardEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void openDetail(app, cardEl);
        }
      });
      gridEl!.appendChild(cardEl);
    });
  }

  function showResults(): void {
    stage.innerHTML = "";

    const results = document.createElement("div");
    results.className = "ap-results";

    const head = document.createElement("div");
    head.className = "ap-results-head";
    const headLeft = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "ap-eyebrow";
    eyebrow.textContent = "Applications";
    const h2 = document.createElement("h2");
    h2.textContent = "Manage your apps";
    const sub = document.createElement("p");
    sub.className = "ap-sub";
    sub.textContent = `${allApps.length} app${
      allApps.length === 1 ? "" : "s"
    } installed — select one to inspect its footprint and uninstall it cleanly.`;
    headLeft.append(eyebrow, h2, sub);

    const headActions = document.createElement("div");
    headActions.className = "ap-head-actions";

    const search = document.createElement("div");
    search.className = "ap-search";
    search.appendChild(icon("search", { size: 16 }));
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search apps";
    input.setAttribute("aria-label", "Search applications");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.addEventListener("input", () => renderGrid());
    search.appendChild(input);
    searchInput = input;

    const rescan = button({
      label: "Rescan",
      variant: "ghost",
      icon: "refresh",
      onClick: () => void load(),
    });

    headActions.append(search, rescan);
    head.append(headLeft, headActions);

    const grid = document.createElement("div");
    grid.className = "ap-grid";
    grid.setAttribute("role", "list");
    gridEl = grid;

    results.append(head, grid);
    stage.appendChild(results);

    // Detail overlay lives at the screen level so it covers the full content.
    screen.append(scrim);

    renderGrid();
  }

  function showLoading(): void {
    stage.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "ap-state";
    const sp = spinner();
    sp.classList.add("is-lg");
    loading.append(sp);
    const p = document.createElement("p");
    p.textContent = "Scanning installed applications…";
    loading.appendChild(p);
    stage.appendChild(loading);
  }

  function showHero(): void {
    stage.innerHTML = "";
    gridEl = null;
    searchInput = null;

    const hero = document.createElement("div");
    hero.className = "ap-hero";
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Applications";
    const art = document.createElement("div");
    art.className = "ap-hero-art";
    art.setAttribute("aria-hidden", "true");
    art.innerHTML = heroRaw;
    const title = document.createElement("h1");
    title.className = "title";
    title.textContent = "Uninstall apps, leave nothing behind.";
    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent =
      "Find every app on your Mac and remove it along with its caches, supports and preferences.";

    const ctaWrap = document.createElement("div");
    ctaWrap.className = "ap-cta-wrap";
    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "cta-circle";
    cta.textContent = "Scan apps";
    cta.setAttribute("aria-label", "Scan installed applications");
    cta.addEventListener("click", () => void load());
    ctaWrap.appendChild(cta);

    const hint = document.createElement("p");
    hint.className = "ap-hint";
    hint.textContent = "Nothing is deleted — items move to the Trash.";

    hero.append(eyebrow, art, title, subtitle, ctaWrap, hint);
    stage.appendChild(hero);
  }

  function showError(err: unknown): void {
    stage.innerHTML = "";
    const errState = stateBlock("Couldn’t load applications", String(err));
    errState.appendChild(
      button({ label: "Try again", variant: "primary", onClick: () => void load() })
    );
    stage.appendChild(errState);
  }

  // ---- Load flow ---------------------------------------------------------
  async function load(): Promise<void> {
    showLoading();
    try {
      const apps = await api.apps();
      allApps = [...apps].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
      showResults();
    } catch (err) {
      showError(err);
    }
  }

  // Start on the idle hero; the circular CTA kicks off the scan.
  showHero();
}
