---
name: acode-panel-resize
description: ACode desktop — react-resizable-panels v2 panel system architecture (sidebar / editor / right-panel). Required props, bidirectional store↔panel sync, and the .panel-resizer CSS pattern. Apply when modifying App.tsx PanelGroup, the panel-resizer CSS, or any panel visibility state.
source: auto-skill
extracted_at: '2026-06-20T11:26:52.998Z'
---

# ACode desktop — panel resize architecture

The three-pane layout (sidebar / editor / right-panel) lives in `apps/desktop/src/renderer/App.tsx` and uses `react-resizable-panels@2.1.9`. Visibility is driven by the `useUI` Zustand store (`sidebarOpen`, `rightPanelOpen`). The CSS for the resize handle lives in `apps/desktop/src/renderer/index.css` under `.panel-resizer`.

## The non-negotiable rules

### 1. Always mount all three panels — never conditionally render

`PanelGroup` is wrapped in `<PanelGroup direction="horizontal" autoSaveId="acode-main-layout">`. The `autoSaveId` persists per-panel sizes in `localStorage` keyed by panel `id`. **Unmounting a panel wipes its persisted size and breaks the drag-to-collapse UX** (drag below `minSize` should auto-collapse to `collapsedSize`, not unmount).

```tsx
// WRONG — breaks autoSave, causes layout jumps on toggle
{sidebarOpen && <Panel id="sidebar" defaultSize={20}><Sidebar /></Panel>}

// RIGHT — always mounted, toggled via ref + collapsible
<Panel
  ref={sidebarPanelRef}
  id="sidebar"
  order={1}
  defaultSize={20}
  minSize={12}
  maxSize={32}
  collapsible
  collapsedSize={0}
  onCollapse={() => useUI.getState().setSidebarOpen(false)}
  onExpand={() => useUI.getState().setSidebarOpen(true)}
>
  <Sidebar />
</Panel>
```

### 2. Every Panel needs stable `id` + `order`

Without `id`, `autoSaveId` cannot restore sizes after refresh. Without `order`, the `collapsible` collapse animation can render in the wrong slot.

### 3. Bidirectional sync between store and panel

The store is the source of truth for keyboard shortcuts (`⌘B`, `⌘\`) and toolbar buttons. The panel is the source of truth for drag-to-collapse. They must stay in sync.

```tsx
// Store → Panel: imperative ref effect
useEffect(() => {
  const panel = sidebarPanelRef.current;
  if (!panel) return;
  if (sidebarOpen) panel.expand();
  else panel.collapse();
}, [sidebarOpen]);

// Panel → Store: callbacks on the Panel
onCollapse={() => useUI.getState().setSidebarOpen(false)}
onExpand={() => useUI.getState().setSidebarOpen(true)}
```

`panel.expand()` / `panel.collapse()` are idempotent — calling them when already in the target state is a true no-op, so the two-way sync does not loop. Zustand's `set` also bails out via `Object.is` when the value is unchanged.

### 4. Disable the resize handle when its adjacent panel is collapsed

```tsx
<PanelResizeHandle
  className="panel-resizer horizontal"
  hitAreaMargins={{ coarse: 6, fine: 4 }}
  disabled={!sidebarOpen}
/>
```

Without this, dragging a 0-width divider would fight `minSize` and stutter.

## The `.panel-resizer` CSS — the four rules

In `apps/desktop/src/renderer/index.css` under `@layer components`:

1. **Base handle is 4px wide**, not 1px. 1px is ungrabbable; 4px + the `::after` extension gives a 10px effective hit zone. `!important` is required to override Tailwind's `w-px` if anyone adds it.
2. **Visual hairline lives on `::before`** with `pointer-events: none` so it never intercepts clicks. 1px wide, low contrast (`var(--acode-border)`).
3. **Hover/active highlight is on `::before`** only (1px → 2px, `var(--acode-accent)` color). Do NOT add `transition: width` — it retriggers on every mouse micro-movement across the divider and produces the "stutter" / "lag" feeling users report. The instant color + width change is what reads as responsive.
4. **`.horizontal` and `.vertical` modifiers are added via the className prop**, not by the library. `PanelGroup` does not set them automatically. So `<PanelResizeHandle className="panel-resizer horizontal" />` is correct; the library uses `data-panel-resize-handle-enabled` / `data-resize-handle-active` data attributes for state, not class names.

## Adding a new panel

If you ever need a 4th panel (e.g. a bottom terminal), follow the same pattern: stable `id` + `order`, `collapsible` + `collapsedSize={0}` if it can hide, an entry in the `useUI` store for its visibility, a `useRef<ImperativePanelHandle>`, a sync `useEffect`, and `onCollapse`/`onExpand` callbacks. Always keep the editor (`id="editor"`) as the non-collapsible center panel so the layout has a stable anchor.

## Verification

Always run both before declaring done:
```
pnpm typecheck
pnpm build
```

Then grep the built CSS to confirm the new rules are present:
```
grep -oE '\.panel-resizer[^{]*\{[^}]*\}' apps/desktop/out/renderer/assets/index-*.css
```

If `grep` returns nothing, Tailwind's purger ate your `@layer components` rule — most often because the selector string is wrong or the file isn't in `content` in `apps/desktop/tailwind.config.js` (it is, by default — `"./src/renderer/**/*.{ts,tsx}"`).
