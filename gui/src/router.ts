// Maps a route id to its screen render function. Screens own their own file and
// each export render<Name>(root, api). The router clears the host and delegates.

import type { Api } from "./api";
import { renderDashboard } from "./screens/dashboard";
import { renderCleanup } from "./screens/cleanup";
import { renderApplications } from "./screens/applications";
import { renderPrivacy } from "./screens/privacy";
import { renderFiles } from "./screens/files";
import { renderSpacelens } from "./screens/spacelens";
import { renderMaintenance } from "./screens/maintenance";
import { renderSchedule } from "./screens/schedule";

export type RenderFn = (root: HTMLElement, api: Api) => void;

export interface Route {
  id: string;
  label: string;
  icon: string;
  render: RenderFn;
}

export const routes: Route[] = [
  { id: "dashboard", label: "Smart Scan", icon: "dashboard", render: renderDashboard },
  { id: "cleanup", label: "Cleanup", icon: "cleanup", render: renderCleanup },
  { id: "applications", label: "Applications", icon: "applications", render: renderApplications },
  { id: "privacy", label: "Privacy", icon: "privacy", render: renderPrivacy },
  { id: "files", label: "Files", icon: "files", render: renderFiles },
  { id: "spacelens", label: "Space Lens", icon: "spacelens", render: renderSpacelens },
  { id: "maintenance", label: "Maintenance", icon: "maintenance", render: renderMaintenance },
  { id: "schedule", label: "Schedule", icon: "schedule", render: renderSchedule },
];

const DEFAULT_ROUTE = "dashboard";

export function resolveRoute(id: string | null | undefined): Route {
  return routes.find((r) => r.id === id) ?? routes[0];
}

export function navigate(host: HTMLElement, id: string, api: Api): Route {
  const route = resolveRoute(id);
  host.replaceChildren();
  route.render(host, api);
  return route;
}

export { DEFAULT_ROUTE };
