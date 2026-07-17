import { create } from "zustand";
import { useChat } from "./useChat";

const devWarn = import.meta.env.DEV
  ? (...args: unknown[]) => console.warn(...args)
  : () => {};

export type QuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type QuestionRequest = {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  allowFreeText?: boolean;
  type?: "text" | "number" | "confirm";
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  workspaceName?: string;
  branch?: string;
  createdAt: number;
};

declare const __VITE_HMR__: boolean;

type PendingResolve = ((a: { selectedLabel: string; customText?: string } | null) => void) | null;
type BatchResolves = ((a: { selectedLabel: string; customText?: string } | null) => void)[];

/**
 * Module-level holders for promise resolve functions used by ask/askBatch.
 * These are stored outside Zustand because they hold function references (Promise resolve callbacks)
 * that Zustand serialization assumptions don't handle well.
 *
 * To survive HMR (Vite hot reload), we store them on a shared mutable object rather than
 * as bare `let` declarations. On hot reload, the old module's closures reference the old
 * variable, but the new module reads from the same shared object via module getter functions.
 */
const _resolverState: { pendingResolve: PendingResolve; batchResolves: BatchResolves } = {
  pendingResolve: null,
  batchResolves: [],
};

type QuestionState = {
  request: QuestionRequest | null;
  queue: QuestionRequest[];
  currentIndex: number;
  ask: (req: Omit<QuestionRequest, "id" | "createdAt">) => Promise<{ selectedLabel: string; customText?: string } | null>;
  askBatch: (reqs: Omit<QuestionRequest, "id" | "createdAt">[]) => Promise<({ selectedLabel: string; customText?: string } | null)[]>;
  resolve: (answer: { selectedLabel: string; customText?: string } | null) => void;
  goNext: () => void;
  goPrev: () => void;
};

export const useQuestion = create<QuestionState>((set, get) => ({
  request: null,
  queue: [],
  currentIndex: 0,

  ask(req) {
    const r = _resolverState.pendingResolve;
    if (r) { r(null); _resolverState.pendingResolve = null; }
    const full: QuestionRequest = {
      ...req,
      id: "q-" + crypto.randomUUID(),
      createdAt: Date.now(),
    };
    set({ request: full, queue: [full], currentIndex: 0 });
    return new Promise<{ selectedLabel: string; customText?: string } | null>((resolve) => {
      _resolverState.pendingResolve = resolve;
    });
  },

  askBatch(reqs) {
    const r = _resolverState.pendingResolve;
    if (r) { r(null); _resolverState.pendingResolve = null; }
    _resolverState.batchResolves = [];

    const fullReqs = reqs.map((req) => ({
      ...req,
      id: "q-" + crypto.randomUUID(),
      createdAt: Date.now(),
    }));

    const batch = fullReqs.slice(0, 100);
    set({ request: batch[0], queue: batch, currentIndex: 0 });

    return Promise.all(
      batch.map(
        () =>
          new Promise<{ selectedLabel: string; customText?: string } | null>((resolve) => {
            _resolverState.batchResolves.push(resolve);
          }),
      ),
    );
  },

  resolve(answer) {
    const { queue, currentIndex } = get();
    const r = _resolverState.pendingResolve;
    _resolverState.pendingResolve = null;

    if (queue.length > 0 && _resolverState.batchResolves.length > 0) {
      const batchResolve = _resolverState.batchResolves[currentIndex];
      if (batchResolve) batchResolve(answer);

      if (currentIndex < queue.length - 1) {
        set({ currentIndex: currentIndex + 1, request: queue[currentIndex + 1] });
        return;
      }
      set({ request: null, queue: [], currentIndex: 0 });
      _resolverState.batchResolves = [];
    } else {
      if (r) r(answer);
      set({ request: null });
    }

    try {
      const activeSessionId = useChat.getState().activeSessionId;
      if (activeSessionId) {
        useChat.getState().setSessionStatus(activeSessionId, "running");
      }
    } catch (e) {
      if (import.meta.env.DEV) devWarn("[Store] activeSessionId error:", e);
    }
  },

  goNext() {
    const { queue, currentIndex } = get();
    if (currentIndex < queue.length - 1) {
      const batchResolve = _resolverState.batchResolves[currentIndex];
      if (batchResolve) batchResolve(null);
      set({ currentIndex: currentIndex + 1, request: queue[currentIndex + 1] });
    }
  },

  goPrev() {
    const { currentIndex } = get();
    if (currentIndex > 0) {
      const { queue } = get();
      const batchResolve = _resolverState.batchResolves[currentIndex];
      if (batchResolve) batchResolve(null);
      set({ currentIndex: currentIndex - 1, request: queue[currentIndex - 1] });
    }
  },
}));
