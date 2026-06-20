# Sweep — Design Spec (authoritative)

This is the single source of truth for the Sweep visual/UX redesign. Every agent
(foundation, screens, graphistes, icons) builds to **this** file. If something is
ambiguous in your task and specified here, **this wins**.

Goal: a **native-feeling macOS app** with the visual caliber of CleanMyMac (MacPaw).
Each screen is its **own full-bleed colour world** with a glassy 3D hero, liquid-glass
panels, big confident type, and a glowing circular primary action.

**Hard constraint:** this is a visual/UX redesign only. Screens keep calling the
existing `api.*` methods exactly as today. The Rust `gui_api` is untouched. Do not
change data wiring, route ids, screen export names, or api signatures.

---

## 0. Source of truth & ownership

The 8 routes (from `router.ts`, do not rename):

| id | sidebar label | colour world | hero object |
|---|---|---|---|
| `dashboard` | Smart Scan | **Violet** (Smart Care) | glossy cleaning disc / orb |
| `cleanup` | Cleanup | **Green** | broom sweeping a glass pile |
| `applications` | Applications | **Blue** | app "X" hexagon tile |
| `privacy` | Privacy | **Magenta/Pink** (Protection) | shield + hand |
| `files` | Files | **Teal** (Duplicates) | stacked folders / twins |
| `spacelens` | Space Lens | **Deep Purple** | radial sunburst / magnifier |
| `maintenance` | Maintenance | **Orange/Amber** (Performance) | lightning bolt |
| `schedule` | Schedule | **Cyan/Indigo** | clock dial |

File ownership (edit ONLY your files):

- `gui/DESIGN_SPEC.md` — spec agent (this file)
- `gui/src/styles/{tokens,glass,global}.css` — foundation
- `gui/src/shell.ts` — foundation (per-route `data-theme` + world background + sidebar)
- `gui/src-tauri/tauri.conf.json` (+ maybe `Cargo.toml`/`main.rs`) — foundation
- `gui/src/assets/illustrations/<screen>.svg` — one graphiste per screen
- `gui/src/assets/icons/*.svg`, `logo.svg` — icons agent
- `gui/src/screens/<name>.ts` — one screen agent each

**Caveat on colour values:** MacPaw publishes no hex palette. The values below are a
faithful reconstruction from official screenshots, tuned for a dark UI. They are
final for this build — use them verbatim. Do not invent your own.

---

## 1. The 8 colour worlds (exact values)

### Theme mechanism

The shell sets `data-theme="<route id>"` on a single wrapper element (the
`.content` region — see §7). Each theme defines four custom properties:

- `--world-grad` — the full-bleed background gradient painted behind everything
- `--accent` — primary world hue (CTA fill start, progress, active glyph)
- `--accent-2` — secondary hue (gradient end, highlights, links)
- `--glow` — the rgba used for halos/pulses/drop-shadows (accent at ~45% alpha)

Screens and components **must not hardcode colours**. Read these four vars plus the
neutral tokens in §3. `color-mix(in srgb, var(--accent) N%, …)` is the approved way
to derive tints/shades.

Define these in `tokens.css`. The selector is `[data-theme="<id>"]`.

