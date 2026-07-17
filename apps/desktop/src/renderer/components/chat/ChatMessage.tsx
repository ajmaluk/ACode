/* eslint-disable react-refresh/only-export-components */

import React, { useMemo, Suspense, Component, type ReactNode } from "react";

class MarkdownErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.warn("[MarkdownContent] Error boundary caught:", error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-3 my-2 bg-dalam-git-deleted/10 border border-dalam-git-deleted/20 rounded-lg text-xs text-dalam-git-deleted">
          Could not render this content. The raw text is available to copy.
        </div>
      );
    }
    return this.props.children;
  }
}
import { FileText, Copy, RotateCcw, Info } from "lucide-react";
import { useChat } from "@/store/useAppStore";
import { useToast } from "@/components/ui/toastStore";
import { splitCodeFences, transformRawCodeSegments } from "@/lib/chatUtils";
import { stripXmlToolCallTags } from "@/store/xmlParser";
import { CodeBlock, StreamingCodeBlock, MarkdownContent, StreamingContent } from "./ChatRendering";
import {
  ThinkingBlock,
  ToolCallsList,
  TodoBlock,
  TaskPlanBlock,
  QuestionAccordion,
  ChangesCard,
  ContextGatheringGroup,
  SkillBlock,
  BashActivityBlock,
  PlanBlock,
} from "./ActivityBlocks";

export const EMPTY_ACTIVITIES: never[] = [];

