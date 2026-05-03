export type QueryIntent = "definition" | "usage" | "flow" | "bug" | "general";

export interface AnalyzedQuery {
  raw: string;
  intent: QueryIntent;
  terms: string[];
  filenameTerms: string[];
  mainTerm: string;
}

const STOPWORDS = new Set([
  // english
  "what", "where", "when", "which", "who", "whom", "whose", "why", "how",
  "does", "do", "did", "is", "are", "was", "were", "be", "been", "being",
  "the", "a", "an", "this", "that", "these", "those", "and", "or", "but",
  "for", "with", "from", "into", "onto", "than", "then", "there", "here",
  "have", "has", "had", "can", "could", "would", "should", "will",
  "use", "used", "uses", "using", "make", "made", "get", "got", "set",
  "i", "you", "he", "she", "it", "we", "they", "them", "their", "his", "her",
  "me", "my", "your", "our", "us", "any", "all", "some", "each", "every",
  "about", "above", "below", "after", "before", "again", "also", "only",
  "explain", "describe", "tell", "show", "list", "find",
  // spanish
  "qué", "que", "cómo", "como", "dónde", "donde", "cuándo", "cuando",
  "cuál", "cual", "quién", "quien", "por", "para", "con", "sin",
  "el", "la", "los", "las", "un", "una", "unos", "unas",
  "es", "son", "está", "esta", "estás", "están", "ser", "estar",
  "hace", "hacer", "haces", "hago", "tiene", "tener", "tengo",
  "puede", "poder", "puedo", "y", "o", "pero", "más", "mas",
  "se", "lo", "le", "les", "yo", "tú", "tu", "él", "ella",
  "muy", "tan", "ya", "muy", "todo", "todos", "toda", "todas",
  "este", "esta", "estos", "estas", "ese", "esa", "esos", "esas",
  "donde", "cuando", "porque", "porqué", "mientras",
  "explica", "explicame", "describe", "dime", "muestra", "lista",
]);

const SYNONYMS: Record<string, string[]> = {
  // auth
  login: ["signin", "authenticate", "auth"],
  signin: ["login", "authenticate", "auth"],
  authenticate: ["login", "signin", "auth"],
  auth: ["login", "signin", "authenticate"],
  logout: ["signout"],
  signout: ["logout"],
  password: ["pwd", "passwd"],
  // CRUD
  create: ["add", "insert", "new", "make"],
  add: ["create", "insert", "new"],
  insert: ["create", "add"],
  delete: ["remove", "destroy", "trash"],
  remove: ["delete", "destroy"],
  destroy: ["delete", "remove"],
  update: ["edit", "modify", "patch", "change"],
  edit: ["update", "modify"],
  modify: ["update", "edit"],
  get: ["fetch", "retrieve", "load", "find", "read"],
  fetch: ["get", "retrieve", "load"],
  retrieve: ["get", "fetch", "load"],
  load: ["get", "fetch", "retrieve"],
  find: ["search", "get", "fetch"],
  search: ["find", "query"],
  // common concepts
  user: ["account", "profile", "member"],
  account: ["user", "profile"],
  profile: ["user", "account"],
  config: ["configuration", "settings", "options", "preferences"],
  configuration: ["config", "settings"],
  settings: ["config", "preferences"],
  error: ["err", "exception", "failure"],
  exception: ["error", "failure"],
  // bilingual ES → EN
  usuario: ["user"],
  usuarios: ["users", "user"],
  cuenta: ["account"],
  contraseña: ["password"],
  perfil: ["profile"],
  inicio: ["start", "init"],
  cerrar: ["close", "logout"],
  iniciar: ["start", "init", "login"],
  borrar: ["delete", "remove"],
  eliminar: ["delete", "remove"],
  crear: ["create", "add"],
  agregar: ["add", "create"],
  añadir: ["add", "create"],
  actualizar: ["update", "edit"],
  modificar: ["modify", "update", "edit"],
  obtener: ["get", "fetch"],
  buscar: ["search", "find"],
  guardar: ["save", "store"],
  enviar: ["send", "submit"],
  recibir: ["receive", "get"],
  cargar: ["load", "upload"],
  descargar: ["download"],
  autenticar: ["authenticate", "login", "auth"],
  autentica: ["authenticate", "login", "auth"],
  autenticando: ["authenticate", "login", "auth"],
  autenticado: ["authenticated", "login"],
  autenticación: ["authentication", "auth"],
  autorización: ["authorization", "auth"],
  autorizar: ["authorize", "auth"],
  autoriza: ["authorize", "auth"],
  registrar: ["register", "signup"],
  registra: ["register", "signup"],
  registro: ["register", "signup", "registration"],
  conectar: ["connect", "login"],
  conecta: ["connect", "login"],
  conectado: ["connected"],
  desconectar: ["disconnect", "logout"],
  configuración: ["configuration", "config", "settings"],
  ajustes: ["settings", "config"],
  llamada: ["call"],
  llamadas: ["calls"],
  conexión: ["connection", "connect"],
  desconexión: ["disconnection", "disconnect"],
  estado: ["state", "status"],
  evento: ["event"],
  eventos: ["events"],
  error_es: ["error"],
  pagina: ["page"],
  página: ["page"],
  paginas: ["pages"],
  páginas: ["pages"],
  formulario: ["form"],
  ruta: ["route", "path"],
  rutas: ["routes", "paths"],
  endpoint_es: ["endpoint"],
  componente: ["component"],
  componentes: ["components"],
  servicio: ["service"],
  servicios: ["services"],
  modelo: ["model"],
  modelos: ["models"],
  tabla: ["table"],
  base_datos: ["database", "db"],
  basedatos: ["database", "db"],
  archivo: ["file"],
  archivos: ["files"],
  carpeta: ["folder", "directory"],
  directorio: ["directory", "folder"],
  prueba: ["test"],
  pruebas: ["tests"],
  permiso: ["permission"],
  permisos: ["permissions"],
  rol: ["role"],
  roles: ["roles"],
};

