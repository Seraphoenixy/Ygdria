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

  it("moves selected siblings together while preserving their order", () => {
    const db = createDatabase(":memory:");
    applyMigrations(db.sqlite);
    const service = new NoteService(db);
    const first = service.create({ title: "First" });
    const second = service.create({ title: "Second" });
    const third = service.create({ title: "Third" });
    const parent = service.create({ title: "Parent" });
    const placements = new Map(service.tree().map((item: any) => [item.noteId, item.placementId]));

    service.movePlacements([placements.get(second.id)!, placements.get(third.id)!], placements.get(parent.id)!, 0);

    const children = service.tree().filter((item: any) => item.parentPlacementId === placements.get(parent.id)!);
    expect(children.map((item: any) => item.noteId)).toEqual([second.id, third.id]);
    expect(children.map((item: any) => item.position)).toEqual([0, 1]);
    expect(service.tree().some((item: any) => item.noteId === first.id && item.parentPlacementId === SYSTEM_ROOT_PLACEMENT_ID)).toBe(true);
  });
});
