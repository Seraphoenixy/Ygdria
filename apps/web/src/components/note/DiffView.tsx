import React, { useMemo } from "react";
import { Undo2 } from "lucide-react";
import { t, type Locale } from "../../lib/i18n";

export type DiffOp = { type: "equal" | "insert" | "delete"; text: string };

/** Flatten note content into an array of lines for diffing. */
export function linesFromContent(content: unknown): string[] {
  if (typeof content === "string") return content.split("\n");
  const lines: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const value = node as { type?: string; text?: string; content?: unknown[] };
    if (value.type === "text" && value.text) lines.push(value.text);
    if (Array.isArray(value.content)) {
      const start = lines.length;
      value.content.forEach(visit);
      if (["paragraph", "heading", "listItem", "blockquote", "codeBlock"].includes(value.type ?? "") && lines.length > start) lines.push("\n");
    }
  };
  visit(content);
  return lines.join("").split("\n");
}

/**
 * Classic LCS diff (Myers-free dynamic programming). The "old" side (a) is the
 * base content, the "new" side (b) is the changed content. Inputs are small
 * (a single note's text), so O(n·m) is acceptable.
 */
export function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "delete", text: a[i] });
      i += 1;
    } else {
      ops.push({ type: "insert", text: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: "delete", text: a[i++] });
  while (j < m) ops.push({ type: "insert", text: b[j++] });
  return ops;
}

export type DiffLineView = { type: "context" | "added" | "removed"; oldNo: number | null; newNo: number | null; text: string };
export type DiffHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLineView[] };

const CONTEXT_LINES = 3;

/** Coalesce a flat op list into GitHub-style hunks with `CONTEXT_LINES` of surrounding context. */
export function buildHunks(ops: DiffOp[]): DiffHunk[] {
  const inHunk = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type === "equal") continue;
    for (let d = -CONTEXT_LINES; d <= CONTEXT_LINES; d++) {
      const idx = k + d;
      if (idx >= 0 && idx < ops.length) inHunk[idx] = true;
    }
  }
  const hunks: DiffHunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (!inHunk[k]) {
      k += 1;
      continue;
    }
    const start = k;
    while (k < ops.length && inHunk[k]) k += 1;
    const slice = ops.slice(start, k);

    let oldBefore = 0;
    let newBefore = 0;
    for (let p = 0; p < start; p++) {
      if (ops[p].type !== "insert") oldBefore += 1;
      if (ops[p].type !== "delete") newBefore += 1;
    }
    const lines: DiffLineView[] = [];
    let o = oldBefore;
    let n = newBefore;
    for (const op of slice) {
      if (op.type === "equal") {
        lines.push({ type: "context", oldNo: o + 1, newNo: n + 1, text: op.text });
        o += 1;
        n += 1;
      } else if (op.type === "delete") {
        lines.push({ type: "removed", oldNo: o + 1, newNo: null, text: op.text });
        o += 1;
      } else {
        lines.push({ type: "added", oldNo: null, newNo: n + 1, text: op.text });
        n += 1;
      }
    }
    hunks.push({
      oldStart: oldBefore + 1,
      oldLines: o - oldBefore,
      newStart: newBefore + 1,
      newLines: n - newBefore,
      lines,
    });
  }
  return hunks;
}

/**
 * Apply the inverse of a single hunk to the current (new-side) lines: replace
 * the new-side region of the hunk with the old-side lines (context + removed),
 * which restores the base content for that region. Only meaningful for
 * plain-text (code) notes whose content is a string.
 */
export function revertHunk(currentLines: string[], hunk: DiffHunk): string {
  const oldSide = hunk.lines.filter((line) => line.type !== "added").map((line) => line.text);
  const start = hunk.newStart - 1;
  const end = start + hunk.newLines;
  return [...currentLines.slice(0, start), ...oldSide, ...currentLines.slice(end)].join("\n");
}

type DiffViewProps = {
  /** Base (old) content shown on the removed/- side. */
  oldContent?: unknown;
  /** Changed (new) content shown on the added/+ side. */
  newContent?: unknown;
  /** Pre-computed hunks; when omitted they are derived from old/new content. */
  hunks?: DiffHunk[];
  locale: Locale;
  emptyHint?: string;
  /** Layout: classic single-column unified diff, or side-by-side split view. */
  mode?: "unified" | "split";
  /** When provided, each hunk header shows a revert button (code notes only). */
  onRevertHunk?: (hunkIndex: number) => void;
  revertHunkLabel?: string;
  revertHunkTitle?: string;
  isReverting?: boolean;
};

/** GitHub-style diff view, reused by the revision and conflict dialogs. */
export function DiffView({
  oldContent,
  newContent,
  hunks,
  locale,
  emptyHint,
  mode = "unified",
  onRevertHunk,
  revertHunkLabel,
  revertHunkTitle,
  isReverting,
}: DiffViewProps) {
  const derivedHunks = useMemo(() => {
    if (hunks) return hunks;
    if (oldContent === undefined && newContent === undefined) return [];
    return buildHunks(lcsDiff(linesFromContent(oldContent), linesFromContent(newContent)));
  }, [hunks, oldContent, newContent]);

  if (!derivedHunks.length) {
    return <p className="revision-diff-hint">{emptyHint ?? t(locale, "revisionNoDiff")}</p>;
  }

  return (
    <>
      {derivedHunks.map((hunk, hi) => (
        <div className={`revision-hunk${mode === "split" ? " split" : ""}`} key={hi}>
          <div className="revision-hunk-header">
            <span className="revision-hunk-range">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </span>
            {onRevertHunk && (
              <button
                type="button"
                className="revision-revert-btn"
                onClick={() => onRevertHunk(hi)}
                disabled={isReverting}
                title={revertHunkTitle}
              >
                <Undo2 size={13} /> {revertHunkLabel}
              </button>
            )}
          </div>
          {mode === "split" ? (
            <div className="revision-hunk-split">
              {hunk.lines.map((line, li) => (
                <div className="split-row" key={li}>
                  <code
                    className={`split-cell old ${line.type === "removed" ? "removed" : line.type === "context" ? "context" : "blank"}`}
                  >
                    <span className="ln">{line.type === "added" ? "" : (line.oldNo ?? "")}</span>
                    <span className="txt">{line.type === "added" ? "" : line.text || " "}</span>
                  </code>
                  <code
                    className={`split-cell new ${line.type === "added" ? "added" : line.type === "context" ? "context" : "blank"}`}
                  >
                    <span className="ln">{line.type === "removed" ? "" : (line.newNo ?? "")}</span>
                    <span className="txt">{line.type === "removed" ? "" : line.text || " "}</span>
                  </code>
                </div>
              ))}
            </div>
          ) : (
            <ol>
              {hunk.lines.map((line, li) => (
                <li className={line.type} key={li}>
                  <span className="ln old">{line.oldNo ?? ""}</span>
                  <span className="ln new">{line.newNo ?? ""}</span>
                  <span className="sign">{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</span>
                  <code>{line.text || " "}</code>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </>
  );
}
