import React, { useRef } from "react";
import { Plus } from "lucide-react";
import { useChat } from "@/store/useAppStore";
import { useToast } from "@/components/ui/toastStore";
import { Tooltip } from "@/components/ui/Tooltip";

export function AttachFileButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { addPendingAttachment } = useChat();
  const toast = useToast();

  const readFile = async (file: File) => {
    return new Promise<{ content: string; mimeType: string }>((resolve) => {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(",")[1] || "";
          resolve({ content: base64, mimeType: file.type });
        };
        reader.onerror = () => resolve({ content: "", mimeType: file.type });
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () =>
          resolve({
            content: reader.result as string,
            mimeType: file.type || "text/plain",
          });
        reader.onerror = () =>
          resolve({ content: "", mimeType: file.type || "text/plain" });
        reader.readAsText(file);
      }
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > 10 * 1024 * 1024) {
        toast.warning("File too large", `${file.name} exceeds 10MB limit`);
        continue;
      }
      const { content, mimeType } = await readFile(file);
      addPendingAttachment({
        id: "att-" + crypto.randomUUID(),
        name: file.name,
        mimeType,
        content,
        size: file.size,
      });
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        multiple
        accept="image/*,.txt,.js,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.html,.json,.md,.yaml,.yml,.toml,.sh,.sql,.csv,.xml,.swift,.rb,.php"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <Tooltip content="Add context" side="top">
        <button
          type="button"
          className="w-7 h-7 flex items-center justify-center rounded-md text-dalam-text-muted hover:text-dalam-text-primary hover:bg-dalam-bg-hover transition-colors"
          onClick={() => inputRef.current?.click()}
          aria-label="Add context"
        >
          <Plus className="w-4 h-4" />
        </button>
      </Tooltip>
    </>
  );
}