const INTENT_PATTERNS: Array<{ intent: QueryIntent; pattern: RegExp }> = [
  // bug: crashes, fails, throws, broken, error when — checked first (most specific intent)
  {
    intent: "bug",
    pattern: /\b(bug\b|crash(es|ing)?|broken|breaks?\s+(when|on|at\b)?|fails?(ing|\s+when|\s+on|\s+at|\s+to\b)?|throws?\s+(an?\s+)?\w*[Ee]rror|TypeError|ReferenceError|NullPointer|StackOverflow|undefined\s+is\s+not|cannot\s+read\s+propert|not\s+a\s+function|falla(\s+cuando)?|se\s+rompe|no\s+funciona|lanza(\s+un)?\s+error|est[aá]\s+roto|error\s+(en|cuando|al)\b)\b/i,
  },
  // usage: "where is X used", "who calls X", "dónde se usa"
  // (checked first because "donde se X" is more specific than "como")
  {
    intent: "usage",
    pattern: /\b(d[oó]nde\s+se\s+\w+|d[oó]nde\s+aparece|qui[eé]n\s+(usa|llama|invoca|utiliza)|where\s+is\s+\w+\s+(used|called|invoked)|who\s+(uses|calls|invokes)|usages?\s+of|references?\s+to|callers?\s+of)\b/i,
  },
  // flow: anything starting with "cómo" / "how" — covers "cómo se X", "cómo funciona", etc.
  {
    intent: "flow",
    pattern: /\b(c[oó]mo\s+|how\s+(does|do|to|can|should|is)|flujo\s+de|process\s+of|workflow|step.?by.?step|paso\s+a\s+paso)\b/i,
  },
  // definition: "what is X", "qué es X", "qué hace X", "explain X"
  {
    intent: "definition",
    pattern: /\b(qu[eé]\s+(es|hace|son|significa|representa|contiene)|explica|expl[ií]came|defin[ie]|para\s+qu[eé]\s+sirve|what\s+(is|does|are)|describe|explain|definition\s+of)\b/i,
  },
];

export function detectIntent(query: string): QueryIntent {
  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(query)) return intent;
  }
  return "general";
}

function tokenize(query: string): string[] {
  return query
    .split(/[\s\-./\\:?!,;()'"]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));
}

function permutations(words: string[]): string[] {
  if (words.length < 2) return [];
  const out = new Set<string>();

  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i] ?? "";
    const b = words[i + 1] ?? "";
    if (a.length < 3 || b.length < 3) continue;

    const A = a.charAt(0).toUpperCase() + a.slice(1);
    const B = b.charAt(0).toUpperCase() + b.slice(1);

    // snake_case (both directions)
    out.add(`${a}_${b}`);
    out.add(`${b}_${a}`);
    // camelCase
    out.add(`${a}${B}`);
    out.add(`${b}${A}`);
    // PascalCase
    out.add(`${A}${B}`);
    out.add(`${B}${A}`);
  }
  return [...out];
}

