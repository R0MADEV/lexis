import * as path from "path";
import {
  findImportSpecifier,
  resolveImportToCandidate,
  attributeReference,
  attributeReferences,
} from "../core/import-resolver";

const ROOT = "/proj";
const p = (rel: string) => path.join(ROOT, rel);

describe("findImportSpecifier", () => {
  test("named import", () => {
    expect(findImportSpecifier(`import { handleClick } from './Home';`, "handleClick")).toBe("./Home");
  });

  test("aliased import still binds the original name", () => {
    expect(findImportSpecifier(`import { handleClick as hc } from "../ui/Home";`, "handleClick")).toBe("../ui/Home");
  });

  test("default import", () => {
    expect(findImportSpecifier(`import handleClick from './Home';`, "handleClick")).toBe("./Home");
  });

  test("multiline import clause", () => {
    const src = `import {\n  other,\n  handleClick,\n} from './Home';`;
    expect(findImportSpecifier(src, "handleClick")).toBe("./Home");
  });

  test("re-export counts as a binding", () => {
    expect(findImportSpecifier(`export { handleClick } from './Home';`, "handleClick")).toBe("./Home");
  });

  test("python from-import", () => {
    expect(findImportSpecifier(`from .home import handle_click`, "handle_click")).toBe(".home");
    expect(findImportSpecifier(`from app.home import handle_click, other`, "handle_click")).toBe("app.home");
  });

  test("rust and php use statements", () => {
    expect(findImportSpecifier(`use crate::home::handle_click;`, "handle_click")).toBe("crate::home::handle_click");
    expect(findImportSpecifier(`use App\\Home\\HandleClick;`, "HandleClick")).toBe("App\\Home\\HandleClick");
  });

  test("returns null when the symbol is not imported", () => {
    expect(findImportSpecifier(`import { other } from './Home';\nhandleClick();`, "handleClick")).toBeNull();
  });

  test("namespace import does not name the symbol", () => {
    expect(findImportSpecifier(`import * as ui from './Home';`, "handleClick")).toBeNull();
  });

  test("a bare import without 'from' does not swallow later statements", () => {
    const src = `import './polyfill';\nconst handleClick = 1;\nimport { other } from './Home';`;
    expect(findImportSpecifier(src, "handleClick")).toBeNull();
  });
});

describe("resolveImportToCandidate", () => {
  test("relative specifier picks the candidate whose extension matches", () => {
    const from = p("src/app/Dashboard.tsx");
    const candidates = [p("src/app/Home.tsx"), p("src/admin/Home.tsx")];
    expect(resolveImportToCandidate(from, "./Home", candidates)).toBe(p("src/app/Home.tsx"));
  });

  test("walks up with ../", () => {
    const from = p("src/app/deep/Widget.ts");
    const candidates = [p("src/app/Home.ts"), p("src/other/Home.ts")];
    expect(resolveImportToCandidate(from, "../Home", candidates)).toBe(p("src/app/Home.ts"));
  });

  test("resolves a directory import to its index file", () => {
    const from = p("src/app/Dashboard.ts");
    const candidates = [p("src/app/home/index.ts"), p("src/other/Home.ts")];
    expect(resolveImportToCandidate(from, "./home", candidates)).toBe(p("src/app/home/index.ts"));
  });

  test("python relative import", () => {
    const from = p("app/views/dashboard.py");
    const candidates = [p("app/views/home.py"), p("app/home.py")];
    expect(resolveImportToCandidate(from, ".home", candidates)).toBe(p("app/views/home.py"));
    expect(resolveImportToCandidate(from, "..home", candidates)).toBe(p("app/home.py"));
  });

  test("python dotted absolute import matches by path suffix", () => {
    const from = p("app/views/dashboard.py");
    const candidates = [p("app/core/home.py"), p("vendor/home.py")];
    expect(resolveImportToCandidate(from, "app.core.home", candidates)).toBe(p("app/core/home.py"));
  });

  test("php PSR-4: trailing namespace segments mirror directories", () => {
    const from = p("src/Handler/UserHandler.php");
    const candidates = [p("src/Home/Widget.php"), p("vendor/acme/Widget.php")];
    expect(resolveImportToCandidate(from, "App\\Home\\Widget", candidates)).toBe(p("src/Home/Widget.php"));
  });

  test("php: the namespace prefix need not match the directory it maps to", () => {
    const from = p("src/Handler/UserHandler.php");
    const candidates = [p("lib/Domain/Order/Line.php")];
    expect(resolveImportToCandidate(from, "Acme\\Domain\\Order\\Line", candidates)).toBe(p("lib/Domain/Order/Line.php"));
  });

  test("rust: crate:: is the crate src root, and the last segment is the item", () => {
    const from = p("src/main.rs");
    const candidates = [p("src/home.rs"), p("src/admin/home.rs")];
    expect(resolveImportToCandidate(from, "crate::home::handle_click", candidates)).toBe(p("src/home.rs"));
  });

  test("rust: resolves a module directory to its mod.rs", () => {
    const from = p("src/main.rs");
    const candidates = [p("src/home/mod.rs")];
    expect(resolveImportToCandidate(from, "crate::home::handle_click", candidates)).toBe(p("src/home/mod.rs"));
  });

  test("rust: nested module path", () => {
    const from = p("src/main.rs");
    const candidates = [p("src/ui/home.rs"), p("src/api/home.rs")];
    expect(resolveImportToCandidate(from, "crate::ui::home::handle_click", candidates)).toBe(p("src/ui/home.rs"));
  });

  test("a suffix that fits two candidates resolves to nothing rather than a guess", () => {
    const from = p("src/main.rs");
    const candidates = [p("a/home/Widget.php"), p("b/home/Widget.php")];
    expect(resolveImportToCandidate(from, "App\\home\\Widget", candidates)).toBeNull();
  });

  test("returns null for a package import it cannot map to a file", () => {
    const from = p("src/app/Dashboard.ts");
    expect(resolveImportToCandidate(from, "react", [p("src/app/Home.ts")])).toBeNull();
  });

  test("returns null when no candidate matches the resolved path", () => {
    const from = p("src/app/Dashboard.ts");
    expect(resolveImportToCandidate(from, "./Missing", [p("src/app/Home.ts")])).toBeNull();
  });
});

