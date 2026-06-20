// Files — the Teal "My Clutter" world. Two clutter hunts share one stage:
//
//   1. scan(["projects","large-items"]) → sortable glass lists of the largest,
//      oldest, most reclaimable items, with keep/trash selection.
//   2. dupes(path) for a chosen folder → duplicate sets with a keep-one /
//      trash-the-rest workflow.
//
// Everything reclaimable funnels through clean(paths). The idle state is the
// hero grammar (eyebrow → glossy twin-folder art → title → subtitle → circular
// Scan CTA); a scan cross-fades to the results grid. Destructive actions are
// always confirmed and items move to the Trash, never deleted outright.

import type { Api } from "../api";
import type { DupeSet, Finding, Report } from "../types";
import { button, formatBytes, icon, spinner, toast } from "../components";
import heroRaw from "../assets/illustrations/files.svg?raw";

type SortKey = "size" | "name";

interface ListState {
  target: string;
  findings: Finding[];
  selected: Set<string>;
  sort: SortKey;
  desc: boolean;
}

const TARGET_META: Record<string, { label: string; hint: string; icon: string }> = {
  projects: {
    label: "Projects",
    hint: "Dev project folders and their build artifacts",
    icon: "folder",
  },
  "large-items": {
    label: "Large items",
    hint: "Big files left untouched for a while",
    icon: "files",
  },
};

export function renderFiles(root: HTMLElement, api: Api): void {
  injectStyles();

  const screen = document.createElement("div");
  screen.className = "screen fl";
  root.appendChild(screen);

  // Both stages live in one column and cross-fade between each other.
  const hero = document.createElement("section");
  hero.className = "fl-hero";
  screen.appendChild(hero);

  const results = document.createElement("section");
  results.className = "fl-results";
  results.hidden = true;
  screen.appendChild(results);

  const lists = new Map<string, ListState>();

  // ---- hero (idle) ----------------------------------------------------------
  hero.innerHTML = `
    <div class="eyebrow">My Clutter</div>
    <div class="hero-art" aria-hidden="true">${heroRaw}</div>
    <h1 class="title">Find what's quietly piling up.</h1>
    <p class="subtitle">Surface oversized projects and forgotten files, then hunt down duplicate copies — keep one, trash the rest.</p>
    <div class="fl-cta-pedestal"></div>
    <p class="fl-hint">Nothing is deleted — items move to the Trash.</p>`;

  const ctaHost = hero.querySelector<HTMLElement>(".fl-cta-pedestal")!;
  const scanCta = document.createElement("button");
  scanCta.type = "button";
  scanCta.className = "cta-circle fl-cta";
  scanCta.textContent = "Scan";
  scanCta.setAttribute("aria-label", "Scan for large and old files");
  scanCta.addEventListener("click", () => void runScan());
  ctaHost.appendChild(scanCta);

  attachParallax(hero.querySelector<HTMLElement>(".hero-art")!);

  // ---- results layout (built once, populated per scan) ----------------------
  const head = document.createElement("div");
  head.className = "results-head";
  head.innerHTML = `
    <div class="fl-head-text">
      <h2 class="fl-head-title">Your clutter is ready</h2>
      <p class="results-sub fl-head-sub"></p>
    </div>
    <div class="results-actions"></div>`;
  const headActions = head.querySelector<HTMLElement>(".results-actions")!;
  const headSub = head.querySelector<HTMLElement>(".fl-head-sub")!;

  const cleanPill = document.createElement("button");
  cleanPill.type = "button";
  cleanPill.className = "cta-pill fl-clean-pill";
  cleanPill.appendChild(icon("trash", { size: 16 }));
  cleanPill.appendChild(elText("span", "Clean selected"));
  cleanPill.addEventListener("click", () => void cleanSelected());

  const rescanBtn = button({
    label: "Rescan",
    variant: "ghost",
    icon: "refresh",
    onClick: () => void runScan(),
  });

  headActions.append(cleanPill, rescanBtn);

  const grid = document.createElement("div");
  grid.className = "grid fl-grid";

  const dupes = buildDuplicates(api);

  results.append(head, grid, dupes.root);

  // ---- selection plumbing ---------------------------------------------------
  function selectedPaths(): string[] {
    const out: string[] = [];
    for (const st of lists.values())
      for (const f of st.findings) if (st.selected.has(f.path)) out.push(f.path);
    return out;
  }

  function selectedSize(): number {
    let total = 0;
    for (const st of lists.values())
      for (const f of st.findings) if (st.selected.has(f.path)) total += f.size;
    return total;
  }

  function refreshCleanPill(): void {
    const paths = selectedPaths();
    const label = cleanPill.querySelector("span")!;
    cleanPill.toggleAttribute("disabled", paths.length === 0);
    cleanPill.setAttribute("aria-disabled", paths.length === 0 ? "true" : "false");
    label.textContent = paths.length
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
    });
    if (!ok) return;

    setPillBusy(cleanPill, "Cleaning…");
    try {
      const res = await api.clean(paths, false);
      toast(
        res.failures
          ? `Freed ${formatBytes(res.freed)} · ${res.failures} could not be removed`
          : `Freed ${formatBytes(res.freed)} across ${res.trashed} item${
              res.trashed > 1 ? "s" : ""
            }`
      );
      await runScan();
    } catch (err) {
      clearPillBusy(cleanPill);
      toast(`Cleanup failed: ${errMsg(err)}`);
      refreshCleanPill();
    }
  }

  // ---- scan flow ------------------------------------------------------------
  async function runScan(): Promise<void> {
    showResults();
    headActions.style.visibility = "hidden";
    headSub.textContent = "Scanning projects and large files…";
    grid.replaceChildren(loadingTile("Hunting through your projects and large files…"));

    try {
      const reports = await api.scan(["projects", "large-items"]);
      renderGroups(reports);
    } catch (err) {
      grid.replaceChildren(
        errorTile("Scan failed", errMsg(err), () => void runScan())
      );
      headActions.style.visibility = "hidden";
      headSub.textContent = "Something went wrong.";
    }
  }

  function renderGroups(reports: Report[]): void {
    grid.replaceChildren();
    lists.clear();

    const nonEmpty = reports.filter((r) => r.findings.length > 0);
    if (nonEmpty.length === 0) {
      grid.replaceChildren(
        emptyTile(
          "Nothing oversized",
          "Your projects and large files are all within reason. Nice and tidy."
        )
      );
      headActions.style.visibility = "hidden";
      headSub.textContent = "All tidy. Try the duplicate finder below.";
      return;
    }

    let total = 0;
    let count = 0;
    for (const report of nonEmpty) {
      const st: ListState = {
        target: report.target,
        findings: report.findings.slice(),
        selected: new Set(),
        sort: "size",
        desc: true,
      };
      lists.set(report.target, st);
      total += st.findings.reduce((a, f) => a + f.size, 0);
      count += st.findings.length;
      grid.appendChild(buildGroupTile(st, refreshCleanPill));
    }

    headSub.textContent = `${count} item${count > 1 ? "s" : ""} · up to ${formatBytes(
      total
    )} reclaimable`;
    headActions.style.visibility = "visible";
    refreshCleanPill();
    staggerIn(grid);
  }

  function showResults(): void {
    if (!results.hidden) return;
    hero.classList.add("is-leaving");
    window.setTimeout(() => {
      hero.hidden = true;
      results.hidden = false;
      requestAnimationFrame(() => results.classList.add("is-in"));
    }, 200);
  }
}

