// Files screen — "Large & Old" + "Duplicates".
//
// Two halves:
//   1. scan(["projects","large-items"]) rendered as sortable, selectable lists.
//   2. A folder picker that runs dupes(path) and renders duplicate sets with
//      a keep-one / trash-rest workflow.
// Everything reclaimable flows through clean(paths). Destructive actions are
// confirmed first. All sizing is human-readable via formatBytes.

import type { Api } from "../api";
import type { DupeSet, Finding, Report } from "../types";
import { button, card, formatBytes, spinner, toast } from "../components";

type SortKey = "size" | "name";

interface ListState {
  findings: Finding[];
  selected: Set<string>;
  sort: SortKey;
  desc: boolean;
}

export function renderFiles(root: HTMLElement, api: Api): void {
  injectStyles();

  const screen = document.createElement("div");
  screen.className = "screen screen-files";

  const header = el("header", "files-head");
  header.innerHTML = `
    <h2 class="files-title">Files</h2>
    <p class="files-sub text-dim">Track down the largest, oldest, and duplicated files eating your disk.</p>`;
  screen.appendChild(header);

  // --- Large & Old section ---------------------------------------------------
  const largeSection = el("section", "files-section");
  screen.appendChild(largeSection);

  // --- Duplicates section ----------------------------------------------------
  const dupesSection = el("section", "files-section");
  screen.appendChild(dupesSection);

  root.appendChild(screen);

  mountLargeAndOld(largeSection, api);
  mountDuplicates(dupesSection, api);
}

/* ------------------------------------------------------------------ */
/* Large & Old                                                         */
/* ------------------------------------------------------------------ */

const TARGET_META: Record<string, { label: string; hint: string }> = {
  projects: { label: "Projects", hint: "Dev project folders and their build artifacts" },
  "large-items": { label: "Large items", hint: "Big files that haven't been touched in a while" },
};

