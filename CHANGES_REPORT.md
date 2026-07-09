# Changes Report — Running Log

This file is a running log of the multi-session deep-scan/fix effort on Dalam.
Append entries chronologically; do not overwrite prior sessions' entries.

---

## Session 9 (2026-07-08)

### Final Deep Scan — Tool Calling & Task Management Fixes

1. **Fixed edit_file regex truncating replacement text** (`dalamAPI.ts`) — HIGH
   - Changed from non-greedy to greedy match for content between tags
   - Prevents silent file corruption when replacement contains `</edit_file>`

2. **Added `create_file` to KNOWN_TOOL_NAMES** (`dalamAPI.ts`) — MEDIUM
   - Tool was documented in system prompt but silently dropped during parsing

3. **Fixed cumulative timeout during tool approval wait** (`useAppStore.ts`) — MEDIUM
   - 10-min cumulative timeout now skips when pending tool approvals exist

4. **Added Groq as default provider** (`useAppStore.ts`) — FEATURE
   - Added Groq with 4 models (Llama 3.3 70B, Llama 3.1 8B, Mixtral 8x7B, Gemma 2 9B)
   - Correct context windows configured for each model
   - Groq streaming and tool calls verified working
   - Prevents force-killing stream during user review

### Previous Session Fixes (Complete List)

## Session 8 (2026-07-08)

### Final Deep Scan — Logic Error Fixes

1. **Fixed stale file entries never cleaned up in codeIndex.ts** — MEDIUM
   - Added cleanup of orphaned entries for deleted files at start of `indexWorkspace()`

2. **Fixed failed undo corrupting stack ordering** (`changeStack.ts`) — MEDIUM
   - Failed undo now pushes change back directly instead of using `recordChange`
   - Preserves original timestamp and stack ordering

3. **Fixed token cache storing text twice** (`contextManager.ts`) — LOW
   - Removed redundant `text` field from `TokenCacheEntry` — key already contains it
   - ~2x memory reduction for token cache

### Previous Session Fixes (Complete List)

**Session 7:**
- Improved session persistence (IndexedDB primary storage)
- Fixed 429 rate limit retry handling
- Improved fast provider rate limiting (Groq/Together/Fireworks)
- Fixed SSE parser data loss with interleaved comment lines
- Fixed `extractRetryAfter` ms-as-seconds bug
- Fixed dead code double-push in open_url handler
- Fixed duplicate tool results in compaction prompt
- Fixed misleading comments on boundary alignment
- Fixed 0-based/1-based occurrence indexing mismatch

**Session 6:**
- Fixed broken regexes for 7 tools
- Fixed unreachable Anthropic token usage parsing
- Fixed database.ts race condition
- Fixed executeWithTimeout abort handler hang
- Fixed MCP HTTP retry type mismatch
- Fixed updater.ts onProgress
- Fixed connectors.ts CronConnector timer leak
- Fixed tool call arg buffer flushing
- Fixed dreamAgent.ts stale similarity score
- Fixed dreamAgent.ts purgedCount

**Session 5:**
- Fixed `processPendingWrites()` never called
- Fixed `purgeStale()` filename mismatch
- Fixed `compactSessionHistory()` stale `shouldPrune`
- Added global cap to `_pendingWrites`
- Added missing YAML unescaping
- Fixed ABORT event to clear diffToToolCall
- Added `_toolCosts` cleanup to session removal
- Improved `retryWithBackoff` with error classification
- Expanded context overflow patterns (30+ patterns)
- Enhanced error patterns
- Added instruction caching
- Added `clearInstructionCache()`
- Added unlimited context management functions
- Updated compaction template

### API Verification
- NVIDIA API: Streaming, tool calls, large context all working
- Groq API: Streaming, tool calls, rate limiting all working

**Final status:** 1,109 tests passing (2 skipped), 0 TypeScript errors, all features verified correct with NVIDIA and Groq APIs.
