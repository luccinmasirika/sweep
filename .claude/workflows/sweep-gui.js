export const meta = {
  name: 'sweep-gui',
  description: 'Autonomously build a CleanMyMac-caliber Tauri macOS GUI for sweep: lib refactor, scaffold, generated SVG/icon assets, all module screens, then a build-repair loop',
  phases: [
    { title: 'Foundation', detail: 'sweep→lib + gui_api, then Tauri/Vite scaffold (verified)' },
    { title: 'Build-out', detail: 'design system, generated icons/illustrations, backend commands, 8 screens — in parallel' },
    { title: 'Integrate', detail: 'wire, build, repair loop until green, final report' },
  ],
}

// ---------------------------------------------------------------------------
// Shared contract every agent must honour so parallel work integrates cleanly.
// ---------------------------------------------------------------------------
const CONTRACT = [
  'PROJECT: a native macOS GUI for the existing Rust CLI "sweep" (a safe disk cleaner).',
  'Goal: match the visual/UX caliber of CleanMyMac (dark, polished, animated, premium) — desktop only.',
  '',
  'STACK (do not deviate):',
  '- App lives in gui/ at the repo root. Tauri v2 + Vite + TypeScript (vanilla TS, NO React/Vue/Svelte).',
  '- Backend: gui/src-tauri depends on the sweep crate by path ( sweep = { path = "../.." } ).',
  '  All real work goes through the sweep crate module gui_api (created in Foundation).',
  '  Tauri commands are THIN wrappers over sweep::gui_api::* and return its serde structs.',
  '- Frontend: plain DOM + template strings + CSS. SVG icons rendered inline (no icon font).',
  '',
  'REPO LAYOUT (own only YOUR files; never edit files owned by another agent):',
  '  gui/index.html, gui/package.json, gui/vite.config.ts, gui/tsconfig.json        [Foundation]',
  '  gui/src/main.ts          app bootstrap, mounts shell, starts router            [Foundation]',
  '  gui/src/router.ts        route -> screen render fn (imports all screens)        [Foundation]',
  '  gui/src/api.ts           typed wrappers around Tauri invoke() (one per command) [Foundation]',
  '  gui/src/types.ts         TS types mirroring backend JSON                        [Foundation]',
  '  gui/src/shell.ts         sidebar + titlebar + content host                      [Foundation]',
  '  gui/src/styles/tokens.css  CSS custom properties (names fixed below)            [design-system agent]',
  '  gui/src/styles/global.css  base + components styling                            [design-system agent]',
  '  gui/src/components/*.ts    reusable UI: card, button, list, sizebar, ring, toast, spinner [components agent]',
  '  gui/src/assets/icons/*.svg module + action icons                               [module-icons agent]',
  '  gui/src/assets/logo.svg, gui/src/assets/illustrations/*.svg                    [module-icons agent]',
  '  gui/src/screens/<name>.ts  one file per screen, exports render<Name>(root,api)  [one screen agent each]',
  '  gui/src-tauri/Cargo.toml, tauri.conf.json, build.rs, src/main.rs               [Foundation]',
  '  gui/src-tauri/src/commands.rs  ALL #[tauri::command] thin wrappers             [backend agent]',
  '  gui/src-tauri/icons/*          generated app icon set                          [app-icon agent]',
  '',
  'BACKEND API (sweep::gui_api, created in Foundation; commands wrap these 1:1):',
  '  scan(only: Vec<String>) -> Vec<Report>            // empty vec = all targets',
  '  clean(paths: Vec<String>, purge: bool) -> CleanResult   // re-scan, match paths, apply',
  '  smart_clean(purge: bool) -> CleanResult',
  '  apps() -> Vec<AppInfo>                             // {path,id,name}',
  '  footprint(query: String) -> Footprint             // {name,id,items:[{path,size}]}',
  '  uninstall(query: String, purge: bool) -> CleanResult',
  '  privacy() -> Vec<Finding>',
  '  dupes(path: String) -> Vec<DupeSet>               // {size,reclaimable,paths}',
  '  explore(path: String) -> ExploreNode              // {path,size,children:[{path,size,is_dir}]}',
  '  diagnose() -> Diagnosis',
  '  doctor_fix() -> ActionResult                      // {failures}',
  '  maintenance(tasks: Vec<String>) -> ActionResult',
  '  schedule(action: String, interval: String) -> ActionResult  // action in install|remove|status',
  '  get_config() -> Config',
  'Tauri command names = the API names above (snake_case). api.ts exposes camelCase wrappers of the same names.',
  '',
  'TYPES (types.ts mirrors serde output of sweep):',
  '  Finding { path:string; size:number; note?:string; risky:boolean; stale:boolean; action:any }',
  '  Report { target:string; findings:Finding[] }',
  '  AppInfo { path:string; id:string; name:string }',
  '  Footprint { name:string; id:string; items:{path:string;size:number}[] }',
  '  DupeSet { size:number; reclaimable:number; paths:string[] }',
  '  ExploreNode { path:string; size:number; children:{path:string;size:number;is_dir:boolean}[] }',
  '  Diagnosis { free_space?:number; local_snapshots:string[]; library_dirs:{path:string;size:number}[] }',
  '  CleanResult { freed:number; trashed:number; failures:number }',
  '  ActionResult { failures:number }',
  '  Config (loose object; only needs JSON.parse)',
  '',
  'DESIGN TOKENS (tokens.css must define exactly these CSS custom properties; screens/components reference them):',
  '  --bg, --bg-elev, --surface, --surface-2, --border, --text, --text-dim, --text-faint,',
  '  --accent, --accent-2 (gradient pair), --ok, --warn, --danger, --personal,',
  '  --radius, --radius-lg, --gap, --shadow, --shadow-lg, --font, --mono.',
  '  Theme: deep near-black background, glassy elevated cards, a vivid accent gradient, generous spacing,',
  '  SF-style system font stack, smooth 150-250ms transitions. It must look premium, not like a default web page.',
  '',
  'SCREENS (sidebar order) and their data:',
  '  dashboard/smart  -> scan() summary + a big animated progress RING + one-click "Smart Scan" then "Clean" (smart_clean)',
  '  cleanup          -> scan(["system-caches","app-caches","dev-tools","xcode"]); grouped checkable lists; Clean selected via clean()',
  '  applications     -> apps() grid; selecting one shows footprint(); Uninstall via uninstall()',
  '  privacy          -> privacy(); browser/cookies/history/mail; risky items start unchecked; Clean via clean()',
  '  files            -> projects + large-items from scan(["projects","large-items"]) AND dupes() on a chosen folder; clean()',
  '  spacelens        -> explore() drill-down with a RADIAL/sunburst-style size visualization; trash via clean([path])',
  '  maintenance      -> checkboxes of tasks -> maintenance(tasks); show login items info',
  '  schedule         -> install/remove/status via schedule(); interval picker',
  'Every screen: export function render<Name>(root: HTMLElement, api: Api): void  (Api = the object from api.ts).',
  'Screens must handle loading (spinner) and empty states, format bytes human-readably, and never block the UI.',
  '',
  'QUALITY BAR: production-quality, no TODOs, no placeholder lorem. Real wiring to the api. Accessible, keyboard-friendly.',
  'Bytes formatting helper lives in components (formatBytes). Reuse it. Keep each file self-contained to its ownership.',
].join('\n')

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true only if BOTH the frontend (vite build) and src-tauri (cargo build) compiled with no errors' },
    errors: { type: 'string', description: 'concise but complete compiler/build error output (empty if ok)' },
    notes: { type: 'string', description: 'what was built/what runs' },
  },
  required: ['ok', 'errors', 'notes'],
}