```css
/* dashboard — Violet (Smart Care): the brand hero world */
[data-theme="dashboard"] {
  --accent: #7b5bff;
  --accent-2: #9d7bff;
  --glow: rgba(123, 91, 255, 0.45);
  --world-grad: radial-gradient(125% 120% at 50% 8%, #6a45e6 0%, #34197d 46%, #160a36 100%);
}

/* cleanup — Green (Emerald → forest) */
[data-theme="cleanup"] {
  --accent: #19c37d;
  --accent-2: #34e89e;
  --glow: rgba(25, 195, 125, 0.45);
  --world-grad: radial-gradient(125% 120% at 50% 8%, #12a86a 0%, #0a6b45 46%, #052b20 100%);
}

/* applications — Blue (Azure → navy) */
[data-theme="applications"] {
  --accent: #2e8bff;
  --accent-2: #5fa8ff;
  --glow: rgba(46, 139, 255, 0.45);
  --world-grad: radial-gradient(125% 120% at 50% 8%, #2474ec 0%, #12397f 46%, #08183c 100%);
}

/* privacy — Magenta/Pink (Protection) */
[data-theme="privacy"] {
  --accent: #ff3d8b;
  --accent-2: #ff6fae;
  --glow: rgba(255, 61, 139, 0.45);
  --world-grad: radial-gradient(125% 120% at 50% 8%, #e63089 0%, #8e1457 46%, #3a0c27 100%);
}

/* files — Teal (Duplicates) */
[data-theme="files"] {
  --accent: #1fc8c8;
  --accent-2: #48e0dc;
  --glow: rgba(31, 200, 200, 0.45);
  --world-grad: radial-gradient(125% 120% at 50% 8%, #14b4b4 0%, #0a5f66 46%, #042a2e 100%);
}

/* spacelens — Deep Purple (Orchid → deep purple) */
[data-theme="spacelens"] {
  --accent: #9b5cf0;
  --accent-2: #b985ff;
  --glow: rgba(155, 92, 240, 0.45);
  --world-grad: radial-gradient(125% 120% at 50% 8%, #8a45e6 0%, #4b1e96 46%, #1f0c44 100%);
}

/* maintenance — Orange/Amber (Performance) */
[data-theme="maintenance"] {
  --accent: #ff8a2b;
  --accent-2: #ffb15c;
  --glow: rgba(255, 138, 43, 0.45);
  --world-grad: radial-gradient(125% 120% at 50% 8%, #f0741c 0%, #b5400e 46%, #401608 100%);
}

/* schedule — Cyan/Indigo */
[data-theme="schedule"] {
  --accent: #2bd4ff;
  --accent-2: #6f8bff;
  --glow: rgba(43, 212, 255, 0.45);
  --world-grad: radial-gradient(125% 120% at 50% 8%, #1fb6ec 0%, #2b3aa0 46%, #0e1240 100%);
}
```

**Background painting:** `.content` (or a child `.world-bg`) gets
`background: var(--world-grad); background-attachment: fixed;`. The body itself
stays a deep neutral (`--bg`, §3) so the sidebar reads against it. On theme change
the world cross-fades (§5).

**Sidebar accent tint:** the active nav item recolours to the **current** world's
`--accent`/`--glow` automatically because it lives inside the themed wrapper. The
sidebar surface itself stays neutral glass (it does not take the world gradient).

---

## 2. Liquid-glass recipe (exact)

Lives in `glass.css`. Three glass tiers. All include the `-webkit-` prefix
(WKWebView requires it). `backdrop-filter` only works because the world gradient
sits behind these panels.

### `.glass` — standard frosted panel (cards, sidebar groups, results tiles)

```css
.glass {
  position: relative;
  background: rgba(255, 255, 255, 0.06);
  -webkit-backdrop-filter: blur(28px) saturate(1.6);
  backdrop-filter: blur(28px) saturate(1.6);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 22px;
  box-shadow:
    0 1px 0 0 rgba(255, 255, 255, 0.14) inset,   /* top light edge */
    0 18px 48px rgba(0, 0, 0, 0.42),             /* soft cast shadow */
    0 2px 8px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}
/* inner top sheen — the highlight that sells the glass */
.glass::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0) 38%);
  pointer-events: none;
}
```

- Top light border: `inset 0 1px 0 rgba(255,255,255,.14)` (the bright top edge).
- Soft large shadow: `0 18px 48px rgba(0,0,0,.42)`.
- bg rgba: `rgba(255,255,255,.06)` on dark worlds. Tunable per density; never above `.10`.

### `.glass-strong` — elevated / hovered / modal surfaces

Same as `.glass` but `background: rgba(255,255,255,0.10)`, `blur(36px)`, and add a
faint world tint: layer `radial-gradient(140% 120% at 0% 0%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 55%)` under the white fill.

### `.glass-cta` — the circular primary button (§4)

A heavier, brighter glass with the world accent baked in. See §4 for the full rule.

### Geometry rule (superellipse / squircle)

CleanMyMac uses continuous-corner shapes, not circles or sharp rects. Approximate
in CSS: large `border-radius` (cards **22px**, tiles **18px**, pills **999px**).
The CTA is a true circle/pill. Avoid thin sharp rectangles.

### WKWebView pitfalls (do not violate)

