import { describe, expect, it } from "vitest";
import { createDatabase } from "./index.js";
import { applyMigrations } from "./migrations.js";
import {
  pruneNoteRevisions,
  readRetentionPolicy,
  writeRetentionPolicy,
} from "./retention-policy.js";
import {
  advanceCursor,
  expireInactivePeers,
  pruneChangeLog,
  recordChange,
} from "./sync-change-log.js";
import { pruneSyncTombstones } from "./sync-maintenance.js";
import { SYSTEM_ROOT_NOTE_ID } from "@ygdria/shared";

function database() {
  const { sqlite } = createDatabase(":memory:");
  applyMigrations(sqlite);
  return sqlite;
}

describe("server retention", () => {
  it("persists policy and logs revision deletions inside the writer transaction", () => {
    const sqlite = database();
    try {
      const policy = { revisionLimit: 2, trashRetentionMs: 1000, attachmentRetentionMs: 0 };
      writeRetentionPolicy(sqlite, policy);
      expect(readRetentionPolicy(sqlite)).toEqual(policy);
      const insert = sqlite.prepare(
        "INSERT INTO revisions(id,note_id,content_data,content_codec,content_hash,created_at) VALUES(?,?,?,'identity',?,?)",
      );
      for (let i = 0; i < 6; i++)
        insert.run(`r${i}`, SYSTEM_ROOT_NOTE_ID, Buffer.from("{}"), `h${i}`, i);
      sqlite.transaction(() => expect(pruneNoteRevisions(sqlite, SYSTEM_ROOT_NOTE_ID)).toBe(4))();
      expect(sqlite.prepare("SELECT id FROM revisions ORDER BY id").all()).toEqual([
        { id: "r4" },
        { id: "r5" },
      ]);
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) c FROM sync_change_log WHERE entity_type='revision' AND change_kind='deleted'",
          )
          .get(),
      ).toEqual({ c: 4 });
      expect(() => writeRetentionPolicy(sqlite, { ...policy, revisionLimit: -2 })).toThrow(
        RangeError,
      );
    } finally {
      sqlite.close();
    }
  });

  it("expires a reachable peer whose unconsumed cursor has stopped progressing", () => {
    const sqlite = database();
    try {
      const now = Date.now();
      advanceCursor(sqlite, "stalled", 0);
      sqlite
        .prepare("UPDATE sync_cursors SET last_progress_at=? WHERE peer_id='stalled'")
        .run(now - 2000);
      advanceCursor(sqlite, "stalled", 0);
      expect(expireInactivePeers(sqlite, { now, maxInactiveMs: 1000 })).toEqual(["stalled"]);
      advanceCursor(sqlite, "caught-up", 1);
      sqlite
        .prepare("UPDATE sync_cursors SET last_progress_at=? WHERE peer_id='caught-up'")
        .run(now - 2000);
      expect(expireInactivePeers(sqlite, { now, maxInactiveMs: 1000 })).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("releases old history without peers and retains final pending uploads with a local out cursor", () => {
    const sqlite = database();
    try {
      const now = Date.now();
      for (let i = 0; i < 8; i++) recordChange(sqlite, "note", "offline", "updated", now - 2000);
      advanceCursor(sqlite, "out:https://remote", 0);
      expect(pruneChangeLog(sqlite, { now, maxInactiveMs: 1000 })).toBe(7);
      expect(
        sqlite.prepare("SELECT COUNT(*) c FROM sync_change_log WHERE entity_id='offline'").get(),
      ).toEqual({ c: 1 });
      sqlite.prepare("DELETE FROM sync_cursors").run();
      expect(pruneChangeLog(sqlite, { now, maxInactiveMs: 1000 })).toBe(1);
    } finally {
      sqlite.close();
    }
  });
  it("deletes unacknowledged tombstones immediately at cursor zero", () => {
    const sqlite = database();
    try {
      advanceCursor(sqlite, "waiting", 0);
      sqlite
        .prepare(
          "INSERT INTO sync_rebaseline_required(peer_id,reason,created_at) VALUES('expired','test',0)",
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO sync_tombstones(entity_type,entity_id,deleted_at,change_log_id) VALUES('setting','old',0,1)",
        )
        .run();
      expect(
        pruneSyncTombstones(sqlite, { tombstoneMinRetentionMs: 365 * 24 * 60 * 60 * 1000 }),
      ).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) c FROM sync_tombstones").get()).toEqual({ c: 0 });
    } finally {
      sqlite.close();
    }
  });
});