// =========================== FOUNDATION (sequential) =======================
phase('Foundation')

await agent([
  'You are refactoring the existing Rust crate "sweep" (a macOS disk-cleanup CLI) at the repo root into a library+binary, and adding a GUI-facing API module. This MUST keep the existing CLI building and all tests passing.',
  '',
  'Tasks:',
  '1. Add src/lib.rs that declares and `pub`-exposes all existing modules (apps, catalog, cli, config, dupes, exec, explore, fsutil, maintenance, report, schedule, smart, targets, ui, uninstall). Adjust src/main.rs to use the library crate (e.g. `use sweep::...`) instead of `mod` declarations, OR keep main.rs thin. Update Cargo.toml so the crate produces BOTH a lib named "sweep" and the existing bin "sweep" ([lib] name="sweep" path="src/lib.rs"; keep [[bin]]). Resolve the resulting visibility/borrow issues.',
  '2. Create a new module src/gui_api.rs (pub mod gui_api in lib.rs) that is the single programmatic, serde-serializable API the GUI will call. Implement these pub functions, reusing existing internals (collect/scan, report::apply, fsutil, apps, dupes, explore, schedule, maintenance, fsutil::diagnose, etc.). Add small pub #[derive(Serialize)] structs where existing ones are private (AppInfo{path,id,name}, Footprint{name,id,items:Vec<Item{path,size}>}, DupeSet{size,reclaimable,paths}, ExploreNode{path,size,children:Vec<Child{path,size,is_dir}>}, CleanResult{freed,trashed,failures}, ActionResult{failures}). Functions:',
  '   scan(only:Vec<String>)->Vec<report::Report>; clean(paths:Vec<String>,purge:bool)->CleanResult (re-scan all enabled targets, select findings whose path string is in `paths`, apply each via report::apply, tally freed/trashed/failures like cli::apply_findings); smart_clean(purge)->CleanResult; apps()->Vec<AppInfo>; footprint(query:String)->Footprint; uninstall(query,purge)->CleanResult; privacy()->Vec<Finding>; dupes(path:String)->Vec<DupeSet>; explore(path:String)->ExploreNode; diagnose()->Diagnosis; doctor_fix()->ActionResult (delete snapshots + empty all trashes, non-interactive); maintenance(tasks:Vec<String>)->ActionResult; schedule(action:String,interval:String)->ActionResult; get_config()->config::Config.',
  '   Make whatever internal fns/fields pub or pub(crate) as needed (e.g. expose dupes::find_duplicates, explore children sizing, uninstall::footprint, maintenance tasks-by-name, schedule by string) but keep the CLI behavior identical.',
  '   Load Config via config::Config::load(None) inside gui_api where a Config is needed, unless one is passed.',
  '3. Run `cargo build` and `cargo test --all` and `cargo clippy --all-targets -- -D warnings` and `cargo fmt --all`. Everything must pass. Fix all issues.',
  '',
  'Constraints: keep the move-to-Trash-by-default + protected-toolchains + staleness safety intact. Do NOT touch the gui/ directory. Human-written style, no AI-tell comments.',
  'Report exactly which pub items gui_api exposes and confirm build+test+clippy are green.',
  '', CONTRACT,
].join('\n'), { label: 'lib+gui_api', phase: 'Foundation' })