export function extractTechnicalTerms(query: string): string[] {
  // priority tiers — populated separately so the final list mixes simple words and compounds
  const technicalIdents = new Set<string>(); // camelCase, PascalCase, snake_case from query
  const simpleWords = new Set<string>();      // plain words + synonyms
  const compounds = new Set<string>();         // generated permutations

  // 1. Technical identifiers extracted verbatim from the query
  for (const t of query.match(/[a-zA-Z][a-z]+(?:[A-Z][a-z0-9]+)+/g) ?? []) technicalIdents.add(t);
  for (const t of query.match(/[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+/g) ?? []) technicalIdents.add(t);
  for (const t of query.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}/g) ?? []) {
    technicalIdents.add(t);
    for (const part of t.split("_")) {
      if (part.length > 3) simpleWords.add(part);
    }
  }
  for (const t of query.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}/g) ?? []) technicalIdents.add(t);

  // 2. Content words from natural language
  const originalWords = tokenize(query).filter((w) => w.length > 3);
  for (const w of originalWords) simpleWords.add(w);

  // 3. Synonyms — added as plain search terms (high value, always include)
  const translatedWords: string[] = [];
  for (const w of originalWords) {
    const key = w.toLowerCase();
    const syns = Object.prototype.hasOwnProperty.call(SYNONYMS, key) ? SYNONYMS[key] : undefined;
    if (syns && Array.isArray(syns) && syns.length > 0) {
      translatedWords.push(syns[0] as string);
      for (const s of syns) {
        if (s.length > 3) simpleWords.add(s);
      }
    } else {
      translatedWords.push(w);
    }
  }

  // 4. Compound permutations within original-language words
  for (const c of permutations(originalWords)) compounds.add(c);

  // 5. Compound permutations within translated words
  const translatedDifferent = translatedWords.some((t, i) => t !== originalWords[i]);
  if (translatedDifferent) {
    for (const c of permutations(translatedWords)) compounds.add(c);
  }

  // Compose the final list mixing tiers.
  // Strategy: technical idents first (highly specific), simple words next (high recall),
  // then compounds (long-tail, may not exist in code).
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (xs: Iterable<string>, max: number) => {
    let count = 0;
    for (const x of xs) {
      if (seen.has(x) || count >= max) continue;
      seen.add(x);
      result.push(x);
      count++;
    }
  };
  push(technicalIdents, 4);
  push(simpleWords, 6);
  push(compounds, 6);

  return result.length > 0 ? result : [query];
}

export function pickMainTerm(terms: string[]): string {
  // most specific term: longest with mixed case (camelCase / PascalCase / snake_case)
  const specific = terms.filter((t) => /[A-Z]/.test(t) || t.includes("_"));
  if (specific.length > 0) {
    return specific.sort((a, b) => b.length - a.length)[0] ?? terms[0] ?? "";
  }
  return terms.sort((a, b) => b.length - a.length)[0] ?? "";
}

export function isDefinitionMatch(code: string, term: string): boolean {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // matches declarations across many languages
  const patterns = [
    // JS/TS/Java/C#/Kotlin/Swift/PHP
    `(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+|public\\s+|private\\s+|protected\\s+|static\\s+|final\\s+|async\\s+)?(?:function|class|interface|type|enum|trait|struct|fn|fun|def|defp|defmodule|impl|protocol|extension|record)\\s+${escaped}\\b`,
    // const X = | let X = | var X =
    `(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*[=:]`,
    // Go: type X struct, func X(
    `^func\\s+${escaped}\\s*\\(`,
    `^func\\s+\\([^)]+\\)\\s+${escaped}\\s*\\(`,
    `^type\\s+${escaped}\\s+`,
    // Ruby: def X, class X, module X
    `^(?:def|class|module)\\s+(?:self\\.)?${escaped}\\b`,
    // Python: def X, class X, async def X
    `^(?:async\\s+)?def\\s+${escaped}\\s*\\(`,
    `^class\\s+${escaped}\\s*[:(\\s]`,
    // Rust: pub fn X, fn X, struct X, enum X, trait X
    `(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escaped}\\b`,
    `(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|impl)\\s+${escaped}\\b`,
  ];
  return patterns.some((p) => new RegExp(p, "m").test(code));
}

export function analyzeQuery(query: string): AnalyzedQuery {
  const intent = detectIntent(query);
  const terms = extractTechnicalTerms(query);
  const mainTerm = pickMainTerm(terms);

  // for filename search, use shorter content words
  const filenameTerms = tokenize(query)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3);

  return { raw: query, intent, terms, filenameTerms, mainTerm };
}