/* ------------------------------------------------------------------ */
/* Large & Old — group tiles                                           */
/* ------------------------------------------------------------------ */

function buildGroupTile(st: ListState, onChange: () => void): HTMLElement {
  const meta = TARGET_META[st.target] ?? { label: st.target, hint: "", icon: "files" };
  const total = st.findings.reduce((a, f) => a + f.size, 0);

  const tile = document.createElement("article");
  tile.className = "glass-card fl-tile";

  const top = document.createElement("div");
  top.className = "fl-tile-top";

  const chip = document.createElement("span");
  chip.className = "fl-tile-chip";
  chip.appendChild(icon(meta.icon, { size: 20 }));

  const heading = document.createElement("div");
  heading.className = "fl-tile-heading";
  heading.innerHTML = `
    <span class="fl-tile-label"></span>
    <span class="fl-tile-meta"></span>`;
  heading.querySelector(".fl-tile-label")!.textContent = meta.label;
  heading.querySelector(".fl-tile-meta")!.textContent = `${st.findings.length} item${
    st.findings.length > 1 ? "s" : ""
  } · ${formatBytes(total)}`;

  const allLabel = document.createElement("label");
  allLabel.className = "fl-tile-all";
  const allBox = document.createElement("input");
  allBox.type = "checkbox";
  allBox.className = "check";
  allBox.setAttribute("aria-label", `Select all in ${meta.label}`);
  allLabel.appendChild(allBox);

  top.append(chip, heading, allLabel);
  tile.appendChild(top);

  if (meta.hint) {
    const hint = document.createElement("p");
    hint.className = "fl-tile-hint";
    hint.textContent = meta.hint;
    tile.appendChild(hint);
  }

  const sortRow = document.createElement("div");
  sortRow.className = "fl-sort";
  sortRow.append(sortChip("Size", "size", st, paint), sortChip("Name", "name", st, paint));
  tile.appendChild(sortRow);

  const list = document.createElement("ul");
  list.className = "fl-list";
  list.setAttribute("role", "list");
  tile.appendChild(list);

  function sync(): void {
    const all = st.findings.length > 0 && st.selected.size === st.findings.length;
    allBox.checked = all;
    allBox.indeterminate = !all && st.selected.size > 0;
    onChange();
  }

  function paint(): void {
    const sorted = sortFindings(st);
    const maxSize = sorted.reduce((m, f) => Math.max(m, f.size), 0);
    list.replaceChildren();
    for (const f of sorted) list.appendChild(buildRow(f, st, maxSize, sync));
    sortRow.querySelectorAll<HTMLButtonElement>(".fl-sort-chip").forEach((c) =>
      c.dispatchEvent(new CustomEvent("sync-chip"))
    );
  }

  allBox.addEventListener("change", () => {
    if (allBox.checked) for (const f of st.findings) st.selected.add(f.path);
    else st.selected.clear();
    paint();
    sync();
  });

  paint();
  sync();
  return tile;
}