export const ChatMessage = React.memo(
  function ChatMessage({
    message,
    pending,
    onResetToMessage: _onResetToMessage,
    onResetClick,
    isLast,
  }: {
    message: import("@dalam/shared-types").ChatMessage;
    pending?: boolean;
    onResetToMessage?: (content: string) => void;
    onResetClick?: (
      messageId: string,
      messageContent: string,
      attachments?: import("@dalam/shared-types").FileAttachment[],
    ) => void;
    isLast?: boolean;
  }) {
    const toast = useToast();
    // Safety net: strip any remaining XML tool call tags that leaked through streaming.
    // This catches edge cases where stripInlineXml or parseXmlToolCalls missed tags.
    // Fast-path: skip the expensive stripXmlToolCallTags when content has no angle brackets.
    const displayContent = useMemo(
      () => !message.content.includes("<") ? message.content : stripXmlToolCallTags(message.content),
      [message.content],
    );
    const rawSegments = useMemo(
      () => splitCodeFences(displayContent),
      [displayContent],
    );
    const segments = useMemo(
      () => transformRawCodeSegments(rawSegments),
      [rawSegments],
    );
    // Live session todos while streaming (todowrite updates store before message finalizes)
    const liveTodos = useChat((s) => (pending ? s.todos : EMPTY_ACTIVITIES));
    const pendingActivities = useChat((s) =>
      pending ? s.pendingActivities : EMPTY_ACTIVITIES,
    );
    const activities = useMemo(
      () => message.activities ?? (pending ? pendingActivities : []),
      [message.activities, pending, pendingActivities],
    );

    // Memoize activity filtering to avoid creating new arrays every render
    const CONTEXT_TYPES = useMemo(() => new Set(["explore", "read"]), []);
    const contextActivities = useMemo(
      () => activities.filter((a) => CONTEXT_TYPES.has(a.type)),
      [activities, CONTEXT_TYPES],
    );
    const otherActivities = useMemo(
      () => activities.filter((a) => !CONTEXT_TYPES.has(a.type)),
      [activities, CONTEXT_TYPES],
    );

    // System message: styled notification box
    if (message.role === "system") {
      // Hide internal approval/completion messages — they're for the LLM, not the user
      if (message.content.startsWith("[File write completed]") || message.content.startsWith("[File write approved]")) {
        return null;
      }
      return (
        <div role="alert" className="py-2.5 px-3.5 my-3 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl text-xs text-dalam-text-secondary flex items-start gap-3 animate-fade-in shadow-sm max-w-2xl mx-auto">
          <Info className="w-4 h-4 text-dalam-accent-primary mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-dalam-text-primary mb-1">
              System Notification
            </div>
            <div className="whitespace-pre-wrap leading-relaxed font-mono text-[11px] text-dalam-text-secondary">
              {message.content}
            </div>
          </div>
        </div>
      );
    }

    // User message: right-aligned with subtle background
    if (message.role === "user") {
      if (!message.content && !message.attachments?.length) return null;
      return (
        <div className="group/usermsg py-2 message-enter">
          <div className="flex justify-end">
            <div className="max-w-[80%]">
              {message.attachments && message.attachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2 justify-end">
                  {message.attachments.map((att) => (
                    <div
                      key={att.id}
                      className="flex items-center gap-1.5 px-2 py-1 bg-dalam-bg-active border border-dalam-border-primary rounded-md text-xs text-dalam-text-primary"
                    >
                      {att.mimeType.startsWith("image/") ? (
                        <img
                          src={`data:${att.mimeType};base64,${att.content}`}
                          alt={att.name}
                          className="w-10 h-10 rounded object-cover"
                        />
                      ) : (
                        <>
                          <FileText className="w-3.5 h-3.5 text-dalam-text-muted" aria-hidden="true" />
                          <span className="max-w-[120px] truncate">
                            {att.name}
                          </span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl rounded-tr-sm px-4 py-2.5 relative">
                <p className="text-sm text-dalam-text-primary leading-relaxed whitespace-pre-wrap break-words text-left">
                  {message.content}
                </p>
                <div className="absolute -bottom-7 right-0 flex items-center gap-0.5 opacity-0 group-hover/usermsg:opacity-100 transition-opacity z-10">
                  <button
                    className="p-1 rounded hover:bg-dalam-bg-hover text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
                    title="Copy message"
                    aria-label="Copy message"
                    onClick={() => {
                      void navigator.clipboard.writeText(message.content);
                      toast.success("Copied");
                    }}
                  >
                    <Copy className="w-3 h-3" aria-hidden="true" />
                  </button>
                  <button
                    className="p-1 rounded hover:bg-dalam-bg-hover text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
                    title="Reset to this message"
                    aria-label="Reset to this message"
                    onClick={() =>
                      onResetClick?.(
                        message.id,
                        message.content,
                        message.attachments,
                      )
                    }
                  >
                    <RotateCcw className="w-3 h-3" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Assistant message: left-aligned with subtle accent
    const hasContent = !!(message.content || pending);
    const hasActivities = activities.length > 0;
    const hasToolCalls = !!(message.toolCalls && message.toolCalls.length > 0);
    const displayTodos =
      message.todos && message.todos.length > 0
        ? message.todos
        : pending && Array.isArray(liveTodos) && liveTodos.length > 0
          ? (liveTodos as import("@dalam/shared-types").TodoItem[])
          : undefined;
    const hasTodos = !!(displayTodos && displayTodos.length > 0);
    const hasFileChanges = !!(
      message.fileChanges && message.fileChanges.length > 0
    );
    const hasThinking = !!message.thinking;
    if (
      !hasContent &&
      !hasActivities &&
      !hasToolCalls &&
      !hasTodos &&
      !hasFileChanges &&
      !hasThinking
    ) {
      return null;
    }

    return (
      <div className="group/msg py-2 message-enter">
        {/* Thinking block — model's reasoning, collapsed by default */}
        {!pending && message.thinking && (
          <ThinkingBlock content={message.thinking} />
        )}

        {/* Activity blocks (explore / read / skill / bash / plan) */}
        {hasActivities && (
          <div className="my-0.5">
            {contextActivities.length > 0 && (
              <ContextGatheringGroup activities={contextActivities} />
            )}
            {otherActivities.map((activity) => {
              const ak = activity.id;
              if (activity.type === "skill") {
                return (
                  <SkillBlock
                    key={ak}
                    name={activity.name}
                    content={activity.content}
                    args={activity.args}
                  />
                );
              }
              if (activity.type === "bash") {
                return (
                  <BashActivityBlock
                    key={ak}
                    command={activity.command}
                    result={activity.result}
                  />
                );
              }
              if (activity.type === "plan") {
                return <PlanBlock key={ak} plan={activity.plan} />;
              }
              if (activity.type === "think") {
                return <ThinkingBlock key={ak} content={activity.content} />;
              }
              return null;
            })}
          </div>
        )}

        {/* Main assistant message — rendered with markdown */}
        {hasContent && (
          <div className="text-[13px] text-dalam-text-primary leading-relaxed my-0.5">
              {segments
              .filter((seg) => seg.type !== "text" || seg.content.trim())
              .map((seg) => (
                <MarkdownErrorBoundary key={seg.type + seg.content.substring(0, 40)}>
                  {seg.type === "code" ? (
                    <div>
                      {pending ? (
                        <StreamingCodeBlock
                          language={seg.language ?? ""}
                          content={seg.content}
                          filename={seg.filename}
                        />
                      ) : (
                        <CodeBlock
                          language={seg.language ?? ""}
                          content={seg.content}
                          filename={seg.filename}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="prose-dalam mb-2 last:mb-0">
                      {pending ? (
                        <StreamingContent content={seg.content} />
                      ) : (
                        <MarkdownContent content={seg.content} />
                      )}
                    </div>
                  )}
                </MarkdownErrorBoundary>
              ))}
            {pending && (
              <span className="inline-block w-[2px] h-4 bg-dalam-accent-primary ml-0.5 animate-typing-cursor rounded-sm align-middle" />
            )}
          </div>
        )}

        {/* Live tool calls while streaming (OpenCode-style activity) */}
        {hasToolCalls && (
          <Suspense
            fallback={
              <div className="text-xs text-dalam-text-muted">
                Loading tool calls...
              </div>
            }
          >
            <ToolCallsList toolCalls={message.toolCalls!} />
          </Suspense>
        )}

        {/* Todo checklist — show during stream so progress is visible live */}
        {hasTodos && displayTodos && (
          <Suspense
            fallback={
              <div className="text-xs text-dalam-text-muted">
                Loading todos...
              </div>
            }
          >
            <TodoBlock todos={displayTodos} />
          </Suspense>
        )}

        {/* Task plan checklist — visible during stream */}
        {message.taskPlan && message.taskPlan.length > 0 && (
          <Suspense
            fallback={
              <div className="text-xs text-dalam-text-muted">
                Loading task plan...
              </div>
            }
          >
            <TaskPlanBlock
              tasks={message.taskPlan}
              summary={message.taskPlanSummary}
            />
          </Suspense>
        )}

        {/* Questions asked by the agent */}
        {!pending && message.questions && message.questions.length > 0 && (
          <Suspense
            fallback={
              <div className="text-xs text-dalam-text-muted">
                Loading questions...
              </div>
            }
          >
            <QuestionAccordion questions={message.questions} />
          </Suspense>
        )}

        {/* Changes card */}
        {!pending && hasFileChanges && (
          <ChangesCard changes={message.fileChanges!} />
        )}

        {/* Message meta footer — only on the last message when settled. */}
        {!pending &&
          isLast &&
          (message.content || hasToolCalls || hasFileChanges) && (
            <div className="flex items-center gap-2 mt-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
                <div className="ml-auto flex items-center gap-0.5">
                {message.content && (
                  <button
                    aria-label="Copy message"
                    className="p-1 rounded hover:bg-dalam-bg-hover text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
                    title="Copy"
                    onClick={() => {
                      void navigator.clipboard.writeText(message.content);
                      toast.success("Copied");
                    }}
                  >
                    <Copy className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}
      </div>
    );
  },
  (prevProps, nextProps) => {
    const prevTC = prevProps.message.toolCalls;
    const nextTC = nextProps.message.toolCalls;
    const tcChanged =
      (prevTC?.length ?? 0) !== (nextTC?.length ?? 0) ||
      (prevTC &&
        nextTC &&
        prevTC.some(
          (tc, i) =>
            i < nextTC.length &&
            (tc.id !== nextTC[i]?.id ||
              tc.status !== nextTC[i]?.status ||
              tc.result !== nextTC[i]?.result),
        ));
    const prevFC = prevProps.message.fileChanges;
    const nextFC = nextProps.message.fileChanges;
    const fcChanged =
      (prevFC?.length ?? 0) !== (nextFC?.length ?? 0) ||
      (prevFC &&
        nextFC &&
        prevFC.some(
          (fc, i) =>
            fc.path !== nextFC[i]?.path ||
            fc.action !== nextFC[i]?.action ||
            fc.additions !== nextFC[i]?.additions ||
            fc.deletions !== nextFC[i]?.deletions,
        ));
    const prevAct = prevProps.message.activities;
    const nextAct = nextProps.message.activities;
    const actChanged =
      (prevAct?.length ?? 0) !== (nextAct?.length ?? 0) ||
      (prevAct &&
        nextAct &&
        prevAct.some((a, i) => {
          const b = nextAct[i];
          if (!b || a.type !== b.type) return true;
          switch (a.type) {
            case "think":
              return b.type === "think" && a.content !== b.content;
            case "explore":
              return b.type === "explore" && (a.query !== b.query || a.matches !== b.matches);
            case "read":
              return b.type === "read" && (a.path !== b.path || a.content !== b.content || a.lineRange !== b.lineRange);
            case "skill":
              return b.type === "skill" && (a.name !== b.name || a.args !== b.args || a.content !== b.content);
            case "bash":
              return (
                b.type === "bash" &&
                (a.command !== b.command || a.result !== b.result)
              );
            case "plan":
              return b.type === "plan" && a.plan !== b.plan;
            default:
              return false;
          }
        }));
    const questionsEq = prevProps.message.questions === nextProps.message.questions ||
      (!prevProps.message.questions && !nextProps.message.questions);
    const taskPlanEq = prevProps.message.taskPlan === nextProps.message.taskPlan ||
      (!prevProps.message.taskPlan && !nextProps.message.taskPlan);
    const todosEq = prevProps.message.todos === nextProps.message.todos ||
      (!prevProps.message.todos && !nextProps.message.todos);
    return (
      prevProps.pending === nextProps.pending &&
      prevProps.isLast === nextProps.isLast &&
      prevProps.message.id === nextProps.message.id &&
      prevProps.message.content === nextProps.message.content &&
      prevProps.message.role === nextProps.message.role &&
      prevProps.message.thinking === nextProps.message.thinking &&
      questionsEq &&
      taskPlanEq &&
      prevProps.message.taskPlanSummary === nextProps.message.taskPlanSummary &&
      todosEq &&
      !tcChanged &&
      !fcChanged &&
      !actChanged
    );
  },
);
