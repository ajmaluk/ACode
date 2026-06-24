import { useWorkspace } from "@/store/useAppStore";
import { useToast } from "@/components/ui/Toaster";
import { ChevronRight, FileCode } from "lucide-react";
import { splitPath } from "@/lib/pathUtils";

export function Breadcrumb() {
  const { activeFilePath } = useWorkspace();
  const toast = useToast();
  if (!activeFilePath) {
    return (
      <div className="h-7 px-3 flex items-center text-[11px] text-acode-text-muted border-b border-acode-border-primary bg-acode-bg-secondary">
        <span>No file open</span>
      </div>
    );
  }
  const parts = splitPath(activeFilePath);
  const fileName = parts.pop() ?? "";

  const copyDirPath = (idx: number) => {
    const dirPath = parts.slice(0, idx + 1).join("/");
    void navigator.clipboard.writeText("/" + dirPath);
    toast.success("Path copied", dirPath);
  };

  return (
    <div className="h-7 px-3 flex items-center text-[11px] border-b border-acode-border-primary bg-acode-bg-secondary overflow-x-auto scrollbar-thin">
      {parts.map((part, idx) => (
        <span key={`${idx}-${part}`} className="flex items-center flex-shrink-0">
          <button
            className="px-1 py-0.5 text-acode-text-muted hover:text-acode-text-primary hover:bg-acode-bg-hover rounded transition-colors"
            onClick={() => copyDirPath(idx)}
            title={`Copy directory path: /${parts.slice(0, idx + 1).join("/")}`}
          >
            {part}
          </button>
          <ChevronRight className="w-3 h-3 mx-0.5 text-acode-text-muted/50" />
        </span>
      ))}
      <span className="flex items-center gap-1.5 text-acode-text-primary font-medium flex-shrink-0">
        <FileCode className="w-3 h-3 text-acode-accent-primary" />
        {fileName}
      </span>
    </div>
  );
}