await agent([
  'Scaffold the Tauri v2 + Vite + TypeScript app in gui/ at the repo root, building on the sweep library crate that now exists one level up. The sweep crate exposes module sweep::gui_api with the API listed in the CONTRACT.',
  '',
  'Do this:',
  '1. Create a Tauri v2 vanilla-ts app under gui/. Prefer `npm create tauri-app@latest` with non-interactive flags (template vanilla-ts, npm); if that is not reliably non-interactive, hand-write a correct Tauri v2 skeleton instead (package.json with @tauri-apps/cli + @tauri-apps/api + vite + typescript; vite.config.ts; tsconfig.json; index.html; src-tauri/{Cargo.toml,tauri.conf.json,build.rs,src/main.rs}). Tauri v2 only.',
  '2. src-tauri/Cargo.toml: add dependency `sweep = { path = "../.." }` and serde/serde_json as needed. tauri.conf.json: productName "Sweep", a unique identifier (io.sweep.app), reasonable window (1100x720, dark, hidden-title/overlay titlebar style if simple), and point build to the vite dev/build commands.',
  '3. Create the OWNED-BY-FOUNDATION files from the CONTRACT so the project compiles EMPTY end-to-end: types.ts (all types), api.ts (camelCase invoke wrappers for every command), router.ts, shell.ts (sidebar with the screen list + a content host), main.ts (bootstrap), and STUB screen files gui/src/screens/<name>.ts for every screen each exporting a real `render<Name>(root,api)` that renders a simple "coming soon" placeholder (so the build is green before other agents fill them in). Also create empty-but-valid gui/src/styles/tokens.css (define every required token with provisional values) and global.css, and a components/index.ts barrel with stub exports (formatBytes, etc.) so imports resolve.',
  '4. src-tauri/src/commands.rs: thin #[tauri::command] wrappers calling sweep::gui_api::* (real, not stubbed — gui_api exists). Register ALL of them in src/main.rs invoke_handler.',
  '5. Verify: in gui/, `npm install`; then `npm run build` (vite/tsc) must succeed; and `cd gui/src-tauri && cargo build` must succeed. Fix everything until BOTH are green. Do NOT run a full `tauri build` yet.',
  '',
  'Report the exact file tree you created, the final command/api names, the screen render-fn names, and confirm both builds are green.',
  '', CONTRACT,
].join('\n'), { label: 'tauri-scaffold', phase: 'Foundation' })

