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

type QuestionState = {
  request: QuestionRequest | null;
  ask: (req: Omit<QuestionRequest, "id" | "createdAt">) => Promise<{ selectedLabel: string; customText?: string } | null>;
  resolve: (answer: { selectedLabel: string; customText?: string } | null) => void;
};

export const useQuestion = create<QuestionState>((set, _get) => {
  let pendingResolve: ((a: { selectedLabel: string; customText?: string } | null) => void) | null = null;
  const ask: QuestionState["ask"] = (req) => {
    if (pendingResolve) { pendingResolve(null); pendingResolve = null; }
    const full: QuestionRequest = {
      ...req,
      id: "q-" + crypto.randomUUID(),
      createdAt: Date.now(),
    };
    set({ request: full });
    return new Promise<{ selectedLabel: string; customText?: string } | null>((resolve) => {
      pendingResolve = resolve;
    });
  };
  return {
    request: null,
    ask,
    resolve(answer) {
      const r = pendingResolve;
      pendingResolve = null;
      if (r) {
        r(answer);
      }
      set({ request: null });
      try {
        const activeSessionId = useChat.getState().activeSessionId;
        if (activeSessionId) {
          useChat.getState().setSessionStatus(activeSessionId, "running");
        }
      } catch (e) {
        if (import.meta.env.DEV) devWarn("[Store] const activeSessionId = useChat.getState().activeS:", e);
      }
    },
  };
});
