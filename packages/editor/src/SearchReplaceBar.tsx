import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, ArrowUp, ArrowDown } from "lucide-react";
import type { Editor } from "@tiptap/react";
import {
  SearchReplace,
  searchPluginKey,
  buildSearchRegex,
  type SearchOptionsState,
} from "./search-replace.js";

export { SearchReplace };

interface SearchReplaceBarProps {
  locale: "zh-CN" | "en";
  markdownView: boolean;
  editor: Editor | null;
  textarea: HTMLTextAreaElement | null;
  markdownText: string;
  onMarkdownChange: (value: string) => void;
  onClose: () => void;
  readOnly?: boolean;
}

interface PlainMatch {
  from: number;
  to: number;
}

function computePlainMatches(
  text: string,
  term: string,
  options: SearchOptionsState,
): PlainMatch[] {
  const matches: PlainMatch[] = [];
  if (!term) return matches;
  const regex = buildSearchRegex(term, options);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    matches.push({ from: match.index, to: match.index + match[0].length });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return matches;
}

export function SearchReplaceBar({
  locale,
  markdownView,
  editor,
  textarea,
  markdownText,
  onMarkdownChange,
  onClose,
  readOnly = false,
}: SearchReplaceBarProps) {
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [richInfo, setRichInfo] = useState({ count: 0, current: -1 });
  const [mdCurrent, setMdCurrent] = useState(-1);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingMdSelectionRef = useRef<{ from: number; to: number } | null>(null);

  const labels =
    locale === "zh-CN"
      ? {
          title: "查找替换",
          find: "查找",
          replace: "替换为",
          matchCase: "区分大小写",
          wholeWord: "全字匹配",
          prev: "上一个",
          next: "下一个",
          replaceOne: "替换",
          replaceAll: "全部替换",
          noResult: "无匹配项",
          count: (c: number, t: number) => `${c} / ${t}`,
        }
      : {
          title: "Find & Replace",
          find: "Find",
          replace: "Replace with",
          matchCase: "Match case",
          wholeWord: "Whole word",
          prev: "Previous",
          next: "Next",
          replaceOne: "Replace",
          replaceAll: "Replace all",
          noResult: "No results",
          count: (c: number, t: number) => `${c} / ${t}`,
        };

  // Prefill the search field from the current selection when the bar opens.
  useEffect(() => {
    let initial = "";
    if (markdownView && textarea) {
      const { selectionStart, selectionEnd, value } = textarea;
      if (selectionEnd > selectionStart) initial = value.slice(selectionStart, selectionEnd);
    } else if (editor && !editor.isDestroyed) {
      const { from, to, empty } = editor.state.selection;
      if (!empty) initial = editor.state.doc.textBetween(from, to, "\n");
    }
    if (initial) {
      setTerm(initial);
      if (!markdownView && editor && !editor.isDestroyed) {
        editor.commands.setSearchTerm(initial);
      }
    }
    const id = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  // Keep the rich-text match count in sync with the ProseMirror plugin state.
  useEffect(() => {
    if (markdownView || !editor) return;
    const update = () => {
      const s = searchPluginKey.getState(editor.state);
      setRichInfo({ count: s?.matches.length ?? 0, current: s?.current ?? -1 });
    };
    update();
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor, markdownView]);

  // Plain-text (Markdown view) matches.
  const mdMatches = useMemo(
    () =>
      markdownView
        ? computePlainMatches(markdownText, term, {
            caseSensitive: matchCase,
            wholeWord,
          })
        : [],
    [markdownView, markdownText, term, matchCase, wholeWord],
  );

  // Reset the active Markdown match when the query or options change, and
  // select it in the textarea so the current hit is visible.
  useEffect(() => {
    if (!markdownView) return;
    setMdCurrent(mdMatches.length ? 0 : -1);
    if (mdMatches.length) selectMarkdown(0);
  }, [term, matchCase, wholeWord, markdownView]);

  // Keep the Markdown match index within bounds after content edits.
  useEffect(() => {
    if (!markdownView) return;
    setMdCurrent((current) =>
      mdMatches.length === 0 ? -1 : Math.min(Math.max(current, 0), mdMatches.length - 1),
    );
  }, [mdMatches, markdownView]);

  // Apply a pending textarea selection after a Markdown replace re-renders.
  useEffect(() => {
    if (!markdownView || !textarea || textarea.disabled) return;
    const pending = pendingMdSelectionRef.current;
    if (!pending) return;
    pendingMdSelectionRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(pending.from, pending.to);
  }, [markdownText, markdownView, textarea]);

  // Push query / options changes into the rich-text plugin.
  useEffect(() => {
    if (markdownView || !editor || editor.isDestroyed) return;
    editor.commands.setSearchTerm(term);
  }, [term, markdownView, editor]);

  useEffect(() => {
    if (markdownView || !editor || editor.isDestroyed) return;
    editor.commands.setSearchOptions({ caseSensitive: matchCase, wholeWord });
  }, [matchCase, wholeWord, markdownView, editor]);

  // Scroll the active rich-text match into view.
  useEffect(() => {
    if (markdownView || !editor || richInfo.current < 0) return;
    const id = window.requestAnimationFrame(() => {
      const el = editor.view.dom.querySelector(".ygdria-search-current");
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(id);
  }, [richInfo.current, editor, markdownView]);

  const selectMarkdown = (index: number) => {
    const match = mdMatches[index];
    if (!match || !textarea || textarea.disabled) return;
    textarea.focus();
    textarea.setSelectionRange(match.from, match.to);
  };

  const goPrev = () => {
    if (markdownView) {
      if (mdMatches.length === 0) return;
      const next = (mdCurrent - 1 + mdMatches.length) % mdMatches.length;
      setMdCurrent(next);
      selectMarkdown(next);
    } else {
      editor?.commands.searchPrev();
    }
  };

  const goNext = () => {
    if (markdownView) {
      if (mdMatches.length === 0) return;
      const next = (mdCurrent + 1) % mdMatches.length;
      setMdCurrent(next);
      selectMarkdown(next);
    } else {
      editor?.commands.searchNext();
    }
  };

  const replaceOne = () => {
    if (markdownView) {
      const match = mdMatches[mdCurrent];
      if (!match || !textarea || textarea.disabled) return;
      const next = markdownText.slice(0, match.from) + replacement + markdownText.slice(match.to);
      pendingMdSelectionRef.current = { from: match.from, to: match.from + replacement.length };
      onMarkdownChange(next);
      // One match was removed; keep the caret on the next remaining match.
      const nextCount = mdMatches.length - 1;
      setMdCurrent((current) => (nextCount <= 0 ? -1 : Math.min(current, nextCount - 1)));
    } else {
      editor?.commands.replaceCurrent(replacement);
    }
  };

  const replaceAllMatches = () => {
    if (markdownView) {
      const sorted = [...mdMatches].sort((a, b) => b.from - a.from);
      let next = markdownText;
      for (const m of sorted) {
        next = next.slice(0, m.from) + replacement + next.slice(m.to);
      }
      pendingMdSelectionRef.current = null;
      onMarkdownChange(next);
      setMdCurrent(-1);
    } else {
      editor?.commands.replaceAll(replacement);
    }
  };

  const count = markdownView ? mdMatches.length : richInfo.count;
  const current = markdownView ? mdCurrent : richInfo.current;
  const hasMatches = count > 0;

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) goPrev();
      else goNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const onReplaceKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      replaceOne();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="ygdria-search-bar" role="search">
      <div className="ygdria-search-row">
        <input
          ref={searchInputRef}
          className="ygdria-search-input"
          type="text"
          value={term}
          placeholder={labels.find}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label={labels.find}
          spellCheck={false}
        />
        <label className="ygdria-search-option">
          <input
            type="checkbox"
            checked={matchCase}
            onChange={(event) => setMatchCase(event.target.checked)}
          />
          <span>{labels.matchCase}</span>
        </label>
        <label className="ygdria-search-option">
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(event) => setWholeWord(event.target.checked)}
          />
          <span>{labels.wholeWord}</span>
        </label>
        <button
          type="button"
          className="ygdria-search-nav"
          onClick={goPrev}
          disabled={!hasMatches}
          aria-label={labels.prev}
          title={labels.prev}
        >
          <ArrowUp size={16} />
        </button>
        <button
          type="button"
          className="ygdria-search-nav"
          onClick={goNext}
          disabled={!hasMatches}
          aria-label={labels.next}
          title={labels.next}
        >
          <ArrowDown size={16} />
        </button>
        <span className="ygdria-search-count">
          {hasMatches ? labels.count(current + 1, count) : labels.noResult}
        </span>
        <button
          type="button"
          className="ygdria-search-close"
          onClick={onClose}
          aria-label={labels.title}
          title={labels.title}
        >
          <X size={16} />
        </button>
      </div>
      <div className="ygdria-search-row ygdria-search-replace-row">
        <input
          className="ygdria-search-input"
          type="text"
          value={replacement}
          placeholder={labels.replace}
          onChange={(event) => setReplacement(event.target.value)}
          onKeyDown={onReplaceKeyDown}
          aria-label={labels.replace}
          spellCheck={false}
        />
        <button
          type="button"
          className="ygdria-search-action"
          onClick={replaceOne}
          disabled={!hasMatches || readOnly}
        >
          {labels.replaceOne}
        </button>
        <button
          type="button"
          className="ygdria-search-action"
          onClick={replaceAllMatches}
          disabled={!hasMatches || readOnly}
        >
          {labels.replaceAll}
        </button>
      </div>
    </div>
  );
}