function buildRow(
  f: Finding,
  st: ListState,
  maxSize: number,
  onChange: () => void
): HTMLElement {
  const li = document.createElement("li");
  li.className = "fl-row";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "check fl-row-check";
  cb.checked = st.selected.has(f.path);
  cb.setAttribute("aria-label", basename(f.path));
  cb.addEventListener("change", () => {
    if (cb.checked) st.selected.add(f.path);
    else st.selected.delete(f.path);
    li.classList.toggle("is-selected", cb.checked);
    onChange();
  });
  li.classList.toggle("is-selected", cb.checked);

  const main = document.createElement("div");
  main.className = "fl-row-main";

  const name = document.createElement("span");
  name.className = "fl-row-name";
  name.textContent = basename(f.path);
  name.title = f.path;

  const sub = document.createElement("span");
  sub.className = "fl-row-path";
  sub.textContent = shortPath(dirname(f.path));
  sub.title = f.path;

  const bar = document.createElement("div");
  bar.className = "sizebar fl-row-bar";
  const fill = document.createElement("div");
  fill.className = "sizebar-fill";
  bar.appendChild(fill);
  requestAnimationFrame(() => {
    fill.style.width = maxSize > 0 ? `${Math.max(4, (f.size / maxSize) * 100)}%` : "0%";
  });

  main.append(name, sub, bar);

  const metaCol = document.createElement("div");
  metaCol.className = "fl-row-meta";
  const size = document.createElement("span");
  size.className = "fl-row-size tnum";
  size.textContent = formatBytes(f.size);
  metaCol.appendChild(size);

  const tags = document.createElement("div");
  tags.className = "fl-row-tags";
  if (f.stale) tags.appendChild(tagPill("Old", "is-warn"));
  if (f.risky) tags.appendChild(tagPill("Risky", "is-danger"));
  if (tags.childElementCount) metaCol.appendChild(tags);

  li.append(cb, main, metaCol);
  return li;
}

function sortChip(
  label: string,
  key: SortKey,
  st: ListState,
  repaint: () => void
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fl-sort-chip";

  const apply = (): void => {
    const active = st.sort === key;
    btn.classList.toggle("is-active", active);
    btn.setAttribute(
      "aria-label",
      `Sort by ${label}${active ? (st.desc ? ", descending" : ", ascending") : ""}`
    );
    btn.innerHTML = `${label}${
      active ? `<span class="fl-sort-arrow">${st.desc ? "↓" : "↑"}</span>` : ""
    }`;
  };

  btn.addEventListener("click", () => {
    if (st.sort === key) st.desc = !st.desc;
    else {
      st.sort = key;
      st.desc = key === "size";
    }
    repaint();
  });
  btn.addEventListener("sync-chip", apply);
  apply();
  return btn;
}

