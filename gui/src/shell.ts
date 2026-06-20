// The application shell: a glassy sidebar with the Sweep logo and glossy icons,
// a draggable titlebar, and a content host the router paints into. The shell
// carries data-theme for the active route so the whole frame (sidebar active
// state + the full-bleed world gradient behind the content) recolours per
// screen. Selecting a sidebar item navigates and cross-fades the world.

import type { Api } from "./api";
import { routes, navigate, DEFAULT_ROUTE, resolveRoute } from "./router";
import { icon } from "./components";

export interface Shell {
  host: HTMLElement;
  select(id: string): void;
}

export function mountShell(mount: HTMLElement, api: Api): Shell {
  mount.replaceChildren();

  const layout = document.createElement("div");
  layout.className = "shell";
  layout.dataset.theme = DEFAULT_ROUTE;

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";

  // Empty top spacer: no app logo (Apple Music style). It only reserves room
  // for the macOS traffic lights and stays a window drag region.
  const brand = document.createElement("div");
  brand.className = "sidebar-brand";
  brand.setAttribute("data-tauri-drag-region", "");
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

  // The full-bleed world gradient. It reads --world-grad from the themed shell;
  // on navigate we briefly fade it out and back in for a soft cross-fade.
  const worldBg = document.createElement("div");
  worldBg.className = "world-bg";
  worldBg.setAttribute("aria-hidden", "true");

  const titlebar = document.createElement("header");
  titlebar.className = "titlebar";
  titlebar.setAttribute("data-tauri-drag-region", "");

  const host = document.createElement("section");
  host.className = "content-host";

  main.append(titlebar, host);

  // worldBg first so the coloured world spans the WHOLE window (behind the
  // sidebar too); the menu is frosted glass layered over it.
  layout.append(worldBg, sidebar, main);
  mount.appendChild(layout);

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  function setActive(id: string) {
    for (const [routeId, btn] of buttons) {
      const active = routeId === id;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-current", active ? "page" : "false");
    }
  }

  function paintWorld(id: string) {
    if (layout.dataset.theme === id) return;
    if (reduceMotion) {
      layout.dataset.theme = id;
      return;
    }
    // Fade the current world out, swap the theme, then fade the new one in.
    worldBg.classList.add("is-fading");
    window.setTimeout(() => {
      layout.dataset.theme = id;
      worldBg.classList.remove("is-fading");
    }, 160);
  }

  function select(id: string) {
    const target = resolveRoute(id);
    paintWorld(target.id);
    const route = navigate(host, target.id, api);
    setActive(route.id);
    if (location.hash.slice(1) !== route.id) {
      history.replaceState(null, "", `#${route.id}`);
    }
  }

  window.addEventListener("hashchange", () => {
    select(location.hash.slice(1) || DEFAULT_ROUTE);
  });

  const initial = location.hash.slice(1) || DEFAULT_ROUTE;
  layout.dataset.theme = resolveRoute(initial).id;
  select(initial);

  return { host, select };
}
