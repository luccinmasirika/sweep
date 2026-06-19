// The application shell: a draggable titlebar, a sidebar listing every screen,
// and a content host the router paints into. Selecting a sidebar item navigates.

import type { Api } from "./api";
import { routes, navigate, DEFAULT_ROUTE, resolveRoute } from "./router";
import { icon } from "./components";
import logoMark from "./assets/logo.svg?raw";

export interface Shell {
  host: HTMLElement;
  select(id: string): void;
}

function injectShellStyles(): void {
  if (document.getElementById("shell-icon-styles")) return;
  const style = document.createElement("style");
  style.id = "shell-icon-styles";
  style.textContent = `
    .sidebar-brand { display: flex; align-items: center; gap: 10px; }
    .brand-logo { width: 26px; height: 26px; display: inline-flex; }
    .brand-logo svg { width: 100%; height: 100%; display: block; }
    .nav-item { display: flex; align-items: center; gap: 11px; }
    .nav-icon { flex: 0 0 auto; display: inline-flex; color: var(--text-dim); transition: color 160ms ease; }
    .nav-icon svg { display: block; }
    .nav-item:hover .nav-icon { color: var(--text); }
    .nav-item.is-active .nav-icon { color: var(--accent-2); }
    .nav-label { flex: 1 1 auto; text-align: left; }
  `;
  document.head.appendChild(style);
}

export function mountShell(mount: HTMLElement, api: Api): Shell {
  injectShellStyles();
  mount.replaceChildren();

  const layout = document.createElement("div");
  layout.className = "shell";

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";

  const brand = document.createElement("div");
  brand.className = "sidebar-brand";
  brand.setAttribute("data-tauri-drag-region", "");
  brand.innerHTML = `<span class="brand-logo" aria-hidden="true">${logoMark}</span><span class="brand-mark">Sweep</span>`;
  sidebar.appendChild(brand);

  const nav = document.createElement("nav");
  nav.className = "sidebar-nav";
  nav.setAttribute("aria-label", "Sections");

  const buttons = new Map<string, HTMLButtonElement>();
  for (const route of routes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-item";
    btn.dataset.route = route.id;
    const ic = icon(route.icon, { size: 18, className: "nav-icon" });
    const label = document.createElement("span");
    label.className = "nav-label";
    label.textContent = route.label;
    btn.append(ic, label);
    btn.addEventListener("click", () => select(route.id));
    buttons.set(route.id, btn);
    nav.appendChild(btn);
  }
  sidebar.appendChild(nav);

  const main = document.createElement("main");
  main.className = "content";

  const titlebar = document.createElement("header");
  titlebar.className = "titlebar";
  titlebar.setAttribute("data-tauri-drag-region", "");

  const host = document.createElement("section");
  host.className = "content-host";

  main.appendChild(titlebar);
  main.appendChild(host);

  layout.appendChild(sidebar);
  layout.appendChild(main);
  mount.appendChild(layout);

  function setActive(id: string) {
    for (const [routeId, btn] of buttons) {
      const active = routeId === id;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-current", active ? "page" : "false");
    }
    const route = resolveRoute(id);
    titlebar.textContent = route.label;
  }

  function select(id: string) {
    const route = navigate(host, id, api);
    setActive(route.id);
    if (location.hash.slice(1) !== route.id) {
      history.replaceState(null, "", `#${route.id}`);
    }
  }

  window.addEventListener("hashchange", () => {
    select(location.hash.slice(1) || DEFAULT_ROUTE);
  });

  select(location.hash.slice(1) || DEFAULT_ROUTE);

  return { host, select };
}