function sortFindings(st: ListState): Finding[] {
  const arr = st.findings.slice();
  arr.sort((a, b) => {
    const cmp =
      st.sort === "size"
        ? a.size - b.size
        : basename(a.path).localeCompare(basename(b.path), undefined, { numeric: true });
    return st.desc ? -cmp : cmp;
  });
  return arr;
}

/* ------------------------------------------------------------------ */
/* Duplicates                                                          */
/* ------------------------------------------------------------------ */

function buildDuplicates(api: Api): { root: HTMLElement } {
  const root = document.createElement("section");
  root.className = "glass fl-dupes";

  const head = document.createElement("div");
  head.className = "fl-dupes-head";
  head.innerHTML = `
    <span class="fl-dupes-chip"></span>
    <div class="fl-dupes-heading">
      <h3 class="fl-dupes-title">Find duplicates</h3>
      <p class="fl-dupes-hint">Pick a folder to scan for identical files. Keep one copy, trash the rest.</p>
    </div>`;
  head.querySelector(".fl-dupes-chip")!.appendChild(icon("search", { size: 20 }));
  root.appendChild(head);

  const picker = document.createElement("div");
  picker.className = "fl-picker";

  const inputWrap = document.createElement("div");
  inputWrap.className = "fl-input-wrap";
  inputWrap.appendChild(icon("folder", { size: 16, className: "fl-input-icon" }));
  const input = document.createElement("input");
  input.type = "text";
  input.className = "fl-input";
  input.placeholder = "/Users/you/Downloads";
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.setAttribute("aria-label", "Folder to scan for duplicates");
  inputWrap.appendChild(input);

  const browseBtn = button({
    label: "Browse…",
    variant: "ghost",
    onClick: () => void browse(),
  });

  const scanBtn = document.createElement("button");
  scanBtn.type = "button";
  scanBtn.className = "cta-pill fl-dupes-scan";
  scanBtn.appendChild(icon("scan", { size: 16 }));
  scanBtn.appendChild(elText("span", "Find"));
  scanBtn.addEventListener("click", () => void scan());

  picker.append(inputWrap, browseBtn, scanBtn);
  root.appendChild(picker);

  const out = document.createElement("div");
  out.className = "fl-dupes-out";
  root.appendChild(out);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void scan();
  });

  async function browse(): Promise<void> {
    try {
      const specifier = "@tauri-apps/plugin-dialog";
      const mod = await import(/* @vite-ignore */ specifier).catch(() => null);
      const open = (mod as { open?: (o: unknown) => Promise<unknown> } | null)?.open;
      if (typeof open === "function") {
        const picked = await open({
          directory: true,
          multiple: false,
          title: "Choose a folder",
        });
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
    toast("Type a folder path, then press Find.");
  }

  async function scan(): Promise<void> {
    const path = input.value.trim();
    if (!path) {
      input.focus();
      inputWrap.classList.add("is-invalid");
      window.setTimeout(() => inputWrap.classList.remove("is-invalid"), 600);
      toast("Enter a folder path to scan.");
      return;
    }

    setPillBusy(scanBtn, "Scanning…");
    browseBtn.disabled = true;
    out.replaceChildren(loadingTile(`Hunting for duplicates in ${shortPath(path)}…`));

    try {
      const sets = await api.dupes(path);
      renderDupes(sets, path);
    } catch (err) {
      out.replaceChildren(
        errorTile("Could not scan that folder", errMsg(err), () => void scan())
      );
    } finally {
      clearPillBusy(scanBtn);
      browseBtn.disabled = false;
    }
  }

  function renderDupes(sets: DupeSet[], scannedPath: string): void {
    out.replaceChildren();

    const usable = sets.filter((s) => s.paths.length > 1);
    if (usable.length === 0) {
      out.appendChild(
        emptyTile("No duplicates found", `Every file in ${shortPath(scannedPath)} is unique.`)
      );
      return;
    }

    const totalReclaim = usable.reduce((a, s) => a + s.reclaimable, 0);

    // For each set the paths chosen for the Trash (default: all but the first).
    const trash = new Map<number, Set<string>>();
    usable.forEach((s, i) => trash.set(i, new Set(s.paths.slice(1))));

    const summary = document.createElement("div");
    summary.className = "fl-dupes-summary";
    summary.innerHTML = `
      <span class="fl-dupes-count"></span>
      <span class="fl-dupes-reclaim"></span>`;
    summary.querySelector(".fl-dupes-count")!.textContent = `${usable.length} duplicate set${
      usable.length > 1 ? "s" : ""
    }`;
    summary.querySelector(".fl-dupes-reclaim")!.textContent = `up to ${formatBytes(
      totalReclaim
    )} reclaimable`;
    out.appendChild(summary);

    const setGrid = document.createElement("div");
    setGrid.className = "grid fl-dupes-grid";
    out.appendChild(setGrid);

    const cleanBar = document.createElement("div");
    cleanBar.className = "fl-dupes-cleanbar";
    const cleanBtn = document.createElement("button");
    cleanBtn.type = "button";
    cleanBtn.className = "cta-pill fl-dupes-clean";
    cleanBtn.appendChild(icon("trash", { size: 16 }));
    cleanBtn.appendChild(elText("span", "Trash duplicates"));
    cleanBtn.addEventListener("click", () => void cleanDupes());
    cleanBar.appendChild(cleanBtn);
    out.appendChild(cleanBar);

    function selectedTrash(): string[] {
      const list: string[] = [];
      for (const set of trash.values()) for (const p of set) list.push(p);
      return list;
    }

    function selectedReclaim(): number {
      let total = 0;
      usable.forEach((s, i) => {
        total += trash.get(i)!.size * s.size;
      });
      return total;
    }

    function refreshCleanBar(): void {
      const n = selectedTrash().length;
      const label = cleanBtn.querySelector("span")!;
      cleanBtn.toggleAttribute("disabled", n === 0);
      cleanBtn.setAttribute("aria-disabled", n === 0 ? "true" : "false");
      label.textContent = n
        ? `Trash ${n} duplicate${n > 1 ? "s" : ""} · ${formatBytes(selectedReclaim())}`
        : "Trash duplicates";
    }

    usable.forEach((set, i) => {
      setGrid.appendChild(buildDupeTile(set, i, trash.get(i)!, refreshCleanBar));
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
      });
      if (!ok) return;

      setPillBusy(cleanBtn, "Trashing…");
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
        clearPillBusy(cleanBtn);
        toast(`Cleanup failed: ${errMsg(err)}`);
        refreshCleanBar();
      }
    }

    refreshCleanBar();
    staggerIn(setGrid);
  }

  return { root };
}

