import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { YgdriaCodeBlock } from "./CodeBlock.js";

/** A one-block editor for raw code notes. Its ProseMirror document is only a
 * view model: callers receive the block's source and language separately. */
export function CodeNoteEditor({ code, language = "auto", onChange }: {
  code: string;
  language?: string;
  onChange: (code: string, language: string) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ codeBlock: false }), YgdriaCodeBlock],
    content: { type: "doc", content: [{ type: "codeBlock", attrs: { language }, content: code ? [{ type: "text", text: code }] : [] }] },
    onUpdate: ({ editor }) => {
      const block = editor.state.doc.firstChild;
      onChange(block?.textContent ?? "", String(block?.attrs.language ?? "auto"));
    },
    editorProps: { attributes: { class: "ygdria-document ygdria-editor code-note-document", spellcheck: "false" } },
  });
  useEffect(() => () => editor?.destroy(), [editor]);
  return <EditorContent editor={editor} />;
}
