import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.filePath);
  }

  async clear() {
    await this.save({ version: 1, project: null, updatedAt: new Date().toISOString() });
  }
}
