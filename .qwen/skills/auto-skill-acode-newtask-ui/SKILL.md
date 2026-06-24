---
name: acode-newtask-ui
description: ACode desktop — the "new task" empty-state lives in two files (EmptyWorkspace.tsx AND EditorPane.tsx ChatView). Title, input card, bottom row, and top-left nav are duplicated and must be kept in sync. The watermarks have DIVERGED (V SVG in EmptyWorkspace, rotated serif "A" in EditorPane). Verification: pnpm typecheck + pnpm build.
source: auto-skill
extracted_at: '2026-06-20T18:10:00.000Z'
---

# ACode desktop — "new task" empty-state UI

## The duplication trap

The "Start a new task in {workspace}" empty state exists in **two** places, kept in sync by hand:

1. `apps/desktop/src/renderer/components/editor/EmptyWorkspace.tsx` — standalone component used by `EditorPane` when `active` prop is set (the "Working on your task…" loading variant) and as the canonical no-workspace empty state.
2. `apps/desktop/src/renderer/components/editor/EditorPane.tsx` — the `ChatView` function (search for `<div className="relative h-full flex flex-col items-center justify-center px-8 -mt-10 overflow-hidden">`) renders the same hero when `messages.length === 0` after a workspace is loaded.

**Rule (duplicated parts):** any change to the **title**, **input card**, **bottom row** (submit button, model picker, access mode, + button), or **top-left nav row** must be applied to **both** files.

**Rule (NOT duplicated — these have diverged):**
- The **watermark** in `EmptyWorkspace.tsx` is a 360×220 outlined V SVG (see "V watermark" below).
- The **watermark** in `EditorPane.tsx` is a large low-opacity serif **"A"** character (see "A watermark" below).
- These are intentionally different designs — do NOT "synchronize" them back to one pattern. If you change the A, change it only in EditorPane.tsx; if you change the V, change it only in EmptyWorkspace.tsx.

Grep landmarks for finding the copies:
- Both: `flex justify-center` near the title, `tracking-tight` on the h1, `bg-acode-bg-secondary border border-acode-border-primary rounded-xl shadow-2xl` on the input card.
- EmptyWorkspace only: the `viewBox="0 0 360 220"` SVG with gradient id `acodeVStroke`.
- EditorPane only: the `fontSize: "min(70vh, 900px)"` span with the letter `A` as its child.

## Icons

- Use `lucide-react` exclusively. Common imports already in `EditorPane.tsx`: `ArrowUp`, `ArrowLeft`, `ArrowRight`, `Plus`, `Shield`, `ChevronDown`, `Loader2`, `FolderOpen`, `Check`, `Hand`, `ClipboardList`, `Settings`, `ShieldCheck`.
- The submit button is an **up arrow** (`<ArrowUp strokeWidth={2.5} />`), NOT a paper plane. The `Send` icon was removed in favor of `ArrowUp` to match the ZCode reference.
- The bottom-left `+` button uses `<Plus className="w-4 h-4" />`, not a `<span>+</span>` text node.

## Theme tokens (from `tailwind.config.js`)

- Backgrounds: `acode-bg-primary` (#0d0d0d), `acode-bg-secondary` (#1a1a1a), `acode-bg-tertiary` (#252525), `acode-bg-hover` (#2a2a2a), `acode-bg-active` (#333333).
- Borders: `acode-border-primary` (#333333), `acode-border-secondary` (#404040).
- Text: `acode-text-primary` (#e0e0e0), `acode-text-secondary` (#a0a0a0), `acode-text-muted` (#666666).
- Accent: `acode-accent-primary` (#4f8ef7), `acode-accent-subtle` (rgba blue at 10%).
- Git-status colors: `acode-git-added` (green), `acode-git-deleted` (red), `acode-git-modified` (amber).

## V watermark — `EmptyWorkspace.tsx` only

Two overlapping outlined parallelograms forming a Z/V, 360×220, with two `linearGradient` defs (one per stripe) fading top-left to bottom-right. Stroke `2.5`, `strokeLinejoin="round"`, gradient stops at `0.18/0.32/0.10` and `0.10/0.24/0.08` opacities. Plus a faint horizontal accent line (`strokeOpacity="0.06"`) at y=100. The gradient `id` is `acodeVStroke` (must be unique in the rendered tree).

## A watermark — `EditorPane.tsx` ChatView only

A single giant serif **"A"** character rendered as a `<span>` inside `absolute inset-0 flex items-center justify-center pointer-events-none select-none`. The character is **rotated 90°** so it reads sideways. Style object:

```ts
{
  fontFamily: "'Newsreader', 'Iowan Old Style', 'Georgia', serif",
  fontSize: "min(95vh, 1300px)",         // huge — scales with viewport height, capped at 1300px
  fontWeight: 300,
  lineHeight: 0.85,
  letterSpacing: "-0.06em",
  opacity: 0.07,                          // very subtle — sits behind the foreground content
  transform: "translateY(4%) rotate(90deg)", // 90° clockwise, then nudge down 4%
  userSelect: "none",
}
```

The wrapper lives at the top of the hero; **above it** the parent renders the foreground content with `relative w-full max-w-2xl`.

Tuning rules (small visual adjustments — the user iterates on these constantly):
- **Vertical position**: change the `translateY` percentage. `0%` is centered, positive pushes down, negative pushes up. Move in 2–4% increments.
- **Rotation**: `rotate(90deg)` is clockwise. Use `rotate(-90deg)` for counter-clockwise. `rotate(0deg)` returns to upright. The `translateY` is applied before the rotation in the transform list, so it operates on the unrotated frame.
- **Size**: bump `fontSize` in 5–10vh / 100–200px steps. Watch for horizontal overflow in the editor pane once the rotated A is wider than the viewport — the `min()` cap protects against runaway growth.
- **Do NOT** change `opacity` casually. `0.07` is the right value to keep the A as a watermark rather than foreground content. Raising it to 0.15+ starts competing with the title.

Quick recipes:
| Want | Change |
| --- | --- |
| A bit higher | `translateY(4%)` → `translateY(0%)` or `-4%` |
| A bit lower | `translateY(4%)` → `translateY(8%)` or `12%` |
| Bigger | `min(95vh, 1300px)` → `min(100vh, 1400px)` |
| Smaller | `min(95vh, 1300px)` → `min(85vh, 1100px)` |
| Upright | drop `rotate(90deg)` |

## Title typography (BOTH files)

Serif, `text-4xl tracking-tight`, font-weight 500. Inline style with a fallback chain (don't add a font dependency):
```
fontFamily: "'Newsreader', 'Iowan Old Style', 'Georgia', serif"
```

## Top-left nav row (BOTH files)

A slim row with four 7×7 buttons: sidebar toggle (custom 2-stroke SVG), `ArrowLeft`, `ArrowRight`, and a circled `Plus` ("new task"). The circled plus uses `rounded-full border border-acode-border-secondary` to stand out from the other three flat icon buttons.

## Verification

Always run both before declaring done:
```
pnpm typecheck     # from repo root, runs turbo across all packages
pnpm build         # catches Vite/Tailwind issues that tsc misses
```

The most common failure is a leftover import (e.g. swapping `Send` for `ArrowUp` in JSX without updating the `import { ... } from "lucide-react"` line).