- Always pair `-webkit-backdrop-filter` with `backdrop-filter`.
- **Do not** use SVG `feDisplacementMap`/`url(#filter)` inside `backdrop-filter` — it
  silently fails in WKWebView. Refraction is faked with blur + saturate + inset
  highlight only.
- Keep `html, body { background: var(--bg) }` opaque-ish; we are NOT using native
  window transparency for content (only optional sidebar vibrancy, §8). Glass
  samples the world gradient behind it, which is a real painted layer.

---

## 3. Neutral tokens (theme-independent)

Keep these in `tokens.css` `:root`. Worlds override only `--accent*`, `--glow`,
`--world-grad`.

```css
:root {
  color-scheme: dark;

  --bg: #0a0b12;            /* body behind the sidebar */
  --bg-elev: #11131c;

  /* text on dark glass over saturated worlds */
  --text: #ffffff;
  --text-dim: rgba(255, 255, 255, 0.72);
  --text-faint: rgba(255, 255, 255, 0.48);
  --hairline: rgba(255, 255, 255, 0.12);

  /* semantic (kept stable across worlds) */
  --ok: #34e89e;
  --warn: #ffc24b;
  --danger: #ff5d6c;

  /* shape */
  --radius-card: 22px;
  --radius-tile: 18px;
  --radius-pill: 999px;

  /* spacing — 8pt grid */
  --s-1: 4px;  --s-2: 8px;  --s-3: 16px;
  --s-4: 24px; --s-5: 32px; --s-6: 48px; --s-7: 64px;
  --gap: 16px;

  /* type stacks */
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
    "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  /* motion (see §5) */
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-soft: cubic-bezier(0.2, 0.8, 0.2, 1);
  --t-fast: 150ms;
  --t-base: 220ms;
  --t-slow: 300ms;

  /* sensible neutral defaults so a screen renders even before a theme is set */
  --accent: #7b5bff;
  --accent-2: #9d7bff;
  --glow: rgba(123, 91, 255, 0.45);
  --world-grad: radial-gradient(125% 120% at 50% 8%, #6a45e6 0%, #34197d 46%, #160a36 100%);
}
```

> Note: this replaces the old neutral palette in `tokens.css`. Text is white-on-world
> now (worlds are saturated), not light-grey-on-black. The foundation agent rewrites
> `tokens.css` to this; screens that read `--text*` keep working.

---

## 4. Layout grammar

Every screen has two states sharing one column: **idle/hero** and **results-grid**.
The transition between them is a cross-fade (§5). Content max-width **880px**,
horizontally centered, `padding: var(--s-5) var(--s-4)`.

### 4a. Idle / hero state (vertical stack, centered)

Top → bottom, centered, generous negative space ("a stage, not a dashboard"):

1. **Eyebrow** — `.hero-eyebrow`: 13px / 600, UPPERCASE, `letter-spacing: .14em`,
   `color: var(--text-faint)`. The world/category name (e.g. `SMART CARE`,
   `PROTECTION`). Margin-bottom `var(--s-3)`.
2. **Hero illustration** — `.hero-art`: the big glossy 3D object, **220–260px**
   tall, centered, sits in the upper-middle. Floats + parallax (§5). It is the focal
   point. Imported `import heroRaw from "../assets/illustrations/<screen>.svg?raw"`
   and injected into a `.hero-art` div. Sits over a `--glow` halo (radial blur behind).
3. **Title** — `.hero-title`: **34px** (clamp 30–40) / **700**, white,
   `letter-spacing: -0.02em`, line-height 1.1. Short and confident
   (e.g. "Five routines. One Smart Scan."). Margin-top `var(--s-4)`.
4. **Subtitle** — `.hero-sub`: **17px** / 400, `color: var(--text-dim)`, max-width
   460px, centered. One supporting sentence. Margin-top `var(--s-2)`.
5. **Primary action** — the **circular CTA** (`.cta-circle`, §4c). Centered,
   margin-top `var(--s-6)`. Glows in `--glow`, pulses softly. For dashboard this is
   the existing progress ring doubling as the scan button; other screens use a
   circular Scan/Run/Clean.
