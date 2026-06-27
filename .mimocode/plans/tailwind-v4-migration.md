# Tailwind CSS v3 → v4 Migration Plan

## Current State

| Item | Value |
|------|-------|
| **tailwindcss** | `^3.4.17` |
| **postcss** | `^8.4.49` |
| **autoprefixer** | `^10.4.20` |
| **Config file** | `apps/desktop/tailwind.config.js` |
| **PostCSS config** | `apps/desktop/postcss.config.js` |
| **Main CSS** | `apps/desktop/src/renderer/index.css` |
| **`@apply` usages** | 0 ✅ (none to migrate) |
| **`dark:` variant usages** | 1 (minimal) |
| **ring/shadow/outline utilities** | ~246 (many need renaming) |

### Key Observations

- The project already uses CSS custom properties extensively (`--dalam-*`), which aligns perfectly with v4's CSS-first approach.
- Zero `@apply` directives means no `@apply` migration needed.
- The `darkMode: "class"` config and `[data-theme="dark"]` / `[data-theme="light"]` selectors are used — v4 defaults to `prefers-color-scheme` so this needs manual configuration.
- The `tailwind.config.js` defines custom `dalam` colors, fonts, and animations that must be converted to `@theme` CSS variables.

---

## Phase 1: Upgrade Dependencies

### 1.1 Install new packages
```bash
# Remove old PostCSS-based setup
pnpm remove tailwindcss autoprefixer postcss -w apps/desktop

# Install Tailwind v4 with Vite plugin (recommended for Vite projects)
pnpm add -D tailwindcss@latest @tailwindcss/vite@latest -w apps/desktop
```

### 1.2 Update Vite config
Replace the PostCSS-based Tailwind with the Vite plugin:

**Before** (`vite.config.ts`):
```ts
import tailwindcss from 'tailwindcss'  // if imported
// PostCSS handles tailwind via postcss.config.js
```

**After**:
```ts
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // ... other plugins
  ],
})
```

### 1.3 Remove obsolete files
- Delete `apps/desktop/postcss.config.js` (no longer needed with Vite plugin)
- Delete `apps/desktop/tailwind.config.js` (replaced by CSS `@theme`)

---

## Phase 2: Migrate CSS Configuration

### 2.1 Replace `@tailwind` directives

**Before**:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**After**:
```css
@import "tailwindcss";
```

### 2.2 Convert `tailwind.config.js` → `@theme` block

Map every value from `tailwind.config.js` to CSS variables inside `@theme`:

```css
@import "tailwindcss";

@theme {
  /* ── Colors ── */
  --color-dalam-bg-primary: #0d0d0d;
  --color-dalam-bg-secondary: #1a1a1a;
  --color-dalam-bg-tertiary: #252525;
  --color-dalam-bg-hover: #2a2a2a;
  --color-dalam-bg-active: #333333;
  --color-dalam-border-primary: #333333;
  --color-dalam-border-secondary: #404040;
  --color-dalam-border-focus: #4f8ef7;
  --color-dalam-text-primary: #e0e0e0;
  --color-dalam-text-secondary: #a0a0a0;
  --color-dalam-text-muted: #666666;
  --color-dalam-text-disabled: #444444;
  --color-dalam-accent-primary: #4f8ef7;
  --color-dalam-accent-hover: #3a7de4;
  --color-dalam-accent-subtle: rgba(79, 142, 247, 0.1);
  --color-dalam-git-modified: #e2c08d;
  --color-dalam-git-added: #73c991;
  --color-dalam-git-deleted: #f44336;
  --color-dalam-git-untracked: #73c991;

  /* ── Fonts ── */
  --font-mono: "JetBrains Mono", "SF Mono", "Menlo", monospace;
  --font-sans: "Inter", system-ui, sans-serif;

  /* ── Animations ── */
  --animate-pulse-soft: pulse-soft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  --animate-fade-in: fade-in 150ms ease-out;
  --animate-slide-up: slide-up 200ms ease-out;
}

/* ── Keyframes ── */
@keyframes pulse-soft {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

### 2.3 Configure dark mode

Since the project uses `[data-theme="dark"]` / `[data-theme="light"]` (not `.dark` class), add this to the CSS:

```css
@variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

