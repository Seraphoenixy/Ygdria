import { describe, expect, it } from "vitest";
import { applyMigrations, createDatabase } from "@ygdria/database";
import { SYSTEM_ROOT_PLACEMENT_ID } from "@ygdria/shared";
import { NoteService } from "./index.js";

describe("NoteService.movePlacement", () => {
  it("inserts at the requested sibling index and re-numbers the destination", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const service = new NoteService(db);
    const first = service.create({ title: "First" });
    service.create({ title: "Second" });
    const third = service.create({ title: "Third" });
    const thirdPlacement = service.tree().find((placement: any) => placement.noteId === third.id) as {
      placementId: string;
    };

    service.movePlacement(thirdPlacement.placementId, SYSTEM_ROOT_PLACEMENT_ID, 0);

    const siblings = service.tree().filter((placement: any) =>
      placement.parentPlacementId === SYSTEM_ROOT_PLACEMENT_ID && !placement.isSystem && !placement.isCalendar,
    ) as Array<{ noteId: string; title: string; position: number }>;
    expect(siblings.map((placement) => placement.title)).toEqual(["Third", "First", "Second"]);
    expect(siblings.map((placement) => placement.position)).toEqual([0, 1, 2]);
    expect(siblings.find((placement) => placement.noteId === first.id)?.position).toBe(1);
  });
});
