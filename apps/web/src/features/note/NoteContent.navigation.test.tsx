// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { markdownToTiptap } from "@ygdria/editor";
import type { YgdriaClient } from "@ygdria/api-client";
import { NoteContent } from "./NoteContent";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

it.each([false, true])("routes existing note references to workspace navigation when editing=%s", async (editing) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const navigate = vi.fn();
  const queryClient = new QueryClient();
  await act(async () => root!.render(
    <QueryClientProvider client={queryClient}>
      <NoteContent
        note={{ id: "source", title: "Source", content: markdownToTiptap("[[note:destination|阅读资源]]").document }}
        editing={editing}
        isTrashed={false}
        locale="zh-CN"
        childNotes={[]}
        childrenByParent={new Map()}
        client={{} as YgdriaClient}
        onSaveContent={vi.fn()}
        onSaveTitle={vi.fn()}
        onOpenChild={vi.fn()}
        onChildMore={vi.fn()}
        onUnarchive={vi.fn()}
        onNavigateNote={navigate}
      />
    </QueryClientProvider>,
  ));
  const link = host.querySelector<HTMLElement>("[data-note-id=destination]");
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  expect(navigate).toHaveBeenCalledExactlyOnceWith("destination");
  queryClient.clear();
});
