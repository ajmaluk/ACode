# Dalam Codebase Deep Scan - Lint Issues Report
Generated: 2025-06-26 00:29

## Summary
Total issues found: **175** (68 errors, 107 warnings)

## Critical Errors to Fix

### 1. React Hooks Violations
- **PromptAutocomplete.tsx:163** - Cannot update ref during render (`activeIdxRef.current = activeIdx`)
- **PermissionDialog.tsx:15** - Cannot update ref during render (`selectedRef.current = selected`)
- **EditorPane.tsx:314** - Cannot update ref during render (`hasMessagesRef.current = hasMessages`)
- **Editor.tsx:108** - Calling setState synchronously within an effect
- **PromptAutocomplete.tsx:217** - Calling setState synchronously within an effect
- **PermissionDialog.tsx:11** - Calling setState synchronously within an effect
- **CommandPalette.tsx:42** - Calling setState synchronously within an effect
- **SettingsModal.tsx:431** - Calling setState synchronously within an effect
- **SettingsModal.tsx:1454** - Calling setState synchronously within an effect
- **Sidebar.tsx:80** - Calling setState synchronously within an effect
- **QuestionDialog.tsx:15** - Calling setState synchronously within an effect
- **EditorPane.tsx:1012** - Cannot call impure function (Date.now()) during render
- **Sidebar.tsx:139** - Cannot call impure function (Date.now()) during render
- **FileTree.tsx:101,183,218** - Cannot create components during render (Icon component)
- **PermissionDialog.tsx:25,34,65** - Variable access before declaration

### 2. Missing Error Causes
- **dalamAPI.ts** - Multiple locations (1196,1204,1212,1220,1228,1236,1244,2023) - `preserve-caught-error`

### 3. Code Quality Issues
- **dalamAPI.ts** - Multiple empty block statements (no-empty rule)
- **dalamAPI.ts:1967** - Promise executor should not be async
- **dreamAgent.ts:283-284** - Unnecessary escape characters
- **memoryStore.ts:585** - Unnecessary escape character
- **dalamAPI.ts:1544** - Unnecessary escape character

### 4. Unused Imports/Variables
Multiple files with unused imports and variables that should be prefixed with `_` or removed.

### 5. Type Safety
Multiple `any` types that should be properly typed (dalamAPI.ts, useAppStore.ts, hookListeners.ts, etc.)

## Fix Strategy
1. Fix React Hooks violations by using useLayoutEffect/useEffect properly
2. Move variable declarations before usage
3. Replace impure render calls with memoized values
4. Move component creation outside of render
5. Add proper error causes
6. Remove empty blocks or add comments
7. Fix async promise executors
8. Clean up escape characters
9. Remove unused imports and variables
10. Replace `any` with proper types