function mountLargeAndOld(host: HTMLElement, api: Api): void {
  const c = card({ className: "files-card" });

  const head = el("div", "card-head");
  head.innerHTML = `
    <div>
      <h3 class="card-title">Large &amp; Old</h3>
      <p class="card-hint text-dim">Projects and oversized files surfaced by a deep scan.</p>
    </div>`;
  const actions = el("div", "card-actions");
  head.appendChild(actions);
  c.appendChild(head);

  const body = el("div", "card-body");
  c.appendChild(body);

  host.appendChild(c);

  const states = new Map<string, ListState>();

  const cleanBtn = button({
    label: "Clean selected",
    variant: "primary",
    onClick: () => void cleanSelected(),
  });
  cleanBtn.disabled = true;

  const rescanBtn = button({
    label: "Rescan",
    variant: "ghost",
    onClick: () => void load(),
  });

  actions.append(rescanBtn, cleanBtn);

  function selectedPaths(): string[] {
    const paths: string[] = [];
    for (const st of states.values()) {
      for (const f of st.findings) if (st.selected.has(f.path)) paths.push(f.path);
    }
    return paths;
  }

  function selectedSize(): number {
    let total = 0;
    for (const st of states.values()) {
      for (const f of st.findings) if (st.selected.has(f.path)) total += f.size;
    }
    return total;
  }

  function refreshCleanBtn(): void {
    const paths = selectedPaths();
    cleanBtn.disabled = paths.length === 0;
    cleanBtn.textContent = paths.length
      ? `Clean ${paths.length} item${paths.length > 1 ? "s" : ""} · ${formatBytes(selectedSize())}`
      : "Clean selected";
  }

  async function cleanSelected(): Promise<void> {
    const paths = selectedPaths();
    if (paths.length === 0) return;
    const ok = await confirmDialog({
      title: "Move to Trash?",
      message: `Move ${paths.length} item${paths.length > 1 ? "s" : ""} (${formatBytes(
        selectedSize()
      )}) to the Trash. You can restore them from there.`,
      confirmLabel: "Move to Trash",
      danger: true,
    });
    if (!ok) return;

    cleanBtn.disabled = true;
    cleanBtn.textContent = "Cleaning…";
    try {
      const res = await api.clean(paths, false);
      toast(
        res.failures
          ? `Freed ${formatBytes(res.freed)} · ${res.failures} could not be removed`
          : `Freed ${formatBytes(res.freed)} across ${res.trashed} item${
              res.trashed > 1 ? "s" : ""
            }`
      );
      await load();
    } catch (err) {
      toast(`Cleanup failed: ${errMsg(err)}`);
      refreshCleanBtn();
    }
  }

  function renderGroups(reports: Report[]): void {
    body.replaceChildren();
    states.clear();

    const nonEmpty = reports.filter((r) => r.findings.length > 0);
    if (nonEmpty.length === 0) {
      body.appendChild(
        emptyState(
          "Nothing oversized",
          "Your projects and large files are all within reason. Nice and tidy."
        )
      );
      refreshCleanBtn();
      return;
    }

    for (const report of nonEmpty) {
      const meta = TARGET_META[report.target] ?? {
        label: report.target,
        hint: "",
      };
      const st: ListState = {
        findings: report.findings.slice(),
        selected: new Set(),
        sort: "size",
        desc: true,
      };
      states.set(report.target, st);
      body.appendChild(renderGroup(meta, st));
    }
    refreshCleanBtn();
  }

  function renderGroup(
    meta: { label: string; hint: string },
    st: ListState
  ): HTMLElement {
    const group = el("div", "files-group");

    const total = st.findings.reduce((a, f) => a + f.size, 0);
    const gh = el("div", "files-group-head");
    gh.innerHTML = `
      <label class="files-group-toggle">
        <input type="checkbox" class="ckbx files-group-all" aria-label="Select all in ${meta.label}" />
        <span class="files-group-name">${escapeHtml(meta.label)}</span>
        <span class="files-group-count text-dim">${st.findings.length} item${
      st.findings.length > 1 ? "s" : ""
    } · ${formatBytes(total)}</span>
      </label>`;

    const sortWrap = el("div", "files-sort");
    sortWrap.append(
      sortChip("Size", "size", st),
      sortChip("Name", "name", st)
    );
    gh.appendChild(sortWrap);
    group.appendChild(gh);

    if (meta.hint) {
      const hint = el("p", "files-group-hint text-dim");
      hint.textContent = meta.hint;
      group.appendChild(hint);
    }

    const list = el("ul", "files-list");
    list.setAttribute("role", "list");
    group.appendChild(list);

    const groupAll = gh.querySelector<HTMLInputElement>(".files-group-all")!;

    const paint = (): void => {
      const sorted = sortFindings(st);
      const maxSize = sorted.reduce((m, f) => Math.max(m, f.size), 0);
      list.replaceChildren();
      for (const f of sorted) list.appendChild(renderRow(f, st, maxSize, sync));
    };

    function sync(): void {
      const all = st.findings.length > 0 && st.selected.size === st.findings.length;
      groupAll.checked = all;
      groupAll.indeterminate = !all && st.selected.size > 0;
      refreshCleanBtn();
    }

    groupAll.addEventListener("change", () => {
      if (groupAll.checked) for (const f of st.findings) st.selected.add(f.path);
      else st.selected.clear();
      paint();
      sync();
    });

    // Repaint hook used by the sort chips.
    (group as HTMLElement & { _repaint?: () => void })._repaint = paint;

    paint();
    sync();
    return group;
  }

  function renderRow(
    f: Finding,
    st: ListState,
    maxSize: number,
    onChange: () => void
  ): HTMLElement {
    const li = el("li", "files-row");
    const id = `lf-${hash(f.path)}`;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "ckbx";
    cb.id = id;
    cb.checked = st.selected.has(f.path);
    cb.addEventListener("change", () => {
      if (cb.checked) st.selected.add(f.path);
      else st.selected.delete(f.path);
      li.classList.toggle("is-selected", cb.checked);
      onChange();
    });
    li.classList.toggle("is-selected", cb.checked);

    const main = el("label", "files-row-main");
    main.setAttribute("for", id);

    const name = el("span", "files-row-name");
    name.textContent = basename(f.path);
    name.title = f.path;

    const sub = el("span", "files-row-path text-dim");
    sub.textContent = dirname(f.path);
    sub.title = f.path;

    const bar = el("div", "files-row-bar");
    const fill = el("div", "files-row-bar-fill");
    fill.style.width = maxSize > 0 ? `${Math.max(3, (f.size / maxSize) * 100)}%` : "0%";
    bar.appendChild(fill);

    main.append(name, sub, bar);

    const meta = el("div", "files-row-meta");
    const size = el("span", "files-row-size");
    size.textContent = formatBytes(f.size);
    meta.appendChild(size);

    const tags = el("div", "files-row-tags");
    if (f.stale) tags.appendChild(tag("Old", "stale"));
    if (f.risky) tags.appendChild(tag("Risky", "risky"));
    if (tags.childElementCount) meta.appendChild(tags);

    li.append(cb, main, meta);
    return li;
  }

  function sortChip(label: string, key: SortKey, st: ListState): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "files-sort-chip";
    const apply = (): void => {
      btn.classList.toggle("is-active", st.sort === key);
      btn.setAttribute(
        "aria-label",
        `Sort by ${label}${st.sort === key ? (st.desc ? ", descending" : ", ascending") : ""}`
      );
      btn.innerHTML = `${label}${
        st.sort === key ? `<span class="files-sort-arrow">${st.desc ? "↓" : "↑"}</span>` : ""
      }`;
    };
    btn.addEventListener("click", () => {
      if (st.sort === key) st.desc = !st.desc;
      else {
        st.sort = key;
        st.desc = key === "size";
      }
      // Repaint this group and refresh every chip's active state.
      const group = btn.closest(".files-group") as
        | (HTMLElement & { _repaint?: () => void })
        | null;
      group?._repaint?.();
      group?.querySelectorAll<HTMLButtonElement>(".files-sort-chip").forEach((c) =>
        c.dispatchEvent(new CustomEvent("sync-chip"))
      );
    });
    btn.addEventListener("sync-chip", apply);
    apply();
    return btn;
  }

  async function load(): Promise<void> {
    body.replaceChildren(loadingBlock("Scanning projects and large files…"));
    cleanBtn.disabled = true;
    rescanBtn.disabled = true;
    try {
      const reports = await api.scan(["projects", "large-items"]);
      renderGroups(reports);
    } catch (err) {
      body.replaceChildren(
        errorState("Scan failed", errMsg(err), () => void load())
      );
    } finally {
      rescanBtn.disabled = false;
    }
  }

  void load();
}

