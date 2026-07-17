// Cross-store event bus for decoupled communication
// This replaces direct getState() calls between stores

type EventMap = {
  // Workspace events
  "workspace:switched": { workspaceId: string; path: string };
  "workspace:file-opened": { path: string };

  // UI events
  "ui:view-mode-changed": { mode: "chat" | "editor" };

  // Chat events
  "chat:model-selected": { modelId: string };
};

type EventKey = keyof EventMap;
type EventHandler<T> = (data: T) => void;

class EventBus {
  private handlers = new Map<string, Set<EventHandler<unknown>>>();
  private groups = new Map<string, Set<EventHandler<unknown>>>();

  on<K extends EventKey>(
    event: K,
    handler: EventHandler<EventMap[K]>,
    group?: string,
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<unknown>);

    if (group) {
      if (!this.groups.has(group)) {
        this.groups.set(group, new Set());
      }
      this.groups.get(group)!.add(handler as EventHandler<unknown>);
    }

    return () => {
      this.off(event, handler as EventHandler<EventMap[K]>);
    };
  }

  off<K extends EventKey>(
    event: K,
    handler: EventHandler<EventMap[K]>,
  ): void {
    this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
    for (const [, handlers] of this.groups) {
      handlers.delete(handler as EventHandler<unknown>);
    }
  }

  clearGroup(group: string): void {
    const groupHandlers = this.groups.get(group);
    if (!groupHandlers) return;
    for (const handler of groupHandlers) {
      for (const [, handlers] of this.handlers) {
        handlers.delete(handler);
      }
    }
    this.groups.delete(group);
  }

  emit<K extends EventKey>(event: K, data: EventMap[K]): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[EventBus] Handler error for "${event}":`, err);
        }
      }
    }
  }

  offAll(event?: EventKey): void {
    if (event) this.handlers.delete(event);
    else {
      this.handlers.clear();
      this.groups.clear();
    }
  }
}

export const eventBus = new EventBus();