// =========================== BUILD-OUT (parallel) ==========================
phase('Build-out')

const SCREENS = [
  ['dashboard', 'renderDashboard', 'Smart Care dashboard: a hero with a big animated circular progress RING, a "Smart Scan" button that calls scan() and animates the ring while tallying reclaimable bytes across all reports, a headline total, per-category chips, and a primary "Clean safely" button that calls smartClean(false) then shows a freed/trashed result. Premium, lots of motion.'],
  ['cleanup', 'renderCleanup', 'Cleanup: call scan(["system-caches","app-caches","dev-tools","xcode"]). Show each report as a collapsible card with a checkable list of findings (size, pretty path, note). A master total + "Clean selected" calling clean(selectedPaths,false). Risky items unchecked by default.'],
  ['applications', 'renderApplications', 'Applications/Uninstaller: apps() as a searchable grid of app cards (name + icon glyph). Clicking one slides in a detail panel calling footprint(query); list every footprint item with sizes and a total; an "Uninstall" button calls uninstall(query,false) with a confirm.'],
  ['privacy', 'renderPrivacy', 'Privacy: privacy() findings grouped (browser caches / cookies & history / mail). risky=true items start unchecked and are visually marked personal. "Clean selected" -> clean(selectedPaths,false).'],
  ['files', 'renderFiles', 'Large & Old + Duplicates: scan(["projects","large-items"]) shown as sortable lists; plus a "Find duplicates" folder picker (use a text input + a Browse button via the dialog plugin if available, else a path input) calling dupes(path) and rendering duplicate sets with keep-one/trash-rest. Cleans via clean().'],
  ['spacelens', 'renderSpaceLens', 'Space Lens: explore(path) starting at home. Render a RADIAL/sunburst-like visualization (SVG arcs sized by bytes) of the children, click an arc to drill in, breadcrumb to go up, and a trash action that calls clean([path]). This is a signature visual — make it beautiful and smooth.'],
  ['maintenance', 'renderMaintenance', 'Maintenance: a checklist of tasks (Flush DNS, Rebuild Spotlight, Reset Launch Services, Run periodic scripts) -> maintenance(selectedTaskKeys). Show a note that some need sudo, and display login items if returned.'],
  ['schedule', 'renderSchedule', 'Schedule: show schedule("status","") state; an interval segmented control (daily/weekly/monthly); Install -> schedule("install",interval); Remove -> schedule("remove",""). Friendly explanation that it runs Smart clean automatically.'],
]