function sortFindings(st: ListState): Finding[] {
  const arr = st.findings.slice();
  arr.sort((a, b) => {
    let cmp: number;
    if (st.sort === "size") cmp = a.size - b.size;
    else cmp = basename(a.path).localeCompare(basename(b.path), undefined, { numeric: true });
    return st.desc ? -cmp : cmp;
  });
  return arr;
}

/* ------------------------------------------------------------------ */
/* Duplicates                                                          */
/* ------------------------------------------------------------------ */

function mountDuplicates(host: HTMLElement, api: Api): void {
  const c = card({ className: "files-card" });

  const head = el("div", "card-head");
  head.innerHTML = `
    <div>
      <h3 class="card-title">Find duplicates</h3>
      <p class="card-hint text-dim">Pick a folder to scan for identical files. Keep one copy, trash the rest.</p>
    </div>`;
  c.appendChild(head);

  const picker = el("div", "dupes-picker");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "dupes-input";
  input.placeholder = "/Users/you/Downloads";
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.setAttribute("aria-label", "Folder to scan for duplicates");

  const browseBtn = button({
    label: "Browse…",
    variant: "ghost",
    onClick: () => void browse(),
  });
  const scanBtn = button({
    label: "Scan",
    variant: "primary",
    onClick: () => void scan(),
  });

  picker.append(input, browseBtn, scanBtn);
  c.appendChild(picker);

  const results = el("div", "dupes-results");
  c.appendChild(results);

  host.appendChild(c);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void scan();
  });

  async function browse(): Promise<void> {
    // Use the Tauri dialog plugin when present; otherwise fall back to the
    // text input (which is always a valid way to provide a path).
    try {
      const specifier = "@tauri-apps/plugin-dialog";
      const mod = await import(/* @vite-ignore */ specifier).catch(() => null);
      const open = (mod as { open?: (o: unknown) => Promise<unknown> } | null)?.open;
      if (typeof open === "function") {
        const picked = await open({ directory: true, multiple: false, title: "Choose a folder" });
        if (typeof picked === "string" && picked) {
          input.value = picked;
          void scan();
        }
        return;
      }
    } catch {
      /* fall through to manual entry */
    }
    input.focus();
    toast("Type a folder path, then press Scan.");
  }

  async function scan(): Promise<void> {
    const path = input.value.trim();
    if (!path) {
      input.focus();
      input.classList.add("is-invalid");
      setTimeout(() => input.classList.remove("is-invalid"), 600);
      toast("Enter a folder path to scan.");
      return;
    }

    scanBtn.disabled = true;
    browseBtn.disabled = true;
    results.replaceChildren(loadingBlock(`Hunting for duplicates in ${shortPath(path)}…`));

    try {
      const sets = await api.dupes(path);
      renderDupes(sets, path);
    } catch (err) {
      results.replaceChildren(
        errorState("Could not scan that folder", errMsg(err), () => void scan())
      );
    } finally {
      scanBtn.disabled = false;
      browseBtn.disabled = false;
    }
  }

  function renderDupes(sets: DupeSet[], scannedPath: string): void {
    results.replaceChildren();

    const usable = sets.filter((s) => s.paths.length > 1);
    if (usable.length === 0) {
      results.appendChild(
        emptyState(
          "No duplicates found",
          `Every file in ${shortPath(scannedPath)} is unique.`
        )
      );
      return;
    }

    const totalReclaim = usable.reduce((a, s) => a + s.reclaimable, 0);

    const summary = el("div", "dupes-summary");
    summary.innerHTML = `
      <span class="dupes-summary-count">${usable.length} duplicate set${
      usable.length > 1 ? "s" : ""
    }</span>
      <span class="dupes-summary-reclaim text-dim">up to ${formatBytes(
        totalReclaim
      )} reclaimable</span>`;
    results.appendChild(summary);

    // Selection: for each set, the paths chosen to be trashed (default = all
    // but the first, "keep one").
    const trash = new Map<number, Set<string>>();
    usable.forEach((s, i) => trash.set(i, new Set(s.paths.slice(1))));

    const cleanBar = el("div", "dupes-cleanbar");
    const cleanBtn = button({
      label: "Trash selected duplicates",
      variant: "danger",
      onClick: () => void cleanDupes(),
    });
    cleanBar.appendChild(cleanBtn);

    const list = el("div", "dupes-list");
    results.appendChild(list);
    results.appendChild(cleanBar);

    function selectedTrash(): string[] {
      const out: string[] = [];
      for (const set of trash.values()) for (const p of set) out.push(p);
      return out;
    }

    function selectedReclaim(): number {
      let total = 0;
      usable.forEach((s, i) => {
        const set = trash.get(i)!;
        total += set.size * s.size;
      });
      return total;
    }

    function refreshCleanBar(): void {
      const n = selectedTrash().length;
      cleanBtn.disabled = n === 0;
      cleanBtn.textContent = n
        ? `Trash ${n} duplicate${n > 1 ? "s" : ""} · ${formatBytes(selectedReclaim())}`
        : "Trash selected duplicates";
    }

    usable.forEach((set, i) => {
      list.appendChild(renderDupeSet(set, i, trash.get(i)!, refreshCleanBar));
    });

    async function cleanDupes(): Promise<void> {
      const paths = selectedTrash();
      if (paths.length === 0) return;
      const ok = await confirmDialog({
        title: "Trash duplicates?",
        message: `Move ${paths.length} duplicate file${
          paths.length > 1 ? "s" : ""
        } (${formatBytes(
          selectedReclaim()
        )}) to the Trash. One copy of each is always kept.`,
        confirmLabel: "Move to Trash",
        danger: true,
      });
      if (!ok) return;

      cleanBtn.disabled = true;
      cleanBtn.textContent = "Trashing…";
      try {
        const res = await api.clean(paths, false);
        toast(
          res.failures
            ? `Freed ${formatBytes(res.freed)} · ${res.failures} could not be removed`
            : `Freed ${formatBytes(res.freed)} from ${res.trashed} duplicate${
                res.trashed > 1 ? "s" : ""
              }`
        );
        await scan();
      } catch (err) {
        toast(`Cleanup failed: ${errMsg(err)}`);
        refreshCleanBar();
      }
    }

    refreshCleanBar();
  }

  function renderDupeSet(
    set: DupeSet,
    index: number,
    trashSet: Set<string>,
    onChange: () => void
  ): HTMLElement {
    const wrap = el("div", "dupe-set");

    const sh = el("div", "dupe-set-head");
    sh.innerHTML = `
      <span class="dupe-set-title">${set.paths.length} copies · ${formatBytes(
      set.size
    )} each</span>
      <span class="dupe-set-reclaim text-dim">${formatBytes(
        set.reclaimable
      )} reclaimable</span>`;
    wrap.appendChild(sh);

    const rows = el("div", "dupe-set-rows");
    const name = `dupe-keep-${index}`;

    const paint = (): void => {
      rows.replaceChildren();
      set.paths.forEach((p) => {
        const kept = !trashSet.has(p);
        const row = el("label", "dupe-row");
        row.classList.toggle("is-kept", kept);

        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = name;
        radio.className = "dupe-keep-radio";
        radio.checked = kept;
        radio.setAttribute("aria-label", `Keep ${basename(p)}`);
        radio.addEventListener("change", () => {
          if (radio.checked) {
            trashSet.clear();
            for (const other of set.paths) if (other !== p) trashSet.add(other);
            paint();
            onChange();
          }
        });

        const info = el("div", "dupe-row-info");
        const fn = el("span", "dupe-row-name");
        fn.textContent = basename(p);
        fn.title = p;
        const dir = el("span", "dupe-row-dir text-dim");
        dir.textContent = dirname(p);
        dir.title = p;
        info.append(fn, dir);

        const badge = el("span", `dupe-row-badge ${kept ? "is-keep" : "is-trash"}`);
        badge.textContent = kept ? "Keep" : "Trash";

        row.append(radio, info, badge);
        rows.appendChild(row);
      });
    };

    paint();
    wrap.appendChild(rows);
    return wrap;
  }
}