function buildDupeTile(
  set: DupeSet,
  index: number,
  trashSet: Set<string>,
  onChange: () => void
): HTMLElement {
  const tile = document.createElement("article");
  tile.className = "glass-card fl-dupe";

  const top = document.createElement("div");
  top.className = "fl-dupe-top";
  top.innerHTML = `
    <span class="fl-dupe-count"></span>
    <span class="fl-dupe-reclaim"></span>`;
  top.querySelector(".fl-dupe-count")!.textContent = `${set.paths.length} copies · ${formatBytes(
    set.size
  )} each`;
  top.querySelector(".fl-dupe-reclaim")!.textContent = `${formatBytes(set.reclaimable)} reclaimable`;
  tile.appendChild(top);

  const rows = document.createElement("div");
  rows.className = "fl-dupe-rows";
  const name = `fl-keep-${index}`;
  tile.appendChild(rows);

  const paint = (): void => {
    rows.replaceChildren();
    set.paths.forEach((p) => {
      const kept = !trashSet.has(p);
      const row = document.createElement("label");
      row.className = "fl-dupe-row";
      row.classList.toggle("is-kept", kept);

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = name;
      radio.className = "fl-keep-radio";
      radio.checked = kept;
      radio.setAttribute("aria-label", `Keep ${basename(p)}`);
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        trashSet.clear();
        for (const other of set.paths) if (other !== p) trashSet.add(other);
        paint();
        onChange();
      });

      const info = document.createElement("div");
      info.className = "fl-dupe-info";
      const fn = document.createElement("span");
      fn.className = "fl-dupe-name";
      fn.textContent = basename(p);
      fn.title = p;
      const dir = document.createElement("span");
      dir.className = "fl-dupe-dir";
      dir.textContent = shortPath(dirname(p));
      dir.title = p;
      info.append(fn, dir);

      const badge = document.createElement("span");
      badge.className = `fl-dupe-badge ${kept ? "is-keep" : "is-trash"}`;
      badge.textContent = kept ? "Keep" : "Trash";

      row.append(radio, info, badge);
      rows.appendChild(row);
    });
  };

  paint();
  return tile;
}

/* ------------------------------------------------------------------ */
/* Shared tiles / states                                               */
/* ------------------------------------------------------------------ */

function loadingTile(label: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "state fl-state";
  wrap.appendChild(spinner({ size: 32 }));
  wrap.appendChild(elText("p", label, "fl-state-text"));
  return wrap;
}

