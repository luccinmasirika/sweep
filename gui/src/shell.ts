// The application shell: a draggable titlebar, a sidebar listing every screen,
// and a content host the router paints into. Selecting a sidebar item navigates.

import type { Api } from "./api";
import { routes, navigate, DEFAULT_ROUTE, resolveRoute } from "./router";

export interface Shell {
  host: HTMLElement;
  select(id: string): void;
}

export function mountShell(mount: HTMLElement, api: Api): Shell {
  mount.replaceChildren();

  const layout = document.createElement("div");
  layout.className = "shell";

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";

  const brand = document.createElement("div");
  brand.className = "sidebar-brand";
  brand.setAttribute("data-tauri-drag-region", "");
  brand.innerHTML = `<span class="brand-mark">Sweep</span>`;
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
    btn.textContent = route.label;
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
