import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Desktop-local preference; never synced or stored in the note database. */
export class EtapiAccess {
  private enabled = false;
  constructor(private readonly storePath?: string) {
    if (!storePath || !existsSync(storePath)) return;
    try {
      this.enabled = JSON.parse(readFileSync(storePath, "utf8")).enabled === true;
    } catch {
      /* Missing or invalid local state stays disabled. */
    }
  }
  getState() {
    return { enabled: this.enabled };
  }
  setEnabled(enabled: boolean) {
    if (this.storePath) {
      mkdirSync(dirname(this.storePath), { recursive: true });
      const temporary = `${this.storePath}.tmp`;
      writeFileSync(temporary, JSON.stringify({ enabled }));
      renameSync(temporary, this.storePath);
    }
    this.enabled = enabled;
    return this.getState();
  }
}