/* ------------------------------------------------------------------ */
/* Shared UI helpers (scoped to this screen)                           */
/* ------------------------------------------------------------------ */

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function tag(label: string, kind: string): HTMLElement {
  const t = el("span", `files-tag files-tag-${kind}`);
  t.textContent = label;
  return t;
}

function loadingBlock(label: string): HTMLElement {
  const wrap = el("div", "files-loading");
  wrap.appendChild(spinner());
  const p = el("p", "text-dim");
  p.textContent = label;
  wrap.appendChild(p);
  return wrap;
}

function emptyState(title: string, message: string): HTMLElement {
  const wrap = el("div", "files-empty");
  wrap.innerHTML = `
    <div class="files-empty-glyph" aria-hidden="true">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </div>
    <h4>${escapeHtml(title)}</h4>
    <p class="text-dim">${escapeHtml(message)}</p>`;
  return wrap;
}

function errorState(title: string, message: string, onRetry: () => void): HTMLElement {
  const wrap = el("div", "files-empty files-error");
  wrap.innerHTML = `
    <div class="files-empty-glyph files-error-glyph" aria-hidden="true">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5v.5" />
      </svg>
    </div>
    <h4>${escapeHtml(title)}</h4>
    <p class="text-dim">${escapeHtml(message)}</p>`;
  wrap.appendChild(button({ label: "Try again", variant: "ghost", onClick: onRetry }));
  return wrap;
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}