6. Optional **hint line** under the CTA: 13px `--text-faint` (e.g. "Nothing is
   deleted — items move to Trash.").

### 4b. Results-grid state

After a scan/run, the hero block cross-fades to a results layout:

1. **Header row** (`.results-head`): left = title (e.g. "Your tasks are ready")
   24px/700 + sub line (total reclaimable / count, `--text-dim`); right = primary
   action pill (`Clean`/`Review all`) + ghost `Rescan`.
2. **Tile grid** (`.results-grid`): CSS grid,
   `grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); gap: var(--s-3);`.
   Each tile is a `.glass` **result card** (`.result-tile`):
   - small glossy duotone icon (28–32px) top-left in a rounded `--accent`-tinted chip
   - **label** 15px/600 white
   - **meta** (count + size) 13px/`--text-dim`, tabular-nums
   - a thin progress/`.sizebar` row showing this category's share (optional)
   - action affordance: `Review` (ghost) / `Clean` (accent pill) bottom-right, or
     a checkbox for batch selection — match each screen's existing api flow.
   - hover: `translateY(-2px)`, border brightens to `--glow`, `.glass-strong` shadow.

Tile internal padding **18–20px**; the grid keeps the world gradient visible in the
gutters.

### 4c. The circular primary CTA

```css
.cta-circle {
  --size: 128px;
  width: var(--size); height: var(--size);
  border-radius: var(--radius-pill);
  display: grid; place-items: center;
  color: #fff; font-size: 17px; font-weight: 700; letter-spacing: -0.01em;
  cursor: pointer; border: none;
  background:
    radial-gradient(120% 120% at 30% 22%, rgba(255,255,255,0.35), transparent 55%),
    linear-gradient(150deg, var(--accent), var(--accent-2));
  box-shadow:
    0 0 0 1px rgba(255,255,255,0.18) inset,
    0 10px 30px var(--glow),
    0 2px 6px rgba(0,0,0,0.35);
  -webkit-backdrop-filter: blur(8px) saturate(1.4);
  backdrop-filter: blur(8px) saturate(1.4);
  transition: transform var(--t-base) var(--ease), box-shadow var(--t-base) var(--ease), filter var(--t-base) var(--ease);
  animation: cta-pulse 3.2s var(--ease-soft) infinite;
}
.cta-circle:hover { transform: translateY(-2px) scale(1.02); filter: brightness(1.06); }
.cta-circle:active { transform: scale(0.98); }
.cta-circle:focus-visible { outline: 3px solid var(--accent-2); outline-offset: 4px; }
```

The CTA may slightly **overrun** its container (CleanMyMac "goes beyond the
application") — allow it to sit on a small negative-margin pedestal; do not clip it.
A pill variant `.cta-pill` (height 48px, `border-radius:999px`, same fill/glow) is
used in the results header and for secondary primary actions.

### Typography scale (summary)

| Role | Size / weight | Tracking | Colour |
|---|---|---|---|
| Eyebrow | 13 / 600 UPPERCASE | +0.14em | `--text-faint` |
| Hero title | clamp(30,~,40) / 700 | -0.02em | `--text` |
| Subtitle | 17 / 400 | 0 | `--text-dim` |
| Results header title | 24 / 700 | -0.01em | `--text` |
| Tile label | 15 / 600 | 0 | `--text` |
| Tile / row meta | 13 / 400 tabular | 0 | `--text-dim` |
| CTA label | 17 / 700 | -0.01em | #fff |
| Section label | 12 / 700 UPPERCASE | +0.06em | `--text-faint` |

Spacing: 8pt grid (4/8/16/24/32/48/64). Gutters wide; eyebrow→title `--s-4`,
title→sub `--s-2`, sub→CTA `--s-6`. Tiles gap `--s-3`.

---

## 5. Motion spec

| Element | Property | Duration | Easing | Notes |
|---|---|---|---|---|
| Route / world change | background + opacity cross-fade | **300ms** | `--ease-soft` | new screen `fade-up`; world gradient fades, no hard cut |
| Hero illustration | float | **6s** loop alternate | `ease-in-out` | `translateY(0 → -10px)` + `scale(1 → 1.02)` |
| Hero illustration | parallax on pointer | follows | — | translate up to ±8px from cursor offset; off when reduced-motion |
| Hero glow halo | breathe | **8s** loop alternate | `ease-in-out` | opacity .45→.7, slight scale |
| CTA circle | pulse glow | **3.2s** loop | `--ease-soft` | box-shadow glow expands/contracts (`cta-pulse`) |
| Idle ↔ results | cross-fade | **220ms** out / **300ms** in | `--ease` | hero block fades out, grid `fade-up` in (stagger tiles ~40ms) |
| Tile hover | transform + shadow | **220ms** | `--ease` | `translateY(-2px)`, brighter border/shadow |
| Button / nav | bg + transform | **150ms** | `--ease` | `:active` scale .97 |
| Progress ring fill | stroke-dashoffset | **900ms** | `cubic-bezier(.22,1,.36,1)` | dashboard count-up in lockstep |
| Sizebar fill | width | **700ms** | `--ease` | grows from 0 on mount |
| Toast | in/out | 300/150ms | `--ease` | existing |

Required keyframes (define in `global.css`):

```css
@keyframes cta-pulse {
  0%,100% { box-shadow: 0 0 0 1px rgba(255,255,255,.18) inset, 0 10px 30px var(--glow), 0 2px 6px rgba(0,0,0,.35); }
  50%     { box-shadow: 0 0 0 1px rgba(255,255,255,.22) inset, 0 14px 44px var(--glow), 0 2px 6px rgba(0,0,0,.35); }
}
@keyframes hero-float {
  from { transform: translateY(0) scale(1); }
  to   { transform: translateY(-10px) scale(1.02); }
}
@keyframes halo-breathe {
  from { opacity: .45; transform: scale(1); }
  to   { opacity: .70; transform: scale(1.08); }
}
@keyframes fade-up { from { opacity:0; transform: translateY(10px);} to {opacity:1; transform:translateY(0);} }
@keyframes world-fade { from { opacity: 0; } to { opacity: 1; } }
```

**Reduced motion:** under `@media (prefers-reduced-motion: reduce)` disable float,
halo-breathe, cta-pulse, parallax, ring sweep; keep cross-fades capped at ~0.01ms
(as today). All functionality must remain.

---

## 6. Hero illustrations (graphiste deliverables)

Style: glossy, dimensional 3D-looking objects authored as **premium SVG** —
radial-gradient body shading (light top-left → dark bottom-right), a translucent
white **specular highlight ellipse** near the top, a soft blurred **contact shadow**
(`feGaussianBlur` + `feOffset`), and a coloured **inner glow/halo** echoing the
world. Frosted, semi-transparent glass material. **Not flat.** Use
`feSpecularLighting`/`fePointLight` only for the single hero object if desired;
gradient + highlight-ellipse is the reliable default. No `feDisplacementMap`.

Each SVG: `viewBox="0 0 240 240"` (square stage), `fill="none"` root, self-contained
`<defs>` with **uniquely-prefixed ids** (e.g. `dashHaloGrad`, `cleanupBody`) to avoid
id collisions when multiple heroes mount. May reference `currentColor` / inherit, but
prefer baking the world hue so the object reads even mid-cross-fade; a subtle tint
tie-in via `var(--accent)` in stops is allowed since they render inline.

Filenames (imported `../assets/illustrations/<screen>.svg?raw`) — exact:

| file | world | glossy object |
|---|---|---|
| `dashboard.svg` | Violet | cleaning disc / orb with checkmark sheen — the Smart Care hero |
| `cleanup.svg` | Green | broom sweeping a glossy pile / dustpan |
| `applications.svg` | Blue | rounded app "X" hexagon tile, glassy |
| `privacy.svg` | Magenta | translucent shield (optionally a cupped hand) |
| `files.svg` | Teal | two overlapping glossy folders (duplicate twins) |
| `spacelens.svg` | Deep purple | magnifier over a radial sunburst/treemap blob |
| `maintenance.svg` | Orange | lightning bolt, glossy |
| `schedule.svg` | Cyan/Indigo | clock dial with glassy ring |

Each renders ~220–260px tall in `.hero-art`. Keep file size lean; no rasters.

---

## 7. Shell / theme wiring (foundation)

- Wrap the routed content region with the themed element. Set
  `wrapper.dataset.theme = route.id` on navigate (the `.content` element is the
  natural host; the sidebar lives outside it and stays neutral).
- Paint the world: `.content { background: var(--world-grad); background-attachment: fixed; }`
  plus an absolutely-positioned `.world-fade` layer that cross-fades on change
  (swap a second gradient layer and `world-fade` it in over 300ms), OR transition
  `background` via opacity of a stacked pseudo — keep it to a soft cross-fade.
- The titlebar (`titleBarStyle: "Overlay"`, hidden title) stays a thin draggable
  region; keep `-webkit-app-region: drag` on it and the brand, `no-drag` on buttons.
- Window size: set `width: 1180, height: 800` (min `980×640`) in `tauri.conf.json`.
- Sidebar stays neutral glass (`.glass`-like, NOT world-tinted). Active item recolours
  to the current world because it inherits `--accent`/`--glow` from the themed wrapper
  — so move the nav's active state to read `var(--accent-2)` / `var(--glow)`. If the
  nav lives outside `.content`, mirror `data-theme` onto `.shell` instead so both
  sidebar and content see the vars. **Decision: set `data-theme` on `.shell`** so the
  whole frame (sidebar active state included) follows the world; only `.content`
  paints `--world-grad`.

---

## 8. Sidebar icons + logo (icons agent)

Style: **glossy duotone** line/fill glyphs on a 24×24 `viewBox`, `fill="none"` where
stroked, `stroke="currentColor"` so they tint via the nav colour. The 8 module icons
may carry a subtle two-tone (accent fill at low alpha + currentColor stroke) to feel
glassy; the small utility glyphs stay single-stroke. Sidebar renders them at **18px**;
keep strokes ~2px so they stay crisp.

Required icon files (`assets/icons/<name>.svg`), loaded by `icon()`:

**Module icons (one per route):**
`dashboard`, `cleanup`, `applications`, `privacy`, `files`, `spacelens`,
`maintenance`, `schedule`.

**Utility glyphs:**
`broom`, `trash`, `scan`, `check`, `chevron`, `search`, `folder`, `refresh`,
`shield`, `clock`, `bolt`, `cloud`.

Plus `assets/logo.svg` — the Sweep brand mark (~26px in the sidebar brand). A glossy
"broom/sweep" mark in the accent gradient reads best.

Loader contract (do not break): each file is a single `<svg viewBox="0 0 24 24" …>`;
`icon()` injects raw markup and sets width/height. Use `stroke="currentColor"` /
`fill="currentColor"` so nav colour states work. Provide a `viewBox`.

---

## 9. Screen agent checklist (per screen)

For each `screens/<name>.ts` (keep `render<Name>(root, api)` export + all api calls):

1. Build the **idle/hero** state with the §4a grammar using the screen's
   eyebrow/title/sub and the imported hero SVG.
2. Wire the **circular CTA** to the screen's primary api flow (scan/run/clean/etc.).
3. On result, cross-fade to the **results-grid** (§4b) of `.glass` tiles built from
   the api response; keep existing Review/Clean/uninstall/fix actions intact.
4. Use **only** theme vars + neutral tokens for colour. No literal hex in screens.
5. Keep confirm dialogs / toasts / busy spinners as today; just restyle.
6. Respect reduced-motion and focus-visible.
7. `data-theme` is set by the shell — screens do **not** set it.

Per-screen specifics:

- **dashboard**: keep the count-up progress **ring** as the hero focal point; the
  ring doubles as scan/clean state. Chips become result tiles after scan.
- **cleanup**: scan → categorized junk tiles with size + select/clean (`scan`,`clean`).
- **applications**: `apps()` list → app tiles; `footprint`/`uninstall` on review.
- **privacy**: `privacy()` findings → protection tiles.
- **files**: `dupes(path)` → duplicate-set tiles (teal twins).
- **spacelens**: `explore(path)` → treemap/size tiles under the magnifier hero.
- **maintenance**: `diagnose()`/`doctorFix()`/`maintenance(tasks)` → task tiles + bolt.
- **schedule**: `schedule(action, interval)` / `getConfig()` → interval cards + clock.

---

## 10. Quality bar

Production-quality, zero TODOs/lorem, real api wiring kept, accessible (focus-visible,
aria on icons/regions, reduced-motion), smooth 150–300ms transitions. It must look
like a premium commercial Mac app — confident type, deep saturated worlds, glossy
glass, one glowing circular action per idle screen. Independent agents following this
file must produce a visually consistent result.
