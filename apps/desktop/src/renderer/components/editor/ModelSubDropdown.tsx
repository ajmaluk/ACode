import React, { useState, useLayoutEffect } from "react";
import ReactDOM from "react-dom";
import { Check } from "lucide-react";
import type { ModelProvider } from "@/store/useAppStore";

export function ModelSubDropdown({
  hoveredProvider,
  providerRowRefs,
  modelRef,
  providers,
  selectedModelId,
  onSelect,
  onClose,
  hoverTimeoutRef,
}: {
  hoveredProvider: string;
  providerRowRefs: React.MutableRefObject<Record<string, HTMLElement | null>>;
  modelRef: React.RefObject<HTMLDivElement | null>;
  providers: ModelProvider[];
  selectedModelId: string;
  onSelect: (modelId: string) => void;
  onClose: () => void;
  hoverTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}) {
  const [style, setStyle] = useState<React.CSSProperties>({});
  const p = providers.find((pr) => pr.id === hoveredProvider);
  const enabledModels = p?.models?.filter((m) => m.enabled !== false) ?? [];

  useLayoutEffect(() => {
    const rowEl = providerRowRefs.current[hoveredProvider];
    const dropdownEl = modelRef.current?.querySelector("[data-dropdown-body]");
    if (!rowEl || !dropdownEl) return;
    const rowRect = rowEl.getBoundingClientRect();
    const dropRect = dropdownEl.getBoundingClientRect();
    const subH = enabledModels.length * 40 + 8;
    const vpH = window.innerHeight;
    let top = rowRect.top;
    if (top + subH > vpH) top = Math.max(0, vpH - subH - 8);
    setStyle({ left: dropRect.right + 2, top });

    const scrollEl = dropdownEl;
    const onScroll = () => {
      const rr = rowEl.getBoundingClientRect();
      let t = rr.top;
      if (t + subH > vpH) t = Math.max(0, vpH - subH - 8);
      setStyle({ left: dropRect.right + 2, top: t });
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [hoveredProvider, enabledModels.length, modelRef, providerRowRefs]);

  if (!p || enabledModels.length === 0) return null;

  return ReactDOM.createPortal(
    <div
      className="fixed w-56 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl z-[100]"
      style={style}
      data-model-subdropdown
      onMouseEnter={() => {
        if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      }}
      onMouseLeave={() => {
        hoverTimeoutRef.current = setTimeout(onClose, 200);
      }}
    >
      <div className="max-h-64 overflow-y-auto">
        {enabledModels.map((m) => (
          <button
            key={m.modelId}
            className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors ${selectedModelId === m.modelId ? "bg-dalam-bg-hover text-dalam-accent-primary" : "text-dalam-text-primary hover:bg-dalam-bg-hover"}`}
            onClick={() => {
              onSelect(m.modelId);
            }}
          >
            <span className="flex-1 truncate">{m.name}</span>
            {selectedModelId === m.modelId && (
              <Check className="w-3.5 h-3.5 text-dalam-accent-primary" />
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