function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el("div", "files-modal-overlay");
    const dialog = el("div", "files-modal");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "files-modal-title");

    const h = el("h3", "files-modal-title");
    h.id = "files-modal-title";
    h.textContent = opts.title;

    const p = el("p", "files-modal-msg text-dim");
    p.textContent = opts.message;

    const row = el("div", "files-modal-actions");
    const cancel = button({ label: "Cancel", variant: "ghost", onClick: () => close(false) });
    const confirm = button({
      label: opts.confirmLabel,
      variant: opts.danger ? "danger" : "primary",
      onClick: () => close(true),
    });
    row.append(cancel, confirm);

    dialog.append(h, p, row);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add("is-open"));
    confirm.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close(false);
      if (e.key === "Tab") {
        // Simple focus trap between the two buttons.
        e.preventDefault();
        (document.activeElement === confirm ? cancel : confirm).focus();
      }
    };
    overlay.addEventListener("keydown", onKey);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(false);
    });

    function close(result: boolean): void {
      overlay.classList.remove("is-open");
      overlay.removeEventListener("keydown", onKey);
      setTimeout(() => overlay.remove(), 180);
      resolve(result);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

function basename(p: string): string {
  const cleaned = p.replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i >= 0 ? cleaned.slice(i + 1) || cleaned : cleaned;
}

function dirname(p: string): string {
  const cleaned = p.replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i > 0 ? cleaned.slice(0, i) : i === 0 ? "/" : "";
}

function shortPath(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) return `~${rest.slice(slash)}`;
  }
  return p.length > 48 ? `…${p.slice(-47)}` : p;
}

