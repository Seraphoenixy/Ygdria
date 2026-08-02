import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface SearchOptionsState {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  from: number;
  to: number;
}

interface SearchState {
  term: string;
  options: SearchOptionsState;
  matches: SearchMatch[];
  current: number;
}

export const searchPluginKey = new PluginKey<SearchState>("ygdria-search-replace");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    searchReplace: {
      setSearchTerm: (term: string) => ReturnType;
      setSearchOptions: (options: Partial<SearchOptionsState>) => ReturnType;
      searchNext: () => ReturnType;
      searchPrev: () => ReturnType;
      replaceCurrent: (replacement: string) => ReturnType;
      replaceAll: (replacement: string) => ReturnType;
      clearSearch: () => ReturnType;
    };
  }
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a RegExp for the given term. Whole-word matching uses Unicode-aware
 * look-arounds so CJK characters (each `\p{L}`) are treated as word units,
 * which mirrors how most editors behave for non-Latin scripts.
 */
export function buildSearchRegex(term: string, options: SearchOptionsState): RegExp {
  const body = escapeRegex(term);
  const pattern = options.wholeWord
    ? `(?<![\\p{L}\\p{N}])(${body})(?![\\p{L}\\p{N}])`
    : `(${body})`;
  return new RegExp(pattern, options.caseSensitive ? "gu" : "gui");
}

export function computeMatches(doc: any, term: string, options: SearchOptionsState): SearchMatch[] {
  const matches: SearchMatch[] = [];
  if (!term) return matches;
  const regex = buildSearchRegex(term, options);
  doc.descendants((node: any, pos: number) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const from = pos + match.index;
      const to = from + match[0].length;
      matches.push({ from, to });
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  });
  return matches;
}

type SearchMeta =
  | { type: "setTerm"; term: string }
  | { type: "setOptions"; options: Partial<SearchOptionsState> }
  | { type: "next" }
  | { type: "prev" }
  | { type: "afterReplace"; index: number }
  | { type: "afterReplaceAll" }
  | { type: "clear" };

const clampCurrent = (current: number, count: number): number =>
  count === 0 ? -1 : Math.min(Math.max(current < 0 ? 0 : current, 0), count - 1);

export const SearchReplace = Extension.create({
  name: "searchReplace",
  addCommands() {
    return {
      setSearchTerm:
        (term: string) =>
        ({ dispatch, tr }: { dispatch?: (tr: Transaction) => void; tr: Transaction }) => {
          if (dispatch) tr.setMeta(searchPluginKey, { type: "setTerm", term } as SearchMeta);
          return true;
        },
      setSearchOptions:
        (options: Partial<SearchOptionsState>) =>
        ({ dispatch, tr }: { dispatch?: (tr: Transaction) => void; tr: Transaction }) => {
          if (dispatch) tr.setMeta(searchPluginKey, { type: "setOptions", options } as SearchMeta);
          return true;
        },
      searchNext:
        () =>
        ({ dispatch, tr }: { dispatch?: (tr: Transaction) => void; tr: Transaction }) => {
          if (dispatch) tr.setMeta(searchPluginKey, { type: "next" } as SearchMeta);
          return true;
        },
      searchPrev:
        () =>
        ({ dispatch, tr }: { dispatch?: (tr: Transaction) => void; tr: Transaction }) => {
          if (dispatch) tr.setMeta(searchPluginKey, { type: "prev" } as SearchMeta);
          return true;
        },
      replaceCurrent:
        (replacement: string) =>
        ({ state, dispatch, tr }: any) => {
          const s = searchPluginKey.getState(state) as SearchState | undefined;
          if (!s || s.current < 0 || !s.matches[s.current]) return false;
          const { from, to } = s.matches[s.current];
          tr.insertText(replacement, from, to);
          tr.setMeta(searchPluginKey, { type: "afterReplace", index: s.current } as SearchMeta);
          if (dispatch) dispatch(tr);
          return true;
        },
      replaceAll:
        (replacement: string) =>
        ({ state, dispatch, tr }: any) => {
          const s = searchPluginKey.getState(state) as SearchState | undefined;
          if (!s || s.matches.length === 0) return false;
          // Apply from the last match backwards so earlier positions stay valid.
          const sorted = [...s.matches].sort((a, b) => b.from - a.from);
          for (const m of sorted) tr.insertText(replacement, m.from, m.to);
          tr.setMeta(searchPluginKey, { type: "afterReplaceAll" } as SearchMeta);
          if (dispatch) dispatch(tr);
          return true;
        },
      clearSearch:
        () =>
        ({ dispatch, tr }: { dispatch?: (tr: Transaction) => void; tr: Transaction }) => {
          if (dispatch) tr.setMeta(searchPluginKey, { type: "clear" } as SearchMeta);
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchPluginKey,
        state: {
          init: (): SearchState => ({
            term: "",
            options: { caseSensitive: false, wholeWord: false },
            matches: [],
            current: -1,
          }),
          apply(tr, value) {
            const meta = tr.getMeta(searchPluginKey) as SearchMeta | undefined;
            const next: SearchState = {
              term: value.term,
              options: value.options,
              matches: value.matches,
              current: value.current,
            };
            let syncSelection = false;
            if (meta) {
              switch (meta.type) {
                case "setTerm":
                  next.term = meta.term;
                  next.matches = computeMatches(tr.doc, next.term, next.options);
                  next.current = next.matches.length ? 0 : -1;
                  syncSelection = true;
                  break;
                case "setOptions":
                  next.options = { ...next.options, ...meta.options };
                  next.matches = computeMatches(tr.doc, next.term, next.options);
                  next.current = clampCurrent(next.current, next.matches.length);
                  syncSelection = true;
                  break;
                case "next":
                  if (next.matches.length) {
                    next.current = (next.current + 1) % next.matches.length;
                    syncSelection = true;
                  }
                  break;
                case "prev":
                  if (next.matches.length) {
                    next.current = (next.current - 1 + next.matches.length) % next.matches.length;
                    syncSelection = true;
                  }
                  break;
                case "afterReplace":
                  next.matches = computeMatches(tr.doc, next.term, next.options);
                  next.current = clampCurrent(meta.index, next.matches.length);
                  syncSelection = true;
                  break;
                case "afterReplaceAll":
                  next.matches = computeMatches(tr.doc, next.term, next.options);
                  next.current = -1;
                  syncSelection = false;
                  break;
                case "clear":
                  next.term = "";
                  next.matches = [];
                  next.current = -1;
                  syncSelection = false;
                  break;
              }
            } else if (tr.docChanged) {
              // Content was edited: recompute matches but keep the active match
              // in place without hijacking the user's caret.
              next.matches = computeMatches(tr.doc, next.term, next.options);
              next.current = clampCurrent(next.current, next.matches.length);
            }
            if (syncSelection && next.current >= 0 && next.matches[next.current]) {
              const m = next.matches[next.current];
              tr.setSelection(TextSelection.create(tr.doc, m.from, m.to));
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            const s = searchPluginKey.getState(state);
            if (!s || s.matches.length === 0) return DecorationSet.empty;
            return DecorationSet.create(
              state.doc,
              s.matches.map((m, i) =>
                Decoration.inline(m.from, m.to, {
                  class: i === s.current ? "ygdria-search-current" : "ygdria-search-match",
                }),
              ),
            );
          },
        },
      }),
    ];
  },
});
