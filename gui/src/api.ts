// camelCase wrappers around the Tauri commands. Each maps 1:1 to a
// #[tauri::command] which itself wraps a sweep::gui_api::* function.

import { invoke } from "@tauri-apps/api/core";
import type {
  ActionResult,
  AppInfo,
  CleanResult,
  Config,
  Diagnosis,
  DupeSet,
  ExploreNode,
  Finding,
  Footprint,
  Report,
} from "./types";

export interface Api {
  scan(only?: string[]): Promise<Report[]>;
  clean(paths: string[], purge?: boolean): Promise<CleanResult>;
  smartClean(purge?: boolean): Promise<CleanResult>;
  apps(): Promise<AppInfo[]>;
  footprint(query: string): Promise<Footprint>;
  uninstall(query: string, purge?: boolean): Promise<CleanResult>;
  privacy(): Promise<Finding[]>;
  dupes(path: string): Promise<DupeSet[]>;
  explore(path: string): Promise<ExploreNode>;
  diagnose(): Promise<Diagnosis>;
  doctorFix(): Promise<ActionResult>;
  maintenance(tasks: string[]): Promise<ActionResult>;
  schedule(action: string, interval: string): Promise<ActionResult>;
  getConfig(): Promise<Config>;
}

export const api: Api = {
  scan: (only = []) => invoke<Report[]>("scan", { only }),
  clean: (paths, purge = false) => invoke<CleanResult>("clean", { paths, purge }),
  smartClean: (purge = false) => invoke<CleanResult>("smart_clean", { purge }),
  apps: () => invoke<AppInfo[]>("apps"),
  footprint: (query) => invoke<Footprint>("footprint", { query }),
  uninstall: (query, purge = false) =>
    invoke<CleanResult>("uninstall", { query, purge }),
  privacy: () => invoke<Finding[]>("privacy"),
  dupes: (path) => invoke<DupeSet[]>("dupes", { path }),
  explore: (path) => invoke<ExploreNode>("explore", { path }),
  diagnose: () => invoke<Diagnosis>("diagnose"),
  doctorFix: () => invoke<ActionResult>("doctor_fix"),
  maintenance: (tasks) => invoke<ActionResult>("maintenance", { tasks }),
  schedule: (action, interval) =>
    invoke<ActionResult>("schedule", { action, interval }),
  getConfig: () => invoke<Config>("get_config"),
};
