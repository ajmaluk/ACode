import { useState, useRef, useCallback, useEffect } from "react";
import { useChat } from "@/store/useAppStore";
import { GripVertical, ArrowUp, Pencil, Trash2 } from "lucide-react";

export function MessageQueue() {
  const messageQueue = useChat((s) => s.messageQueue);
  const removeFromQueue = useChat((s) => s.removeFromQueue);
  const reorderQueue = useChat((s) => s.reorderQueue);
  const editQueueItem = useChat((s) => s.editQueueItem);
  const steerQueueItem = useChat((s) => s.steerQueueItem);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const editValueRef = useRef(editValue);
  useEffect(() => {
    editValueRef.current = editValue;
  }, [editValue]);

  const handleDragStart = useCallback((idx: number) => {
    dragItem.current = idx;
  }, []);

  const handleDragEnter = useCallback((idx: number) => {
    dragOverItem.current = idx;
  }, []);

  const handleDragEnd = useCallback(() => {
    if (
      dragItem.current !== null &&
      dragOverItem.current !== null &&
      dragItem.current !== dragOverItem.current
    ) {
      reorderQueue(dragItem.current, dragOverItem.current);
    }
    dragItem.current = null;
    dragOverItem.current = null;
  }, [reorderQueue]);

  const handleEdit = useCallback((id: string, content: string) => {
    setEditingId(id);
    setEditValue(content);
  }, []);

  const handleSaveEdit = useCallback(
    (id: string) => {
      const value = editValueRef.current;
      if (value.trim() === "") return;
      editQueueItem(id, value);
      setEditingId(null);
      setEditValue("");
    },
    [editQueueItem],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, idx: number) => {
      if (e.altKey && e.key === "ArrowUp" && idx > 0) {
        e.preventDefault();
        reorderQueue(idx, idx - 1);
      }
      if (e.altKey && e.key === "ArrowDown" && idx < messageQueue.length - 1) {
        e.preventDefault();
        reorderQueue(idx, idx + 1);
      }
    },
    [reorderQueue, messageQueue.length],
  );

  if (messageQueue.length === 0) return null;

  return (
    <div className="space-y-1 mb-2" role="list" aria-label="Message queue">
      {messageQueue.map((item, idx) => (
        <div
          key={item.id}
          role="listitem"
          draggable
          onDragStart={() => handleDragStart(idx)}
          onDragEnter={() => handleDragEnter(idx)}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => e.preventDefault()}
          onKeyDown={(e) => handleKeyDown(e, idx)}
          className="flex items-center gap-2 px-3 py-2 bg-dalam-bg-secondary border border-dalam-border-primary rounded-lg group cursor-move hover:border-dalam-accent-primary/30 transition-colors"
        >
          {/* Drag handle */}
          <div className="text-dalam-text-muted/40 cursor-grab active:cursor-grabbing" aria-hidden="true">
            <GripVertical className="w-4 h-4" />
          </div>

          {/* Content */}
          {editingId === item.id ? (
            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveEdit(item.id);
                if (e.key === "Escape") setEditingId(null);
              }}
              className="flex-1 bg-dalam-bg-input border border-dalam-border-primary rounded px-2 py-1 text-sm text-dalam-text-primary outline-none focus:border-dalam-accent-primary"
            />
          ) : (
            <span className="flex-1 text-sm text-dalam-text-primary truncate">
              {item.content}
            </span>
          )}

          {/* Actions */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              aria-label="Send now"
              onClick={() => { void steerQueueItem(item.id); }}
              className="flex items-center gap-1 min-w-[44px] min-h-[28px] justify-center px-2 py-1 text-[11px] text-dalam-text-secondary hover:text-dalam-text-primary hover:bg-dalam-bg-hover rounded transition-colors"
              title="Send now (steer)"
            >
              <ArrowUp className="w-3 h-3" aria-hidden="true" />
              Steer
            </button>
            <button
              type="button"
              aria-label={editingId === item.id ? "Save" : "Edit"}
              onClick={() =>
                editingId === item.id
                  ? handleSaveEdit(item.id)
                  : handleEdit(item.id, item.content)
              }
              className="min-w-[28px] min-h-[28px] flex items-center justify-center text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover rounded transition-colors"
              title={editingId === item.id ? "Save" : "Edit"}
            >
              <Pencil className="w-3 h-3" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Remove from queue"
              onClick={() => removeFromQueue(item.id)}
              className="min-w-[28px] min-h-[28px] flex items-center justify-center text-dalam-text-muted hover:text-dalam-git-deleted hover:bg-dalam-bg-hover rounded transition-colors"
              title="Remove from queue"
            >
              <Trash2 className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
