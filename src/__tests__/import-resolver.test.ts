import * as path from "path";
import {
  findImportSpecifier,
  resolveImportToCandidate,
  attributeReference,
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
