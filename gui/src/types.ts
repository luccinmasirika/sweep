// TS mirror of the serde structs returned by sweep::gui_api. Field names match
// the JSON exactly (Rust serializes PathBuf as a plain string).

export type CleanAction =
  | { kind: "remove_path" }
  | { kind: "empty_dir" }
  | { kind: "command"; command: string[] };

export interface Finding {
  path: string;
  size: number;
  note?: string;
  action: CleanAction;
  risky: boolean;
  stale: boolean;
}

export interface Report {
  target: string;
  findings: Finding[];
}

export interface AppInfo {
  path: string;
  id: string;
  name: string;
  icon: string | null;
}

export interface FootprintItem {
  path: string;
  size: number;
}

export interface Footprint {
  name: string;
  id: string;
  items: FootprintItem[];
}

export interface DupeSet {
  size: number;
  reclaimable: number;
  paths: string[];
}

export interface ExploreChild {
  path: string;
  size: number;
  is_dir: boolean;
}

export interface ExploreNode {
  path: string;
  size: number;
  children: ExploreChild[];
}

export interface LibraryDir {
  path: string;
  size: number;
}

export interface Diagnosis {
  free_space?: number;
  local_snapshots: string[];
  library_dirs: LibraryDir[];
}

export interface CleanResult {
  freed: number;
  trashed: number;
  failures: number;
}

export interface ActionResult {
  failures: number;
}

// Config is a loose object; screens only need to read fields opportunistically.
export type Config = Record<string, unknown>;