function emptyTile(title: string, message: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "state fl-state";
  const glyph = document.createElement("div");
  glyph.className = "fl-state-glyph";
  glyph.appendChild(icon("check", { size: 30 }));
  wrap.appendChild(glyph);
  wrap.appendChild(elText("h3", title));
  wrap.appendChild(elText("p", message, "fl-state-text"));
  return wrap;
}

function errorTile(title: string, message: string, onRetry: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "state fl-state";
  const glyph = document.createElement("div");
  glyph.className = "fl-state-glyph is-danger";
  glyph.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></svg>`;
  wrap.appendChild(glyph);
  wrap.appendChild(elText("h3", title));
  wrap.appendChild(elText("p", message, "fl-state-text"));
  wrap.appendChild(button({ label: "Try again", variant: "ghost", onClick: onRetry }));
  return wrap;
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
}

function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fl-modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "glass-strong fl-modal";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "fl-modal-title");

    const h = elText("h3", opts.title, "fl-modal-title");
    h.id = "fl-modal-title";
    const p = elText("p", opts.message, "fl-modal-msg");

    const row = document.createElement("div");
    row.className = "fl-modal-actions";
    const cancel = button({ label: "Cancel", variant: "ghost", onClick: () => close(false) });
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "cta-pill fl-modal-confirm";
    confirm.appendChild(icon("trash", { size: 16 }));
    confirm.appendChild(elText("span", opts.confirmLabel));
    confirm.addEventListener("click", () => close(true));
    row.append(cancel, confirm);

    dialog.append(h, p, row);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add("is-open"));
    confirm.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close(false);
      if (e.key === "Tab") {
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
      window.setTimeout(() => overlay.remove(), 180);
      resolve(result);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Small UI helpers                                                    */
/* ------------------------------------------------------------------ */

function elText(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function tagPill(label: string, kind: string): HTMLElement {
  const t = document.createElement("span");
  t.className = `fl-tag ${kind}`;
  t.textContent = label;
  return t;
}

function setPillBusy(btn: HTMLButtonElement, label: string): void {
  const span = btn.querySelector("span");
  if (span) {
    btn.dataset.prevLabel = span.textContent ?? "";
    span.textContent = label;
  }
  btn.disabled = true;
  btn.setAttribute("aria-disabled", "true");
}

function clearPillBusy(btn: HTMLButtonElement): void {
  const span = btn.querySelector("span");
  if (span && btn.dataset.prevLabel != null) span.textContent = btn.dataset.prevLabel;
  delete btn.dataset.prevLabel;
  btn.disabled = false;
  btn.setAttribute("aria-disabled", "false");
}

// Stagger the children of a freshly-painted grid into view (~40ms each).
function staggerIn(container: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const kids = Array.from(container.children) as HTMLElement[];
  kids.forEach((kid, i) => {
    kid.style.animation = "none";
    kid.style.opacity = "0";
    kid.style.transform = "translateY(10px)";
    window.setTimeout(() => {
      kid.style.animation = "fade-up var(--t-slow) var(--ease) both";
      kid.style.opacity = "";
      kid.style.transform = "";
    }, i * 40);
  });
}

// Gentle pointer parallax on the hero art (disabled for reduced motion).
function attachParallax(art: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const host = art.closest(".fl-hero") as HTMLElement | null;
  if (!host) return;
  const onMove = (e: PointerEvent): void => {
    const rect = host.getBoundingClientRect();
    const dx = (e.clientX - rect.left - rect.width / 2) / rect.width;
    const dy = (e.clientY - rect.top - rect.height / 2) / rect.height;
    art.style.setProperty("--px", `${(dx * 8).toFixed(2)}px`);
    art.style.setProperty("--py", `${(dy * 8).toFixed(2)}px`);
  };
  const reset = (): void => {
    art.style.setProperty("--px", "0px");
    art.style.setProperty("--py", "0px");
  };
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", reset);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

/* ------------------------------------------------------------------ */
/* Scoped styles (injected once)                                       */
/* ------------------------------------------------------------------ */

function injectStyles(): void {
  if (document.getElementById("fl-styles")) return;
  const style = document.createElement("style");
  style.id = "fl-styles";
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.fl { gap: 0; }

/* ---- hero (idle) ---- */
.fl-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 880px;
  margin: 0 auto;
  padding: var(--s-5) var(--s-4) var(--s-6);
  animation: fade-up var(--t-slow) var(--ease) both;
}
.fl-hero.is-leaving {
  animation: fade-out var(--t-base) var(--ease) both;
}
@keyframes fade-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(-8px); }
}
.fl-hero .hero-art {
  transform: translate(var(--px, 0px), var(--py, 0px));
  transition: transform 120ms var(--ease-soft);
}
.fl-cta-pedestal {
  margin-top: var(--s-6);
  display: grid;
  place-items: center;
}
.fl-cta { --size: 132px; }
.fl-hint {
  margin-top: var(--s-3);
  font-size: 13px;
  color: var(--text-faint);
}

/* ---- results ---- */
.fl-results {
  max-width: 880px;
  margin: 0 auto;
  padding: var(--s-5) 0 var(--s-6);
  width: 100%;
  opacity: 0;
  transition: opacity var(--t-slow) var(--ease);
}
.fl-results.is-in { opacity: 1; }
.fl-head-title { font-size: 24px; font-weight: 700; letter-spacing: -0.01em; }
.fl-head-sub { min-height: 18px; }
.fl-clean-pill[disabled],
.fl-dupes-clean[disabled],
.fl-dupes-scan[disabled] {
  cursor: not-allowed;
  filter: saturate(0.5) brightness(0.8);
  opacity: 0.85;
}

/* group tile */
.fl-grid { grid-template-columns: 1fr; gap: var(--s-3); margin-bottom: var(--s-4); }
.fl-tile { padding: 20px; }
.fl-tile-top {
  display: flex;
  align-items: center;
  gap: 13px;
}
.fl-tile-chip {
  flex: none;
  width: 40px; height: 40px;
  display: grid; place-items: center;
  border-radius: 13px;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent) 20%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-2) 30%, transparent);
}
.fl-tile-heading { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.fl-tile-label { font-size: 15px; font-weight: 600; color: var(--text); }
.fl-tile-meta { font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.fl-tile-all { flex: none; display: grid; place-items: center; cursor: pointer; }
.fl-tile-hint { margin: 12px 0 0; font-size: 12.5px; color: var(--text-faint); }

.fl-sort { display: flex; gap: 4px; margin-top: 14px; }
.fl-sort-chip {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  border-radius: var(--radius-pill);
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex; align-items: center; gap: 4px;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.fl-sort-chip:hover { color: var(--text); background: rgba(255,255,255,0.06); }
.fl-sort-chip.is-active { color: #fff; background: color-mix(in srgb, var(--accent) 26%, transparent); }
.fl-sort-arrow { font-size: 11px; opacity: 0.9; }

.fl-list { list-style: none; margin: 10px 0 0; padding: 0; }
.fl-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 10px;
  border-radius: 14px;
  transition: background var(--t-fast) var(--ease);
}
.fl-row + .fl-row { margin-top: 2px; }
.fl-row:hover { background: rgba(255,255,255,0.05); }
.fl-row.is-selected { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.fl-row-check { margin: 0; }
.fl-row-main { display: grid; gap: 3px; min-width: 0; }
.fl-row-name { font-size: 14px; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fl-row-path { font-size: 12px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fl-row-bar { height: 5px; max-width: 340px; margin-top: 4px; }
.fl-row-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.fl-row-size { font-size: 13px; font-weight: 600; color: var(--text); }
.fl-row-tags { display: flex; gap: 5px; }
.fl-tag {
  font-size: 10px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 6px;
}
.fl-tag.is-warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 18%, transparent); }
.fl-tag.is-danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 18%, transparent); }

/* ---- duplicates panel ---- */
.fl-dupes { padding: 22px; }
.fl-dupes-head { display: flex; align-items: center; gap: 13px; }
.fl-dupes-chip {
  flex: none;
  width: 40px; height: 40px;
  display: grid; place-items: center;
  border-radius: 13px;
  color: var(--accent-2);
  background: color-mix(in srgb, var(--accent) 20%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-2) 30%, transparent);
}
.fl-dupes-heading { min-width: 0; }
.fl-dupes-title { font-size: 16px; font-weight: 600; }
.fl-dupes-hint { margin: 3px 0 0; font-size: 13px; color: var(--text-dim); }

.fl-picker { display: flex; gap: 10px; margin-top: 18px; }
.fl-input-wrap {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 9px;
  padding: 0 14px;
  border-radius: 14px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.14);
  transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.fl-input-wrap:focus-within {
  border-color: var(--accent-2);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
.fl-input-wrap.is-invalid {
  border-color: var(--danger);
  animation: fl-shake 320ms var(--ease);
}
@keyframes fl-shake {
  10%,90% { transform: translateX(-1px); }
  30%,70% { transform: translateX(2px); }
  50% { transform: translateX(-2px); }
}
.fl-input-icon { color: var(--text-faint); flex: none; }
.fl-input {
  flex: 1; min-width: 0;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text);
  background: transparent;
  border: none;
  outline: none;
  padding: 10px 0;
}
.fl-input::placeholder { color: var(--text-faint); }
.fl-picker .btn { white-space: nowrap; }
.fl-dupes-scan { height: 44px; padding: 0 20px; }

.fl-dupes-out { margin-top: 20px; }
.fl-dupes-summary { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.fl-dupes-count { font-size: 14px; font-weight: 600; color: var(--text); }
.fl-dupes-reclaim { font-size: 13px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

.fl-dupes-grid { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.fl-dupe { padding: 16px; }
.fl-dupe-top {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--hairline);
}
.fl-dupe-count { font-size: 13px; font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.fl-dupe-reclaim { font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.fl-dupe-rows { display: flex; flex-direction: column; margin-top: 6px; }
.fl-dupe-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 11px;
  padding: 9px 4px;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease);
  border-radius: 10px;
}
.fl-dupe-row:hover { background: rgba(255,255,255,0.05); }
.fl-dupe-info { display: grid; gap: 1px; min-width: 0; }
.fl-dupe-name { font-size: 13px; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fl-dupe-dir { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fl-dupe-badge {
  font-size: 10px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
  padding: 3px 8px; border-radius: 7px;
}
.fl-dupe-badge.is-keep { color: var(--ok); background: color-mix(in srgb, var(--ok) 18%, transparent); }
.fl-dupe-badge.is-trash { color: var(--text-dim); background: rgba(255,255,255,0.08); }

.fl-keep-radio {
  appearance: none; -webkit-appearance: none; margin: 0;
  width: 19px; height: 19px; flex: none;
  border: 1.5px solid rgba(255,255,255,0.2);
  background: rgba(255,255,255,0.08);
  border-radius: 50%;
  cursor: pointer;
  display: inline-grid; place-content: center;
  transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.fl-keep-radio:hover { border-color: var(--accent-2); }
.fl-keep-radio:checked {
  background: linear-gradient(150deg, var(--accent), var(--accent-2));
  border-color: transparent;
}
.fl-keep-radio:checked::after {
  content: ""; width: 7px; height: 7px; border-radius: 50%; background: #fff;
}
.fl-keep-radio:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }

.fl-dupes-cleanbar { display: flex; justify-content: flex-end; margin-top: 18px; }

/* ---- states ---- */
.fl-state { min-height: 200px; padding: 36px 20px; }
.fl-state-text { font-size: 13.5px; color: var(--text-dim); max-width: 380px; }
.fl-state-glyph {
  width: 60px; height: 60px;
  display: grid; place-items: center;
  border-radius: 18px;
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 16%, transparent);
}
.fl-state-glyph.is-danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 16%, transparent); }

/* ---- confirm modal ---- */
.fl-modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  display: grid; place-items: center; padding: 24px;
  background: rgba(0,0,0,0.5);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  opacity: 0;
  transition: opacity var(--t-base) var(--ease);
}
.fl-modal-overlay.is-open { opacity: 1; }
.fl-modal {
  width: min(420px, 100%);
  padding: 24px;
  transform: scale(0.96) translateY(6px);
  transition: transform var(--t-base) var(--ease);
}
.fl-modal-overlay.is-open .fl-modal { transform: scale(1) translateY(0); }
.fl-modal-title { position: relative; margin: 0 0 8px; font-size: 18px; }
.fl-modal-msg { position: relative; margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: var(--text-dim); }
.fl-modal-actions { position: relative; display: flex; justify-content: flex-end; gap: 10px; }
.fl-modal-confirm {
  height: 44px; padding: 0 20px;
  background:
    radial-gradient(120% 120% at 30% 22%, rgba(255,255,255,0.3), transparent 55%),
    linear-gradient(150deg, var(--danger), #ff8a95);
  box-shadow: 0 8px 24px rgba(255, 93, 108, 0.32), 0 0 0 1px rgba(255,255,255,0.18) inset;
}

@media (prefers-reduced-motion: reduce) {
  .fl-hero, .fl-hero.is-leaving, .fl-results,
  .fl-hero .hero-art { animation: none !important; transition: none !important; }
}
`;
