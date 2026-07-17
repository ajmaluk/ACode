import { useState, useEffect, useRef } from "react";
import { Hash, X } from "lucide-react";

interface GoToLineProps {
  maxLine: number;
  onGoToLine: (line: number) => void;
  onClose: () => void;
}

export function GoToLine({ maxLine, onGoToLine, onClose }: GoToLineProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSubmit = () => {
    const line = parseInt(value, 10);
    if (!isNaN(line) && line >= 1 && line <= maxLine) {
      onGoToLine(line);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="w-72 bg-dalam-bg-secondary border border-dalam-border-primary rounded-xl shadow-2xl overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Go to line"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-dalam-border-primary">
          <Hash className="w-4 h-4 text-dalam-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter") handleSubmit();
            }}
            className="flex-1 bg-transparent border-0 outline-none text-sm text-dalam-text-primary placeholder:text-dalam-text-muted"
            placeholder={`Line number (1-${maxLine})`}
            min={1}
            max={maxLine}
          />
          <button
            type="button"
            onClick={onClose}
            className="text-dalam-text-muted hover:text-dalam-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
