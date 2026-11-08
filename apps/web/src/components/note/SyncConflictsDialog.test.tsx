import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { SyncConflictsDialog } from "./SyncConflictsDialog.js";
import type { SyncConflict } from "../../hooks/useSync.js";

const client = {} as Parameters<typeof SyncConflictsDialog>[0]["client"];
const remoteClient = {} as Parameters<typeof SyncConflictsDialog>[0]["remoteClient"];

function para(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function conflict(overrides: Partial<SyncConflict>): SyncConflict {
  return {
    noteId: "n1",
    peerId: "remote",
    direction: "upload",
    detectedAt: 0,
    title: "标题",
    noteType: "text",
    isProtected: false,
    mineContent: para("本机正文"),
    mineVersion: 2,
    mineUpdatedAt: 0,
    theirsUpdatedAt: 0,
    theirsVersion: 1,
    ...overrides,
  };
}

function renderDialog(conflicts: SyncConflict[]) {
  return renderToString(
    <SyncConflictsDialog
      conflicts={conflicts}
      client={client}
      remoteClient={remoteClient}
      locale="zh-CN"
      onResolve={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("SyncConflictsDialog (SSR render)", () => {
  it("renders the title diff, direction legend and snapshot diff without any remote fetch", () => {
    const html = renderDialog([
      conflict({
        direction: "download",
        title: "本机标题",
        mineContent: para("本机正文"),
        theirsTitle: "远端标题",
        theirsContent: para("远端正文"),
        theirsVersion: 3,
      }),
    ]);
    expect(html).toContain("标题</span>");
    expect(html).toContain("远端标题");
    expect(html).toContain("本机正文");
    expect(html).toContain("远端正文");
    // Download direction swaps the legend wording; upload wording stays absent.
    expect(html).toContain("远端的修改");
    expect(html).toContain("本机的修改");
    expect(html).not.toContain("远端保留的版本");
  });

  it("keeps the upload legend and hides the no-difference hint when only the title changed", () => {
    const html = renderDialog([
      conflict({ title: "新标题", mineContent: para("同一段正文"), theirsTitle: "旧标题", theirsContent: para("同一段正文") }),
    ]);
    expect(html).toContain("远端保留的版本");
    expect(html).toContain("旧标题");
    expect(html).not.toContain("无差异");
  });

  it("falls back to the live remote fetch for legacy records without a snapshot", () => {
    const html = renderDialog([conflict({ theirsContent: undefined, theirsTitle: undefined })]);
    expect(html).toContain("正在加载");
    expect(html).not.toContain("本机正文");
  });
});
