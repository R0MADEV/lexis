import * as fs from "fs";
import { Index } from "../../core/indexer";
import { indexFilePath, legacyIndexPath, migrateIfNeeded } from "./paths";

export function saveIndex(index: Index, projectPath: string): void {
  fs.writeFileSync(indexFilePath(projectPath), JSON.stringify(index));
}

export function loadIndex(projectPath: string): Index | null {
  const central = indexFilePath(projectPath);
  // Migrate legacy .lexis-index.json from inside the project on first read.
  migrateIfNeeded(legacyIndexPath(projectPath), central);

  if (!fs.existsSync(central)) return null;
  try {
    return JSON.parse(fs.readFileSync(central, "utf-8")) as Index;
  } catch {
    return null;
  }
}