const fanout = [
  () => agent([
    'Own gui/src/styles/tokens.css and gui/src/styles/global.css. Build a premium, CleanMyMac-grade DARK design system as pure CSS.',
    'tokens.css: define EVERY token listed in the CONTRACT with refined values (deep near-black bg, layered glassy surfaces, a vivid accent gradient e.g. violet->cyan or your tasteful choice, semantic ok/warn/danger/personal colors, soft large shadows, system font stack, mono stack, radii, spacing).',
    'global.css: reset; base typography; scrollbars; and styling for the shared component classes the components agent will use (.card, .btn, .btn-primary, .list, .row, .sizebar, .ring, .chip, .toast, .spinner, .sidebar, .nav-item, .titlebar, .content). Smooth transitions, hover/focus states, selection styles. It must feel like a polished native app, not a webpage.',
    'Do not edit other files. Keep class names generic so screens/components can rely on them.',
    '', CONTRACT,
  ].join('\n'), { label: 'design-system', phase: 'Build-out' }),

  () => agent([
    'Own gui/src/assets/icons/*.svg, gui/src/assets/logo.svg, gui/src/assets/illustrations/*.svg, AND the app bundle icon set in gui/src-tauri/icons/.',
    'Generate, as hand-authored SVG (text — you are the designer), a cohesive icon set: a memorable "Sweep" app logo, and one line/duotone icon per sidebar entry (dashboard/smart, cleanup, applications, privacy, files, spacelens, maintenance, schedule) plus action glyphs (trash, broom, scan, check, chevron, search, folder, refresh). Consistent 24px grid, currentColor strokes so CSS can theme them. Also 1-2 tasteful empty-state illustrations.',
    'App icon: author a 1024x1024 SVG app icon (rounded-rect macOS style, using the accent gradient). Then rasterize and generate the macOS icon set: install sharp locally (npm i -D sharp inside gui) and use a small node script to render the SVG to a 1024 PNG; then use `sips`/`iconutil` (available) OR the tauri cli `tauri icon` to produce gui/src-tauri/icons/ (icon.icns, icon.png, and the *.png sizes Tauri expects). If tauri cli is missing, install it (npm i -D @tauri-apps/cli) and run `npx tauri icon <png>`. Verify the icon files exist and tauri.conf.json references them (coordinate by using the default icon paths Tauri expects).',
    'Do not edit screens/styles/backend. Report the asset filenames produced.',
    '', CONTRACT,
  ].join('\n'), { label: 'icons+app-icon', phase: 'Build-out' }),

  () => agent([
    'Own gui/src/components/*.ts (and a components/index.ts barrel). Implement reusable, dependency-free TS UI helpers used by every screen, styled via the global.css classes:',
    'formatBytes(n):string (1 decimal, kB/MB/GB), el(tag,props,children) tiny hyperscript helper, card(), button(), primaryButton(), checkList(items,{onChange}), sizeBar(fraction), progressRing(percent) (animated SVG), toast(msg), spinner(), and a simple icon(name) loader that inlines the SVGs from assets/icons. Keep APIs small and documented with short comments. Export all via index.ts.',
    'These must be production-quality and used by the screen agents; keep names stable: formatBytes, el, card, button, primaryButton, checkList, sizeBar, progressRing, toast, spinner, icon.',
    'Do not edit other files.',
    '', CONTRACT,
  ].join('\n'), { label: 'components', phase: 'Build-out' }),

  () => agent([
    'Own gui/src-tauri/src/commands.rs ONLY. Make every Tauri command a correct, thin wrapper over sweep::gui_api::* per the CONTRACT, with proper error handling (map errors to String results that the frontend can show). Ensure the names match what main.rs registers and what api.ts calls. Then run `cd gui/src-tauri && cargo build` and fix any errors in THIS file. If main.rs (Foundation-owned) registration is out of sync, do not edit it — instead report the exact mismatch precisely so Integrate can fix it, but make your command fns match the CONTRACT names.',
    '', CONTRACT,
  ].join('\n'), { label: 'backend-commands', phase: 'Build-out' }),

  ...SCREENS.map(([file, fn, brief]) => () => agent([
    'Own gui/src/screens/' + file + '.ts ONLY. Replace the placeholder with a complete, production-quality screen.',
    'Export: function ' + fn + '(root: HTMLElement, api: Api): void  (import Api/types from ../api and ../types; import UI helpers from ../components; import icons as needed).',
    'Screen spec: ' + brief,
    'Requirements: real calls to the api; loading spinner while awaiting; graceful empty/error states; human-readable sizes via formatBytes; confirm before destructive actions; smooth, premium interactions consistent with the design tokens. No TODOs, no mock data.',
    'Only edit your screen file. Assume the CONTRACT names for api methods and component helpers are stable.',
    '', CONTRACT,
  ].join('\n'), { label: 'ui:' + file, phase: 'Build-out' })),
]