describe("attributeReference", () => {
  test("a local definition wins over any import", () => {
    const from = p("src/app/Home.tsx");
    const candidates = [p("src/app/Home.tsx"), p("src/admin/Home.tsx")];
    expect(attributeReference(from, `import { handleClick } from '../admin/Home';`, "handleClick", candidates))
      .toEqual({ file: p("src/app/Home.tsx"), via: "local" });
  });

  test("attributes through the import when there is no local definition", () => {
    const from = p("src/app/Dashboard.tsx");
    const candidates = [p("src/app/Home.tsx"), p("src/admin/Home.tsx")];
    expect(attributeReference(from, `import { handleClick } from '../admin/Home';`, "handleClick", candidates))
      .toEqual({ file: p("src/admin/Home.tsx"), via: "import" });
  });

  test("returns null when nothing binds it — a method call, dynamic dispatch, same-package", () => {
    const from = p("src/app/Dashboard.tsx");
    const candidates = [p("src/app/Home.tsx"), p("src/admin/Home.tsx")];
    expect(attributeReference(from, `this.widget.handleClick();`, "handleClick", candidates)).toBeNull();
  });

  test("a single candidate needs no attribution work", () => {
    const from = p("src/app/Dashboard.tsx");
    const candidates = [p("src/app/Home.tsx")];
    expect(attributeReference(from, `handleClick();`, "handleClick", candidates))
      .toEqual({ file: p("src/app/Home.tsx"), via: "only-definition" });
  });
});

describe("attributeReferences", () => {
  const defs = [p("src/admin/Home.ts"), p("src/app/Home.ts")];
  const contents: Record<string, string> = {
    [p("src/admin/Panel.ts")]: `import { handleClick } from './Home';`,
    [p("src/app/Board.ts")]: `import { handleClick } from './Home';`,
    [p("src/legacy/old.ts")]: `widget.handleClick();`,
  };
  const read = (f: string) => contents[f] ?? "";

  test("splits references by the definition each file binds to", () => {
    const refs = [
      { file: p("src/admin/Panel.ts"), line: 1 },
      { file: p("src/app/Board.ts"), line: 1 },
    ];
    const out = attributeReferences(refs, "handleClick", defs, read);
    expect(out.byDefinition.get(p("src/admin/Home.ts"))).toEqual([refs[0]]);
    expect(out.byDefinition.get(p("src/app/Home.ts"))).toEqual([refs[1]]);
    expect(out.unattributed).toEqual([]);
  });

  test("keeps what it cannot bind in a separate bucket instead of guessing", () => {
    const refs = [{ file: p("src/legacy/old.ts"), line: 1 }];
    const out = attributeReferences(refs, "handleClick", defs, read);
    expect(out.unattributed).toEqual(refs);
    expect(out.byDefinition.size).toBe(0);
  });

  test("a reference living in a definition file belongs to that definition", () => {
    const refs = [{ file: p("src/app/Home.ts"), line: 1 }];
    const out = attributeReferences(refs, "handleClick", defs, read);
    expect(out.byDefinition.get(p("src/app/Home.ts"))).toEqual(refs);
  });

  test("never reads a file when there is nothing to disambiguate", () => {
    let reads = 0;
    const counting = (f: string) => { reads++; return read(f); };
    const refs = [{ file: p("src/app/Board.ts"), line: 1 }];
    const out = attributeReferences(refs, "handleClick", [p("src/app/Home.ts")], counting);
    expect(reads).toBe(0);
    expect(out.byDefinition.get(p("src/app/Home.ts"))).toEqual(refs);
  });
});
