// Cross-store event bus for decoupled communication
// This replaces direct getState() calls between stores

type EventMap = {
  // Workspace events
  "workspace:switched": { workspaceId: string; path: string };
  "workspace:file-opened": { path: string };

  // UI events
  "ui:view-mode-changed": { mode: "chat" | "editor" };

  // Chat events
  "chat:streaming-started": { sessionId: string };
  "chat:streaming-stopped": { sessionId: string };
  "chat:model-selected": { modelId: string };

  // Settings events
  "settings:loaded": { settings: Record<string, unknown> };
};

type EventKey = keyof EventMap;
type EventHandler<T> = (data: T) => void;

class EventBus {
  private handlers = new Map<string, Set<EventHandler<unknown>>>();

  on<K extends EventKey>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<unknown>);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
    };
  }

  emit<K extends EventKey>(event: K, data: EventMap[K]): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }
}

export const eventBus = new EventBus();
