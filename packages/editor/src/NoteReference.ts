import { Node, mergeAttributes } from "@tiptap/core";

export const NoteReference = Node.create({
  name: "noteReference",
  inline: true,
  group: "inline",
  atom: true,
  addAttributes() {
    return {
      noteId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-note-id"),
        renderHTML: (attributes) => ({ "data-note-id": attributes.noteId }),
      },
      title: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-note-title") ?? element.textContent ?? "",
        renderHTML: (attributes) => ({ "data-note-title": attributes.title }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-note-id]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ class: "note-reference", role: "link", tabindex: "0" }, HTMLAttributes),
      node.attrs.title || node.attrs.noteId || "",
    ];
  },
});

/** Route only reference nodes; ordinary links and literal text keep their behavior. */
export function activateNoteReference(
  event: { target: EventTarget | null; preventDefault(): void; stopPropagation(): void },
  onNavigateNote?: (noteId: string) => void,
): boolean {
  if (!onNavigateNote || !(event.target instanceof Element)) return false;
  const reference = event.target.closest<HTMLElement>(".note-reference[data-note-id]");
  const noteId = reference?.dataset.noteId;
  if (!noteId) return false;
  event.preventDefault();
  event.stopPropagation();
  onNavigateNote(noteId);
  return true;
}