function errMsg(err: unknown): string {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/* ------------------------------------------------------------------ */
/* Scoped styles (injected once)                                       */
/* ------------------------------------------------------------------ */

function injectStyles(): void {
  if (document.getElementById("files-screen-styles")) return;
  const style = document.createElement("style");
  style.id = "files-screen-styles";
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen-files {
  display: flex;
  flex-direction: column;
  gap: 22px;
  max-width: 980px;
  margin: 0 auto;
  animation: files-rise var(--speed-slow, 240ms) var(--ease, ease) both;
}
@keyframes files-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.files-head { display: flex; flex-direction: column; gap: 4px; }
.files-title { margin: 0; font-size: 24px; letter-spacing: -0.01em; }
.files-sub { margin: 0; font-size: 14px; }

.files-card { padding: 20px; }
.card-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; margin-bottom: 14px;
}
.card-head .card-title { margin: 0; font-size: 16px; }
.card-hint { margin: 4px 0 0; font-size: 13px; }
.card-actions { display: flex; gap: 10px; flex-shrink: 0; }
.card-actions .btn { padding: 8px 14px; font-size: 13px; }

/* groups */
.files-group { margin-top: 6px; }
.files-group + .files-group { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--border); }
.files-group-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.files-group-toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
.files-group-name { font-size: 14px; font-weight: 600; }
.files-group-count { font-size: 13px; font-variant-numeric: tabular-nums; }
.files-group-hint { margin: 4px 0 0 26px; font-size: 12px; }

.files-sort { display: flex; gap: 4px; }
.files-sort-chip {
  border: 1px solid transparent; background: transparent; color: var(--text-dim);
  border-radius: 999px; padding: 4px 11px; font-size: 12px; font-weight: 600;
  display: inline-flex; align-items: center; gap: 4px;
  transition: background var(--speed,180ms) var(--ease,ease), color var(--speed,180ms) var(--ease,ease);
}
.files-sort-chip:hover { color: var(--text); background: var(--surface-2); }
.files-sort-chip.is-active { color: var(--text); background: var(--accent-soft, rgba(124,92,255,.16)); }
.files-sort-arrow { font-size: 11px; opacity: .9; }

