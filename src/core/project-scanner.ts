import * as fs from "fs";
import * as path from "path";

export interface ProjectStructure {
  topLevelDirs: string[];
  entryPoints: string[];
  routers: string[];
  configFiles: string[];
  projectType: string;
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "coverage", ".cache", "tmp", "vendor", "target", ".svelte-kit",
  "__pycache__", ".tox", "venv", ".venv", ".bundle",
]);

const ENTRY_POINT_NAMES = new Set([
  // JS / TS
  "main.ts", "main.js", "index.ts", "index.js",
  "app.ts", "app.js", "server.ts", "server.js",
  // Python
  "main.py", "app.py", "wsgi.py", "asgi.py", "manage.py", "run.py",
  // Go
  "main.go",
  // Rust
  "main.rs",
  // Ruby
  "app.rb", "config.ru", "application.rb",
  // PHP
  "index.php", "artisan",
  // Java / Kotlin
  "Application.java", "Application.kt", "Main.java", "Main.kt",
  // C / C++
  "main.c", "main.cpp",
  // Swift
  "main.swift",
]);

const ROUTER_DIR_NAMES = new Set([
  "routes", "router", "routers", "routing",
  "controllers", "controller",
  "handlers", "handler",
  "endpoints", "endpoint",
  "views",       // Django, Flask, Rails
  "urls",        // Django
]);

const ROUTER_FILE_NAMES = new Set([
  "routes.ts", "routes.js", "routes.rb",
  "router.ts", "router.js",
  "urls.py",                    // Django
  "web.php", "api.php",         // Laravel
  "routes.go",                  // Go
]);

const CONFIG_FILE_NAMES = new Set([
  // JS / TS
  "package.json", "tsconfig.json",
  "vite.config.ts", "vite.config.js",
  "next.config.ts", "next.config.js",
  "nuxt.config.ts", "nuxt.config.js",
  "svelte.config.js",
  "webpack.config.js",
  ".babelrc", "babel.config.js",
  // Go
  "go.mod", "go.sum",
  // Rust
  "Cargo.toml",
  // Python
  "pyproject.toml", "setup.py", "setup.cfg",
  "requirements.txt", "Pipfile",
  // PHP
  "composer.json",
  // Ruby
  "Gemfile",
  // Java
  "pom.xml", "build.gradle", "build.gradle.kts",
  "settings.gradle", "settings.gradle.kts",
  // General
  ".env", "Makefile", "Dockerfile",
  "docker-compose.yml", "docker-compose.yaml",
]);

export function scanProjectStructure(projectPath: string): ProjectStructure {
  const topLevelDirs: string[] = [];
  const entryPoints: string[] = [];
  const routers: string[] = [];
  const configFiles: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return { topLevelDirs: [], entryPoints: [], routers: [], configFiles: [], projectType: "unknown" };
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;

    const full = path.join(projectPath, entry.name);

    if (entry.isDirectory()) {
      topLevelDirs.push(entry.name);
      if (ROUTER_DIR_NAMES.has(entry.name.toLowerCase())) {
        routers.push(entry.name + "/");
      }
      scanTwoLevelsDeep(full, entry.name, entryPoints, routers);
    } else if (entry.isFile()) {
      if (ENTRY_POINT_NAMES.has(entry.name)) entryPoints.push(entry.name);
      if (CONFIG_FILE_NAMES.has(entry.name)) configFiles.push(entry.name);
      if (ROUTER_FILE_NAMES.has(entry.name)) routers.push(entry.name);
    }
  }

  return {
    topLevelDirs,
    entryPoints,
    routers,
    configFiles,
    projectType: detectProjectType(configFiles, topLevelDirs, entryPoints),
  };
}

function scanTwoLevelsDeep(
  dir: string,
  parentName: string,
  entryPoints: string[],
  routers: string[]
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const rel = `${parentName}/${entry.name}`;

    if (entry.isDirectory()) {
      // Second level
      let subEntries: fs.Dirent[];
      try {
        subEntries = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (!sub.isFile()) continue;
        const subRel = `${rel}/${sub.name}`;
        if (ENTRY_POINT_NAMES.has(sub.name)) entryPoints.push(subRel);
        if (ROUTER_FILE_NAMES.has(sub.name)) routers.push(subRel);
      }
    } else if (entry.isFile()) {
      if (ENTRY_POINT_NAMES.has(entry.name)) entryPoints.push(rel);
      if (ROUTER_FILE_NAMES.has(entry.name)) routers.push(rel);
      if (parentName === "config" && (entry.name === "routes.rb" || entry.name === "urls.py")) {
        routers.push(rel);
      }
    }
  }
}

function detectProjectType(configFiles: string[], topLevelDirs: string[], entryPoints: string[]): string {
  const has = (f: string) => configFiles.includes(f);
  const hasDir = (d: string) => topLevelDirs.includes(d);
  const hasEntry = (f: string) => entryPoints.some((e) => e === f || e.endsWith(`/${f}`));

  const hasFrontend = ["src", "pages", "components", "views", "frontend", "client", "web", "app"].some(hasDir);
  const hasBackend = ["api", "server", "backend", "internal", "pkg", "cmd"].some(hasDir);

  if (has("next.config.ts") || has("next.config.js")) return "Next.js";
  if (has("nuxt.config.ts") || has("nuxt.config.js")) return "Nuxt.js";
  if (has("svelte.config.js")) return "SvelteKit";

  if (has("package.json") && hasBackend && hasFrontend) return "fullstack (Node.js)";
  if (has("package.json")) return "Node.js / TypeScript";

  if (has("go.mod") && hasFrontend) return "fullstack (Go + frontend)";
  if (has("go.mod")) return "Go";

  if (has("Cargo.toml")) return "Rust";

  if (has("pyproject.toml") || has("requirements.txt") || has("Pipfile")) {
    if (hasFrontend) return "fullstack (Python + frontend)";
    if (hasEntry("manage.py")) return "Django";
    return "Python";
  }

  if (has("composer.json")) {
    if (hasFrontend) return "fullstack (PHP + frontend)";
    return "PHP";
  }

  if (has("Gemfile")) {
    if (hasDir("app")) return "Ruby on Rails";
    return "Ruby";
  }

  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) {
    if (hasFrontend) return "fullstack (Java + frontend)";
    return "Java / Kotlin";
  }

  return "unknown";
}

export function formatProjectStructure(structure: ProjectStructure, _lang: string): string {
  const lines: string[] = [];
  lines.push(`PROJECT STRUCTURE (type: ${structure.projectType})`);
  if (structure.topLevelDirs.length > 0)
    lines.push(`Directories: ${structure.topLevelDirs.join(", ")}`);
  if (structure.entryPoints.length > 0)
    lines.push(`Entry points: ${structure.entryPoints.join(", ")}`);
  if (structure.routers.length > 0)
    lines.push(`Routers: ${structure.routers.join(", ")}`);
  if (structure.configFiles.length > 0)
    lines.push(`Config files: ${structure.configFiles.join(", ")}`);
  return lines.join("\n");
}
