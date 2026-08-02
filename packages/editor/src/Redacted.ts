import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * A presentation-only mark for text that should be obscured until the reader
 * explicitly reveals it. The revealed state lives only in the DOM, so it is
 * never saved with the document.
 */
export const Redacted = Mark.create({
  name: "redacted",
  parseHTML() {
    return [{ tag: "span[data-ygdria-redacted]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "ygdria-redacted", "data-ygdria-redacted": "" }, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      toggleRedacted: () => ({ commands }: { commands: any }) => commands.toggleMark(this.name),
    } as any;
  },
});