/* checkbox + radio */
.ckbx, .dupe-keep-radio {
  appearance: none; -webkit-appearance: none; margin: 0;
  width: 18px; height: 18px; flex-shrink: 0;
  border: 1.5px solid var(--text-faint); background: transparent; cursor: pointer;
  transition: border-color var(--speed,180ms) var(--ease,ease), background var(--speed,180ms) var(--ease,ease);
  display: inline-grid; place-content: center;
}
.ckbx { border-radius: 6px; }
.dupe-keep-radio { border-radius: 50%; }
.ckbx:hover, .dupe-keep-radio:hover { border-color: var(--accent); }
.ckbx:checked, .dupe-keep-radio:checked {
  background: linear-gradient(135deg, var(--accent), var(--accent-2)); border-color: transparent;
}
.ckbx:checked::after {
  content: ""; width: 10px; height: 6px; margin-top: -2px;
  border-left: 2px solid #fff; border-bottom: 2px solid #fff; transform: rotate(-45deg);
}
.dupe-keep-radio:checked::after { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #fff; }
.ckbx:indeterminate { background: var(--surface-2); border-color: var(--accent); }
.ckbx:indeterminate::after { content: ""; width: 9px; height: 2px; background: var(--accent); }
.ckbx:focus-visible, .dupe-keep-radio:focus-visible,
.files-sort-chip:focus-visible, .dupes-input:focus-visible {
  outline: 2px solid var(--accent-ring, rgba(124,92,255,.45)); outline-offset: 2px;
}

/* rows */
.files-list { list-style: none; margin: 8px 0 0; padding: 0; }
.files-row {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center;
  gap: 14px; padding: 10px 10px; border-radius: var(--radius, 11px);
  transition: background var(--speed,180ms) var(--ease,ease);
}
.files-row:hover { background: var(--surface-2); }
.files-row.is-selected { background: var(--accent-soft, rgba(124,92,255,.16)); }
.files-row-main { display: grid; gap: 2px; min-width: 0; cursor: pointer; }
.files-row-name { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.files-row-path { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.files-row-bar { height: 4px; border-radius: 999px; background: var(--surface-2); overflow: hidden; margin-top: 5px; max-width: 320px; }
.files-row-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width var(--speed-slow,240ms) var(--ease,ease); }
.files-row-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.files-row-size { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.files-row-tags { display: flex; gap: 5px; }
.files-tag { font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; padding: 2px 6px; border-radius: 5px; }
.files-tag-stale { color: var(--warn); background: color-mix(in srgb, var(--warn) 16%, transparent); }
.files-tag-risky { color: var(--danger); background: color-mix(in srgb, var(--danger) 16%, transparent); }

/* duplicates picker */
.dupes-picker { display: flex; gap: 10px; margin-bottom: 6px; }
.dupes-input {
  flex: 1; min-width: 0; font-family: var(--mono, monospace); font-size: 13px;
  color: var(--text); background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: var(--radius, 11px); padding: 9px 13px; outline: none;
  transition: border-color var(--speed,180ms) var(--ease,ease), box-shadow var(--speed,180ms) var(--ease,ease);
}
.dupes-input::placeholder { color: var(--text-faint); }
.dupes-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft, rgba(124,92,255,.16)); }
.dupes-input.is-invalid { border-color: var(--danger); animation: files-shake 320ms var(--ease,ease); }
@keyframes files-shake {
  10%,90% { transform: translateX(-1px); } 30%,70% { transform: translateX(2px); } 50% { transform: translateX(-2px); }
}
.dupes-picker .btn { white-space: nowrap; }

.dupes-results { margin-top: 8px; }
.dupes-summary { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.dupes-summary-count { font-size: 14px; font-weight: 600; }
.dupes-summary-reclaim { font-size: 13px; }

.dupes-list { display: flex; flex-direction: column; gap: 12px; }
.dupe-set {
  border: 1px solid var(--border); border-radius: var(--radius, 11px);
  background: var(--bg-elev); overflow: hidden;
  animation: files-rise var(--speed,180ms) var(--ease,ease) both;
}
.dupe-set-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.dupe-set-title { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dupe-set-reclaim { font-size: 12px; }
.dupe-set-rows { display: flex; flex-direction: column; }
.dupe-row {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px;
  padding: 9px 14px; cursor: pointer;
  transition: background var(--speed,180ms) var(--ease,ease);
}
.dupe-row:hover { background: var(--surface-2); }
.dupe-row + .dupe-row { border-top: 1px solid var(--border); }
.dupe-row-info { display: grid; gap: 1px; min-width: 0; }
.dupe-row-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dupe-row-dir { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dupe-row-badge { font-size: 10px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; padding: 3px 8px; border-radius: 6px; }
.dupe-row-badge.is-keep { color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); }
.dupe-row-badge.is-trash { color: var(--text-dim); background: var(--surface-2); }

.dupes-cleanbar { display: flex; justify-content: flex-end; margin-top: 14px; }

/* loading / empty / error */
.files-loading { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px 0; }
.files-loading p { margin: 0; font-size: 13px; }
.files-empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 40px 20px; text-align: center;
  animation: files-rise var(--speed,180ms) var(--ease,ease) both;
}
.files-empty h4 { margin: 4px 0 0; font-size: 15px; }
.files-empty p { margin: 0; font-size: 13px; max-width: 360px; }
.files-empty-glyph {
  display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%;
  color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent);
}
.files-error-glyph { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.files-error .btn { margin-top: 8px; }

/* confirm modal */
.files-modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  display: grid; place-items: center; padding: 24px;
  background: rgba(0,0,0,.5); backdrop-filter: blur(6px);
  opacity: 0; transition: opacity var(--speed,180ms) var(--ease,ease);
}
.files-modal-overlay.is-open { opacity: 1; }
.files-modal {
  width: min(420px, 100%); background: var(--bg-elev);
  border: 1px solid var(--border); border-radius: var(--radius-lg, 20px);
  box-shadow: var(--shadow-lg); padding: 22px;
  transform: scale(.96) translateY(6px); transition: transform var(--speed,180ms) var(--ease,ease);
}
.files-modal-overlay.is-open .files-modal { transform: scale(1) translateY(0); }
.files-modal-title { margin: 0 0 8px; font-size: 17px; }
.files-modal-msg { margin: 0 0 18px; font-size: 14px; line-height: 1.45; }
.files-modal-actions { display: flex; justify-content: flex-end; gap: 10px; }

@media (prefers-reduced-motion: reduce) {
  .screen-files, .files-empty, .dupe-set, .files-row-bar-fill,
  .files-modal-overlay, .files-modal { animation: none !important; transition: none !important; }
}
`;
