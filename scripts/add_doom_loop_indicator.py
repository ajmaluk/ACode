#!/usr/bin/env python3
"""Add doom loop visual indicator to StatusBar and expose doom loop state from ChatState."""
import sys

with open('apps/desktop/src/renderer/store/useAppStore.ts', 'r') as f:
    content = f.read()

changes = []

# ===========================================================================
# 1. Add doomLoopWarningCount to ChatState type
# ===========================================================================
chat_state_marker = "  _safetyTimer: ReturnType<typeof setTimeout> | null;\n  _sendInProgress: boolean;"
if chat_state_marker in content:
    new_state = "  _safetyTimer: ReturnType<typeof setTimeout> | null;\n  _sendInProgress: boolean;\n  doomLoopWarningCount: number;"
    content = content.replace(chat_state_marker, new_state, 1)
    changes.append("OK: Added doomLoopWarningCount to ChatState type")
else:
    changes.append("FAIL: ChatState _safetyTimer marker not found")

# ===========================================================================
# 2. Add doomLoopWarningCount initial value to useChat store
# ===========================================================================
init_marker = "  _safetyTimer: null,\n  _sendInProgress: false,"
if init_marker in content:
    new_init = "  _safetyTimer: null,\n  _sendInProgress: false,\n  doomLoopWarningCount: 0,"
    content = content.replace(init_marker, new_init, 1)
    changes.append("OK: Added doomLoopWarningCount initial value to useChat store")
else:
    changes.append("FAIL: useChat initial state marker not found")

# ===========================================================================
# 3. Update tool-call handler to update doomLoopWarningCount when doom loop detected
# ===========================================================================
# Find the tool-call doom loop check and add state update
old_doom_check = 'const doomResult = _checkDoomLoop(sessionId, tool.name, tool.args);'
if old_doom_check in content:
    idx = content.index(old_doom_check)
    # Find the set() call that adds the doom warning message
    set_call = content.find("set((s) => ({", idx)
    if set_call != -1:
        # Find the closing of this set() call
        close_idx = content.find("}));", set_call)
        if close_idx != -1:
            # Insert doomLoopWarningCount update into the set() call
            old_set_content = content[set_call:close_idx + 3]
            # Add doomLoopWarningCount to the set() call
            new_set_content = old_set_content.replace(
                "messages: [...s.messages, doomWarning],",
                "messages: [...s.messages, doomWarning],\n              doomLoopWarningCount: Math.max(s.doomLoopWarningCount + 1, 1),"
            )
            if new_set_content != old_set_content:
                content = content[:set_call] + new_set_content + content[close_idx + 3:]
                changes.append("OK: Added doomLoopWarningCount update in tool-call handler")
            else:
                changes.append("WARN: Could not inject doomLoopWarningCount into set() call")
        else:
            changes.append("WARN: set() closing not found")
    else:
        changes.append("WARN: set() call not found after doom check")
else:
    changes.append("FAIL: doomResult check not found in tool-call handler")

# ===========================================================================
# 4. Add reset of doomLoopWarningCount on successful tool result
# ===========================================================================
tool_result_marker = "_clearToolFailure(trackingSid, toolResultTc.name, toolResultTc.args);"
if tool_result_marker in content:
    idx = content.index(tool_result_marker)
    # Find the set() call before this that updates pendingToolCalls
    # We need to add doomLoopWarningCount reset when a tool succeeds
    reset_code = "\n          // Reset doom loop warning count on successful tool execution\n          set((s) => ({ doomLoopWarningCount: Math.max(0, s.doomLoopWarningCount - 1) }));"
    content = content[:idx] + tool_result_marker + reset_code + content[idx + len(tool_result_marker):]
    changes.append("OK: Added doomLoopWarningCount reset on tool success")
else:
    changes.append("FAIL: _clearToolFailure not found in tool-result handler")

# ===========================================================================
# 5. Reset doomLoopWarningCount when starting a new chat
# ===========================================================================
newchat_marker = "_clearDoomLoopState(session.id);"
if newchat_marker in content:
    idx = content.index(newchat_marker)
    end = idx + len(newchat_marker)
    content = content[:end] + "\n      set({ doomLoopWarningCount: 0 });" + content[end:]
    changes.append("OK: Added doomLoopWarningCount reset in newChat")
else:
    changes.append("WARN: newChat _clearDoomLoopState not found")

# ===========================================================================
# 6. Reset doomLoopWarningCount when removing a session
# ===========================================================================
remove_session_marker = "_clearDoomLoopState(id);"
if remove_session_marker in content:
    idx = content.index(remove_session_marker)
    end = idx + len(remove_session_marker)
    content = content[:end] + "\n    set({ doomLoopWarningCount: 0 });" + content[end:]
    changes.append("OK: Added doomLoopWarningCount reset in removeSession")
else:
    changes.append("WARN: removeSession _clearDoomLoopState not found")

# ===========================================================================
# 7. Reset doomLoopWarningCount on abort
# ===========================================================================
abort_marker = "void get().abort(sessionId);"
if abort_marker in content:
    idx = content.index(abort_marker)
    end = idx + len(abort_marker)
    content = content[:end] + "\n              set({ doomLoopWarningCount: 0 });" + content[end:]
    changes.append("OK: Added doomLoopWarningCount reset on abort")
else:
    changes.append("WARN: abort marker not found")

with open('apps/desktop/src/renderer/store/useAppStore.ts', 'w') as f:
    f.write(content)

for c in changes:
    print(c)
