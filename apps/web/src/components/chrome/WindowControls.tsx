import { Copy, Minus, Square, X } from "lucide-react";
import { useState } from "react";

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const control = async (action: "minimize" | "toggle-maximize" | "close") => {
    const maximized = await window.ygdria?.windowControl?.(action);
    if (typeof maximized === "boolean") setIsMaximized(maximized);
  };

  return <div className="window-controls" aria-label="Window controls">
    <button aria-label="Minimize" title="Minimize" onClick={() => void control("minimize")}><Minus size={17} /></button>
    <button aria-label={isMaximized ? "Restore" : "Maximize"} title={isMaximized ? "Restore" : "Maximize"} onClick={() => void control("toggle-maximize")}>
      {isMaximized ? <Copy size={14} /> : <Square size={14} />}
    </button>
    <button className="window-close" aria-label="Close" title="Close" onClick={() => void control("close")}><X size={18} /></button>
  </div>;
}
