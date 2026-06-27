import { useState, useRef, useEffect } from "react";
import ReactDOM from "react-dom";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  delay?: number;
}

export function Tooltip({ content, children, side = "top", delay = 100 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const updateCoords = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    
    let top = 0;
    let left = 0;
    
    if (side === "top") {
      top = rect.top + window.scrollY;
      left = rect.left + rect.width / 2 + window.scrollX;
    } else if (side === "bottom") {
      top = rect.bottom + window.scrollY;
      left = rect.left + rect.width / 2 + window.scrollX;
    } else if (side === "left") {
      top = rect.top + rect.height / 2 + window.scrollY;
      left = rect.left + window.scrollX;
    } else if (side === "right") {
      top = rect.top + rect.height / 2 + window.scrollY;
      left = rect.right + window.scrollX;
    }
    
    setCoords({ top, left });
  };

  const show = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    updateCoords();
    timeoutRef.current = setTimeout(() => {
      setVisible(true);
    }, delay);
  };

  const hide = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    window.addEventListener("scroll", updateCoords, true);
    window.addEventListener("resize", updateCoords);
    return () => {
      window.removeEventListener("scroll", updateCoords, true);
      window.removeEventListener("resize", updateCoords);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const positionStyles = {
    top: {
      transform: "translate(-50%, -100%)",
      marginTop: "-8px",
    },
    bottom: {
      transform: "translate(-50%, 0)",
      marginTop: "8px",
    },
    left: {
      transform: "translate(-100%, -50%)",
      marginLeft: "-8px",
    },
    right: {
      transform: "translate(0, -50%)",
      marginLeft: "8px",
    },
  };

  return (
    <div
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible && content && typeof document !== "undefined" &&
        ReactDOM.createPortal(
          <div
            style={{
              position: "absolute",
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              ...positionStyles[side],
            }}
            className="z-[9999] px-2 py-1 text-[11px] font-medium text-dalam-text-primary bg-dalam-bg-tertiary backdrop-blur-sm border border-dalam-border-primary rounded-md shadow-xl whitespace-nowrap pointer-events-none animate-fade-in"
          >
            {content}
          </div>,
          document.body
        )}
    </div>
  );
}
