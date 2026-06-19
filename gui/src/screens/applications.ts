// Applications / Uninstaller screen.
//
// Lists installed apps as a searchable grid of cards. Selecting a card slides
// in a detail panel that resolves the app's full footprint (caches, supports,
// preferences, ...), totals it, and offers a confirmed Uninstall that removes
// the app and every leftover via the sweep crate.

import type { Api } from "../api";
import type { AppInfo, Footprint } from "../types";
import { button, formatBytes, spinner, toast } from "../components";

const STYLE_ID = "applications-screen-styles";

const STYLES = `
.screen-applications {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: var(--gap);
}
.screen-applications .apps-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--gap);
}
.screen-applications .apps-head h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.screen-applications .apps-head .apps-sub {
  margin: 4px 0 0;
  color: var(--text-dim);
  font-size: 13px;
}
.screen-applications .apps-search {
  position: relative;
  width: 280px;
  max-width: 40vw;
}
.screen-applications .apps-search svg {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: var(--text-faint);
  pointer-events: none;
}
.screen-applications .apps-search input {
  width: 100%;
  height: 38px;
  padding: 0 14px 0 36px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.screen-applications .apps-search input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}
.screen-applications .apps-body {
  position: relative;
  flex: 1;
  min-height: 0;
}
.screen-applications .apps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
  overflow-y: auto;
  max-height: 100%;
  padding: 2px 4px 24px 2px;
  align-content: start;
}
.screen-applications .app-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 18px 14px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  text-align: center;
  transition: transform 0.16s ease, border-color 0.16s ease,
    background 0.16s ease, box-shadow 0.16s ease;
}
.screen-applications .app-card:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: var(--surface-2);
  box-shadow: var(--shadow);
}
.screen-applications .app-card:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}
.screen-applications .app-card.is-active {
  border-color: var(--accent);
  background: var(--surface-2);
}
.screen-applications .app-glyph {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 16px;
  font-size: 22px;
  font-weight: 650;
  color: var(--text);
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: var(--shadow);
}
.screen-applications .app-name {
  font-size: 13px;
  font-weight: 550;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.screen-applications .apps-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  height: 100%;
  color: var(--text-dim);
  text-align: center;
  padding: 40px;
}
.screen-applications .apps-state h3 {
  margin: 0;
  color: var(--text);
  font-size: 16px;
  font-weight: 600;
}
.screen-applications .apps-state p {
  margin: 0;
  max-width: 360px;
  font-size: 13px;
  line-height: 1.5;
}

.screen-applications .detail-scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease;
  z-index: 5;
}
.screen-applications .detail-scrim.is-open {
  opacity: 1;
  pointer-events: auto;
}
.screen-applications .detail-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(440px, 92%);
  background: var(--bg-elev);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  transform: translateX(100%);
  transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 6;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.screen-applications .detail-panel.is-open {
  transform: translateX(0);
}
.screen-applications .detail-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--border);
}
.screen-applications .detail-header .app-glyph {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  font-size: 20px;
  flex: 0 0 auto;
}
.screen-applications .detail-header .detail-heading {
  flex: 1;
  min-width: 0;
}
.screen-applications .detail-header h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.screen-applications .detail-header .detail-id {
  margin: 3px 0 0;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.screen-applications .detail-close {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.screen-applications .detail-close:hover {
  background: var(--surface);
  color: var(--text);
}
.screen-applications .detail-close svg {
  width: 18px;
  height: 18px;
}
.screen-applications .detail-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px;
}
.screen-applications .detail-total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 14px 16px;
  margin-bottom: 16px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
}
.screen-applications .detail-total .total-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
}
.screen-applications .detail-total .total-value {
  font-size: 22px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.screen-applications .footprint-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.screen-applications .footprint-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius);
  transition: background 0.15s ease;
}
.screen-applications .footprint-item:hover {
  background: var(--surface);
}
.screen-applications .footprint-item .fp-path {
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
.screen-applications .footprint-item .fp-size {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--text-dim);
}
.screen-applications .detail-footer {
  padding: 16px 20px 20px;
  border-top: 1px solid var(--border);
}
.screen-applications .detail-footer .btn {
  width: 100%;
}
.screen-applications .detail-footer .footer-hint {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--text-faint);
  text-align: center;
}
.screen-applications .detail-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--text-dim);
  text-align: center;
}
@media (prefers-reduced-motion: reduce) {
  .screen-applications .detail-panel,
  .screen-applications .detail-scrim,
  .screen-applications .app-card { transition: none; }
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const tag = document.createElement("style");
  tag.id = STYLE_ID;
  tag.textContent = STYLES;
  document.head.appendChild(tag);
}

const SEARCH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
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
  el.className = "app-glyph";
  el.setAttribute("aria-hidden", "true");
  el.textContent = initials(app.name);
  return el;
}

function stateBlock(title: string, message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "apps-state";
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

  // Header with title + live search.
  const head = document.createElement("div");
  head.className = "apps-head";
  const headLeft = document.createElement("div");
  headLeft.innerHTML =
    '<h2>Applications</h2><p class="apps-sub">Select an app to inspect its footprint and uninstall it cleanly.</p>';

  const search = document.createElement("div");
  search.className = "apps-search";
  search.innerHTML = SEARCH_ICON;
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search apps";
  input.setAttribute("aria-label", "Search applications");
  input.autocomplete = "off";
  input.spellcheck = false;
  search.appendChild(input);
  head.append(headLeft, search);

  const body = document.createElement("div");
  body.className = "apps-body";
  screen.append(head, body);
  root.appendChild(screen);

  // ---- Detail panel state ------------------------------------------------
  let selected: AppInfo | null = null;
  let footprintToken = 0;

  const scrim = document.createElement("div");
  scrim.className = "detail-scrim";
  const panel = document.createElement("div");
  panel.className = "detail-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Application details");
  panel.hidden = true;

  function closeDetail(): void {
    footprintToken += 1;
    selected = null;
    panel.classList.remove("is-open");
    scrim.classList.remove("is-open");
    document
      .querySelectorAll<HTMLElement>(".screen-applications .app-card.is-active")
      .forEach((c) => c.classList.remove("is-active"));
    window.setTimeout(() => {
      if (!selected) panel.hidden = true;
    }, 280);
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
    header.className = "detail-header";
    header.appendChild(glyph(app));
    const heading = document.createElement("div");
    heading.className = "detail-heading";
    const h3 = document.createElement("h3");
    h3.textContent = fp.name || app.name;
    const idLine = document.createElement("p");
    idLine.className = "detail-id";
    idLine.textContent = fp.id || app.id || app.path;
    heading.append(h3, idLine);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "detail-close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = CLOSE_ICON;
    close.addEventListener("click", closeDetail);
    header.append(heading, close);

    const content = document.createElement("div");
    content.className = "detail-content";

    const items = [...fp.items].sort((a, b) => b.size - a.size);
    const total = items.reduce((sum, it) => sum + it.size, 0);

    const totalRow = document.createElement("div");
    totalRow.className = "detail-total";
    totalRow.innerHTML = `<span class="total-label">Total footprint</span><span class="total-value">${formatBytes(
      total
    )}</span>`;
    content.appendChild(totalRow);

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "detail-state";
      empty.innerHTML =
        '<p>No leftover files were found for this app. Uninstalling will remove the bundle itself.</p>';
      content.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "footprint-list";
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "footprint-item";
        const path = document.createElement("span");
        path.className = "fp-path";
        path.textContent = it.path;
        path.title = it.path;
        const size = document.createElement("span");
        size.className = "fp-size";
        size.textContent = formatBytes(it.size);
        row.append(path, size);
        list.appendChild(row);
      }
      content.appendChild(list);
    }

    const footer = document.createElement("div");
    footer.className = "detail-footer";
    const uninstallBtn = button({
      label: `Uninstall ${fp.name || app.name}`,
      variant: "danger",
      onClick: () => runUninstall(app, fp, uninstallBtn),
    });
    const hint = document.createElement("p");
    hint.className = "footer-hint";
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

    document
      .querySelectorAll<HTMLElement>(".screen-applications .app-card.is-active")
      .forEach((c) => c.classList.remove("is-active"));
    cardEl.classList.add("is-active");

    panel.hidden = false;
    panel.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "detail-state";
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
      header.className = "detail-header";
      header.appendChild(glyph(app));
      const heading = document.createElement("div");
      heading.className = "detail-heading";
      heading.innerHTML = `<h3></h3>`;
      (heading.querySelector("h3") as HTMLElement).textContent = app.name;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "detail-close";
      close.setAttribute("aria-label", "Close");
      close.innerHTML = CLOSE_ICON;
      close.addEventListener("click", closeDetail);
      header.append(heading, close);

      const errState = document.createElement("div");
      errState.className = "detail-content";
      const block = document.createElement("div");
      block.className = "detail-state";
      block.innerHTML = `<h3 style="color:var(--text)">Couldn’t read footprint</h3>`;
      const msg = document.createElement("p");
      msg.textContent = String(err);
      block.appendChild(msg);
      const retry = button({
        label: "Retry",
        variant: "ghost",
        onClick: () => void openDetail(app, cardEl),
      });
      block.appendChild(retry);
      errState.appendChild(block);
      panel.append(header, errState);
    }
  }

  // ---- Grid rendering ----------------------------------------------------
  let allApps: AppInfo[] = [];

  function renderGrid(): void {
    body.innerHTML = "";

    const query = input.value.trim().toLowerCase();
    const filtered = query
      ? allApps.filter(
          (a) =>
            a.name.toLowerCase().includes(query) ||
            a.id.toLowerCase().includes(query)
        )
      : allApps;

    if (allApps.length === 0) {
      body.appendChild(
        stateBlock(
          "No applications found",
          "Sweep didn’t detect any installed applications on this Mac."
        )
      );
    } else if (filtered.length === 0) {
      body.appendChild(
        stateBlock(
          "No matches",
          `No applications match “${input.value.trim()}”. Try a different search.`
        )
      );
    } else {
      const grid = document.createElement("div");
      grid.className = "apps-grid";
      grid.setAttribute("role", "list");
      for (const app of filtered) {
        const cardEl = document.createElement("div");
        cardEl.className = "app-card";
        cardEl.setAttribute("role", "listitem");
        cardEl.tabIndex = 0;
        cardEl.setAttribute("aria-label", `Inspect ${app.name}`);
        cardEl.appendChild(glyph(app));
        const nameEl = document.createElement("div");
        nameEl.className = "app-name";
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
        grid.appendChild(cardEl);
      }
      body.appendChild(grid);
    }

    // Re-attach the detail overlay (innerHTML reset removed it).
    body.append(scrim, panel);
  }

  input.addEventListener("input", () => {
    if (allApps.length > 0) renderGrid();
  });

  // ---- Initial load ------------------------------------------------------
  async function load(): Promise<void> {
    body.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "apps-state";
    loading.append(spinner());
    const p = document.createElement("p");
    p.textContent = "Scanning installed applications…";
    loading.appendChild(p);
    body.appendChild(loading);

    try {
      const apps = await api.apps();
      allApps = [...apps].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
      renderGrid();
    } catch (err) {
      body.innerHTML = "";
      const errState = stateBlock("Couldn’t load applications", String(err));
      errState.appendChild(
        button({ label: "Retry", variant: "ghost", onClick: () => void load() })
      );
      body.appendChild(errState);
    }
  }

  void load();
}