Or use `@custom-variant` for more control:
```css
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

### 2.4 Add content source scanning

```css
@source "../../src/renderer/**/*.{ts,tsx}";
@source "../../index.html";
```

---

## Phase 3: Fix Renamed Utilities

These are the most impactful breaking changes — **~246 usages** to audit:

| v3 Utility | v4 Utility | Impact |
|------------|-----------|--------|
| `shadow-sm` | `shadow-xs` | HIGH — used in cards, panels |
| `shadow-md` | `shadow-sm` | HIGH — used in modals, popovers |
| `shadow-lg` | `shadow-md` | MEDIUM |
| `shadow-xl` | `shadow-lg` | LOW |
| `shadow-2xl` | `shadow-xl` | LOW |
| `ring` (3px default) | `ring-3` (1px default) | HIGH — ring width default changed |
| `outline-none` | `outline-hidden` | MEDIUM — focus styles |
| `text-sm/6` (line-height) | `text-sm/6` (same, but verify) | LOW |

### Migration strategy for ring utilities
The default `ring` width changed from 3px to 1px. Every bare `ring` class needs to become `ring-3` to preserve current appearance:

```bash
# Find all ring usages
grep -rn '\bring\b' src/ --include='*.tsx' | grep -v 'ring-[0-9]'
```

### Migration strategy for shadow utilities
Rename all shadow utilities one step down:
```bash
# Dry run — check what needs changing
grep -rn 'shadow-sm' src/ --include='*.tsx'  # → shadow-xs
grep -rn 'shadow-md' src/ --include='*.tsx'  # → shadow-sm
grep -rn 'shadow-lg' src/ --include='*.tsx'  # → shadow-md
```

---

## Phase 4: Fix Preflight Defaults

v4 changes some Preflight (base reset) defaults:

| Change | v3 Default | v4 Default | Fix |
|--------|-----------|-----------|-----|
| `button` cursor | `pointer` | `default` | Add `cursor-pointer` to buttons or `@layer base { button { cursor: pointer; } }` |
| `legend` padding | `0 0.5rem` | `0` | Verify legends look correct |
| `img` opacity | `1` | `opacity: 1` (same) | No change needed |
| `hr` border | none | `border-top: 1px solid` | May need to adjust |
| `summary` cursor | `default` | `pointer` | Usually fine |

The project already has a global button transition rule. Verify cursor behavior post-migration.

---

## Phase 5: Handle Tailwind Palette Color Overrides

The `index.css` has extensive `[data-theme="light"]` overrides for Tailwind palette colors (e.g., `.text-amber-400`, `.text-emerald-400`). In v4, these palette colors are available as CSS variables too, so the overrides can be simplified:

```css
/* Instead of overriding individual classes, override the CSS variables */
[data-theme="light"] {
  --color-amber-400: #b45309;
  --color-amber-300: #b45309;
  --color-emerald-400: #047857;
  /* etc. */
}
```

---

## Phase 6: Automated Migration Tool

Tailwind provides an official upgrade CLI:

```bash
cd apps/desktop
npx @tailwindcss/upgrade
```

This tool will:
- ✅ Update `package.json` dependencies
- ✅ Migrate `tailwind.config.js` → CSS `@theme` block
- ✅ Replace `@tailwind` directives with `@import "tailwindcss"`
- ✅ Rename breaking-change utilities in all files
- ✅ Update PostCSS config

**Run this on a new git branch and review the diff carefully.**

---

## Phase 7: Validation

After migration, verify:

1. **TypeScript**: `npx tsc --noEmit` — no errors
2. **Tests**: `npx vitest run` — all 230 tests pass
3. **Visual regression**: Launch the app and verify:
   - Dark theme renders correctly
   - Light theme renders correctly
   - Custom `dalam` color utilities work (`bg-dalam-bg-primary`, etc.)
   - Monospace font renders in code blocks
   - Scrollbars, focus rings, and transitions work
   - Shadow levels on modals, popovers, and cards look correct
   - Ring widths on focused inputs/buttons look correct
4. **Lint**: `npx eslint src/` — no new warnings
5. **Bundle size**: Compare CSS output size (v4 is typically smaller)

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| 246 ring/shadow utility renames | HIGH | Run `@tailwindcss/upgrade` CLI, then manual audit |
| Dark mode selector change | HIGH | Use `@variant dark` with `[data-theme]` selector |
| Preflight cursor change on buttons | MEDIUM | Add global `button { cursor: pointer; }` in `@layer base` |
| Custom utility classes in `@layer utilities` | LOW | Verify they still work (v4 supports `@layer`) |
| PostCSS removal | LOW | Switch to `@tailwindcss/vite` plugin |
| `@layer` behavior changes | LOW | v4 preserves `@layer base/components/utilities` |

---

## Estimated Effort

| Phase | Time |
|-------|------|
| Phase 1: Dependencies | 15 min |
| Phase 2: CSS config migration | 1-2 hours |
| Phase 3: Rename utilities | 1-2 hours (mostly automated) |
| Phase 4: Preflight fixes | 30 min |
| Phase 5: Color overrides | 30 min |
| Phase 6: Automated tool | 30 min (review diffs) |
| Phase 7: Visual testing | 1-2 hours |
| **Total** | **4-7 hours** |

---

## Recommendation

**Use the automated `npx @tailwindcss/upgrade` tool first**, then manually handle:
1. The dark mode variant configuration (`[data-theme]` selector)
2. Visual regression testing across both themes
3. The preflight cursor change for buttons

The project is in a good position for migration because:
- Zero `@apply` usage
- Only 1 `dark:` variant usage
- CSS variables are already used extensively
- Modern Vite + React stack (Tailwind v4 has first-class Vite support)
