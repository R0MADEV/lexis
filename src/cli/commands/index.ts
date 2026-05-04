import * as path from "path";
import { indexProject } from "../../core/indexer";
import { loadIndex, saveIndex } from "../../adapters/storage/index-file";
import { indexFilePath } from "../../adapters/storage/paths";

export async function indexCommand(projectPath: string, opts?: { full?: boolean }): Promise<void> {
  // Reuse previous index for incremental scan unless --full was passed
  const previous = opts?.full ? null : loadIndex(projectPath);
  const mode = previous ? "incremental" : "full";
  console.log(`Indexing (${mode}): ${projectPath}`);

  const index = indexProject(projectPath, previous);
  saveIndex(index, projectPath);

  const extCount: Record<string, number> = {};
  for (const file of index.files) {
    const ext = path.extname(file).toLowerCase() || "(none)";
    extCount[ext] = (extCount[ext] ?? 0) + 1;
  }
  const topLangs = Object.entries(extCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ext, count]) => `${ext}(${count})`)
    .join("  ");

  console.log(`Symbols: ${index.symbols.length}  Files: ${index.files.length}`);
  console.log(`Languages: ${topLangs}`);
  console.log(`Saved: ${indexFilePath(projectPath)}`);
}
