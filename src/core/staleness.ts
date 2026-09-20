// Which directories to watch for files that appeared since the last index.
//
// Creating a file updates the mtime of the directory it lands in — and only
// that one. The previous check scanned the project root and its first-level
// directories, on the stated assumption that this "covers any language or
// framework structure". It does not: src/core/new.ts bumps src/core, never src,
// so in a real layout, where almost every new file is two or more levels deep,
// new files were invisible until something already indexed happened to change.
//
// Every directory holding an indexed file is watched instead, plus its
// ancestors up to the project root — so a brand-new subdirectory is caught by
// the parent that now contains it.

import * as path from "path";

export function watchedDirectories(root: string, files: string[]): string[] {
  const watched = new Set<string>();

  for (const file of files) {
    let dir = path.dirname(file);
    // Walk up to the root inclusive; stop if the path leaves the project.
    while (dir.startsWith(root)) {
      if (watched.has(dir)) break;  // this branch is already covered
      watched.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;    // filesystem root, nothing above it
      dir = parent;
    }
  }

  return [...watched];
}