await parallel(fanout)

// =========================== INTEGRATE (build-repair loop) =================
phase('Integrate')

let green = false
let lastErrors = ''
for (let i = 0; i < 6 && !green; i++) {
  const res = await agent([
    'Integration build for the Sweep GUI. From the repo root:',
    '1. cd gui && npm install (if needed) && npm run build   (vite + tsc; the WHOLE frontend, all screens/components/styles must type-check and bundle)',
    '2. cd gui/src-tauri && cargo build                       (all Tauri commands)',
    'Capture every error. Also fix trivial wiring you are certain about (mismatched imports/exports, command registration in main.rs, router screen imports, missing barrel exports) — main.rs and router.ts wiring are fair game here. Re-run until you either reach green or have exhausted obvious fixes.',
    'Return ok=true ONLY if both builds succeed with zero errors. Put the full remaining error text in errors.',
    'Previous round errors (may be stale):\n' + (lastErrors || '(none yet)'),
    '', CONTRACT,
  ].join('\n'), { label: 'build#' + (i + 1), phase: 'Integrate', schema: BUILD_SCHEMA })

  if (res && res.ok) { green = true; log('Build is GREEN after round ' + (i + 1)); break }
  lastErrors = res ? res.errors : 'unknown build failure'
  log('Build round ' + (i + 1) + ' failed; dispatching repair')

  // Fan out up to 3 repair agents on independent error clusters.
  await parallel([0, 1, 2].map((k) => () => agent([
    'Repair the Sweep GUI build (worker ' + (k + 1) + ' of 3). Here is the current build error output:',
    '----', lastErrors, '----',
    'Pick a DISTINCT cluster of these errors (worker 1: Rust/src-tauri & commands; worker 2: TypeScript types/api/router/screens; worker 3: CSS/components/assets & config). Fix real issues in the relevant files. Do not rewrite unrelated files. Prefer minimal, correct fixes that respect the CONTRACT. After fixing, try the relevant build (cargo build for rust, npm run build for front) to confirm your cluster improves.',
    '', CONTRACT,
  ].join('\n'), { label: 'repair#' + (i + 1) + '.' + (k + 1), phase: 'Integrate' })))
}

// Best-effort: attempt a full bundle, then report. Never fail the workflow on this.
const report = await agent([
  'Final verification + report for the Sweep GUI.',
  '1. Confirm `cd gui && npm run build` and `cd gui/src-tauri && cargo build` are both green (run them).',
  '2. Best-effort: install the Tauri CLI if missing (npm i -D @tauri-apps/cli) and attempt `npx tauri build` (or `npx tauri build --debug`) to produce a .app bundle. This may fail on signing/bundling — that is acceptable; just report the outcome and whether a .app was produced under gui/src-tauri/target.',
  '3. Do NOT run the app interactively. Do NOT commit anything.',
  'Produce a crisp status report: what builds, what runs, the screen/asset inventory, the app-icon status, any remaining known issues, and the exact commands a developer runs to launch it (npm run tauri dev / tauri build). Be honest about gaps.',
  green ? 'Builds were already green during integration.' : 'Builds were NOT yet green after the repair loop — diagnose what remains.',
  '', CONTRACT,
].join('\n'), { label: 'final-report', phase: 'Integrate' })

return { green, report }
