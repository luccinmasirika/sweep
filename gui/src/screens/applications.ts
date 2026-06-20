// Applications / Uninstaller — the Blue colour world.
//
// Idle/hero: the glassy app-X hexagon floats over its halo with a circular
// "Scan apps" CTA. Running it calls api.apps() and cross-fades into a glass grid
// of app cards with a live search field. Selecting a card opens a glass detail
// panel that resolves the app's full footprint via api.footprint(), totals it,
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
  box-shadow: 0 0 0 3px var(--glow);
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
    0 0 0 1px rgba(255, 255, 255, 0.18) inset,
    0 8px 20px var(--glow),
    0 2px 6px rgba(0, 0, 0, 0.32);
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

/* ---- detail panel ---- */
.ap-scrim {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: rgba(0, 0, 0, 0.42);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--t-base) var(--ease);
}
.ap-scrim.is-open { opacity: 1; pointer-events: auto; }
.ap-panel {
  position: absolute;
  top: var(--s-3);
  right: var(--s-3);
  bottom: var(--s-3);
  width: min(460px, calc(100% - var(--s-5)));
  z-index: 6;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-radius: var(--radius-card);
  transform: translateX(calc(100% + var(--s-4)));
  transition: transform var(--t-slow) var(--ease-soft);
}
.ap-panel.is-open { transform: translateX(0); }

.ap-detail-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--hairline);
}
.ap-detail-header .ap-glyph { width: 50px; height: 50px; border-radius: 15px; font-size: 20px; flex: 0 0 auto; }
.ap-detail-heading { flex: 1; min-width: 0; }
.ap-detail-heading h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ap-detail-id {
  margin: 3px 0 0;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ap-close {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-dim);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.ap-close:hover { background: rgba(255, 255, 255, 0.12); color: var(--text); }
.ap-close svg { width: 18px; height: 18px; stroke: currentColor; }

.ap-detail-content {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px;
}
.ap-total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 16px 18px;
  margin-bottom: 16px;
  border-radius: var(--radius-tile);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--hairline);
}
.ap-total .ap-total-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
}
.ap-total .ap-total-value {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(120deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.ap-fp-list { display: flex; flex-direction: column; gap: 2px; }
.ap-fp-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  border-radius: 12px;
  transition: background var(--t-fast) var(--ease);
}
.ap-fp-item:hover { background: rgba(255, 255, 255, 0.06); }
.ap-fp-path {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.ap-fp-size {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--text-dim);
}
.ap-detail-footer {
  position: relative;
  padding: 16px 20px 20px;
  border-top: 1px solid var(--hairline);
}
.ap-detail-footer .btn { width: 100%; height: 46px; border-radius: var(--radius-pill); }
.ap-detail-footer .ap-footer-hint {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--text-faint);
  text-align: center;
}
.ap-detail-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--text-dim);
  text-align: center;
}
.ap-detail-state h3 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.ap-detail-state p { margin: 0; max-width: 320px; font-size: 13px; line-height: 1.5; }

@media (prefers-reduced-motion: reduce) {
  .ap-hero-art { animation: none; }
  .ap-hero-art::after { animation: none; }
  .ap-panel, .ap-scrim, .ap-card { transition: none; animation: none; }
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
  el.textContent = initials(app.name);
  return el;
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
  const panel = document.createElement("div");
  panel.className = "ap-panel glass-strong";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Application details");
  panel.hidden = true;

  function closeDetail(): void {
    footprintToken += 1;
    selected = null;
    panel.classList.remove("is-open");
    scrim.classList.remove("is-open");
    screen
      .querySelectorAll<HTMLElement>(".ap-card.is-selected")
      .forEach((c) => c.classList.remove("is-selected"));
    window.setTimeout(() => {
      if (!selected) panel.hidden = true;
    }, 320);
  }

  scrim.addEventListener("click", closeDetail);
  document.addEventListener("keydown", function onKey(e) {
    if (!screen.isConnected) {
      document.removeEventListener("keydown", onKey);
      return;
    }
    if (e.key === "Escape" && selected) closeDetail();
  });

  function renderFootprint(app: AppInfo, fp: Footprint): void {
    panel.innerHTML = "";

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

    const content = document.createElement("div");
    content.className = "ap-detail-content";

    const items = [...fp.items].sort((a, b) => b.size - a.size);
    const total = items.reduce((sum, it) => sum + it.size, 0);

    const totalRow = document.createElement("div");
    totalRow.className = "ap-total";
    totalRow.innerHTML = `<span class="ap-total-label">Total footprint</span><span class="ap-total-value">${formatBytes(
      total
    )}</span>`;
    content.appendChild(totalRow);

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ap-detail-state";
      empty.innerHTML =
        '<p>No leftover files were found for this app. Uninstalling will remove the bundle itself.</p>';
      content.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "ap-fp-list";
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "ap-fp-item";
        const path = document.createElement("span");
        path.className = "ap-fp-path";
        path.textContent = it.path;
        path.title = it.path;
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
      total > 0
        ? `Moves the app and ${formatBytes(total)} of leftovers to the Trash.`
        : "Moves the app to the Trash.";
    footer.append(uninstallBtn, hint);

    panel.append(header, content, footer);
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

    panel.hidden = false;
    panel.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "ap-detail-state";
    loading.append(spinner());
    const p = document.createElement("p");
    p.textContent = `Scanning ${app.name}…`;
    loading.appendChild(p);
    panel.appendChild(loading);

    // Allow the element to paint before triggering the slide-in transition.
    requestAnimationFrame(() => {
      scrim.classList.add("is-open");
      panel.classList.add("is-open");
    });

    try {
      const fp = await api.footprint(app.id || app.path);
      if (token !== footprintToken) return; // superseded or closed
      renderFootprint(app, fp);
    } catch (err) {
      if (token !== footprintToken) return;
      panel.innerHTML = "";
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
      panel.append(header, content);
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
    screen.append(scrim, panel);

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
