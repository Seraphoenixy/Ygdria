import React, { type ReactNode } from "react";

export interface WorkspaceLayoutProps {
  treeCollapsed: boolean;
  showInspector: boolean;
  inspectorCollapsed: boolean;
  hasWindowControls: boolean;
  treePanelWidth: number;
  inspectorPanelWidth: number;
  importInputRef: React.RefObject<HTMLInputElement | null>;
  importAccept: string;
  onImport: (event: React.ChangeEvent<HTMLInputElement>) => void;
  toastMessage?: string;
  onDismissContextMenus: () => void;
  children: ReactNode;
}

export function WorkspaceLayout({
  treeCollapsed,
  showInspector,
  inspectorCollapsed,
  hasWindowControls,
  treePanelWidth,
  inspectorPanelWidth,
  importInputRef,
  importAccept,
  onImport,
  toastMessage,
  onDismissContextMenus,
  children,
}: WorkspaceLayoutProps) {
  return (
    <main
      className={`${treeCollapsed ? "tree-panel-collapsed" : ""} ${!showInspector || inspectorCollapsed ? "inspector-panel-collapsed" : ""} ${hasWindowControls ? "desktop-window-content" : ""}`}
      style={
        {
          "--tree-panel-width": `${treePanelWidth}px`,
          "--inspector-panel-width": `${inspectorPanelWidth}px`,
        } as React.CSSProperties
      }
      onClick={onDismissContextMenus}
    >
      <input
        ref={importInputRef}
        className="file-import-input"
        type="file"
        accept={importAccept}
        onChange={onImport}
      />
      {toastMessage && (
        <div className="import-complete-toast" role="status">
          {toastMessage}
        </div>
      )}
      {children}
    </main>
  );
}