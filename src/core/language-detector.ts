import * as path from "path";

export interface LanguageContext {
  language: string;
  frameworks: string[];
  genericKeywords: Set<string>;
}

const BASE_KEYWORDS = new Set([
  "true", "false", "null", "undefined", "import", "export", "return",
  "default", "from", "async", "await", "const", "let", "var", "function",
  "class", "interface", "extends", "implements", "new", "this", "super",
  "public", "private", "protected", "static", "void", "string", "number",
  "boolean", "object", "type", "typeof", "instanceof", "if", "else",
  "for", "while", "switch", "case", "break", "continue", "try", "catch",
]);

const KEYWORDS_BY_LANGUAGE: Record<string, string[]> = {
  typescript: [
    "useState", "useEffect", "useCallback", "useMemo", "useRef", "useContext",
    "useReducer", "useLayoutEffect", "console", "Promise", "Array", "Object",
    "String", "Number", "Boolean", "Math", "JSON", "Error", "parseInt",
    "parseFloat", "setTimeout", "setInterval", "process", "Buffer",
  ],
  python: [
    "self", "None", "True", "False", "print", "range", "list", "dict",
    "tuple", "set", "isinstance", "hasattr", "getattr", "setattr", "super",
    "property", "classmethod", "staticmethod", "lambda", "assert", "pass",
    "with", "open", "len", "str", "int", "float", "bool", "type", "input",
  ],
  rust: [
    "Some", "None", "Result", "Option", "unwrap", "expect", "match",
    "impl", "trait", "panic", "println", "clone", "into", "iter",
    "collect", "map", "filter", "vec", "String", "usize", "i32",
    "Ok", "Err", "Box", "Arc", "Mutex", "Rc", "RefCell",
  ],
  go: [
    "make", "append", "copy", "close", "delete", "panic", "recover",
    "chan", "defer", "select", "goroutine", "error", "string", "int",
    "bool", "float64", "rune", "byte", "interface", "struct", "range",
    "len", "cap", "nil", "iota", "fallthrough",
  ],
  php: [
    "echo", "print", "isset", "empty", "unset", "array", "null",
    "public", "private", "protected", "static", "abstract", "final",
    "namespace", "use", "require", "include", "foreach", "list",
    "self", "parent", "match", "fn", "throw", "yield",
  ],
  java: [
    "System", "String", "Integer", "Boolean", "List", "Map", "Set",
    "ArrayList", "HashMap", "Optional", "void", "throws", "final",
    "synchronized", "volatile", "transient", "native", "instanceof",
    "super", "this", "new", "null", "enum", "interface",
  ],
  kotlin: [
    "companion", "object", "data", "sealed", "suspend", "fun",
    "flow", "stateflow", "lateinit", "override", "open", "inner",
    "val", "var", "when", "init", "by", "lazy", "also", "let", "run", "apply",
  ],
  swift: [
    "guard", "defer", "lazy", "weak", "strong", "protocol", "extension",
    "override", "mutating", "inout", "willSet", "didSet", "subscript",
    "optional", "unwrap", "nil", "self", "init", "deinit",
  ],
  ruby: [
    "puts", "require", "attr_accessor", "attr_reader", "initialize",
    "each", "times", "map", "select", "reject", "nil", "block",
    "yield", "raise", "rescue", "ensure", "begin", "end", "do",
    "self", "super", "include", "extend", "prepend",
  ],
  csharp: [
    "Console", "String", "Int32", "Boolean", "List", "Dictionary",
    "Task", "async", "await", "override", "virtual", "abstract",
    "sealed", "readonly", "partial", "event", "delegate", "linq",
    "var", "null", "this", "base", "new", "typeof", "nameof",
  ],
  c: [
    "printf", "scanf", "malloc", "free", "sizeof", "NULL", "void",
    "int", "char", "float", "double", "struct", "typedef", "enum",
    "return", "include", "define", "ifdef", "ifndef", "endif",
  ],
  dart: [
    "Widget", "BuildContext", "State", "StatelessWidget", "StatefulWidget",
    "MaterialApp", "Scaffold", "Container", "Column", "Row",
    "Future", "Stream", "async", "await", "null", "void", "dynamic",
    "final", "const", "late", "required",
  ],
  scala: [
    "val", "var", "def", "object", "trait", "case", "match", "Option",
    "Some", "None", "List", "Map", "Seq", "Future", "implicit", "override",
    "sealed", "abstract", "extends", "with", "yield", "for",
  ],
  elixir: [
    "do", "end", "def", "defp", "defmodule", "defstruct", "alias",
    "import", "use", "require", "nil", "true", "false", "when",
    "case", "cond", "if", "receive", "spawn", "send", "pid",
  ],
};

const KEYWORDS_BY_FRAMEWORK: Record<string, string[]> = {
  react: [
    "useState", "useEffect", "useCallback", "useMemo", "useRef",
    "useContext", "useReducer", "useLayoutEffect", "useImperativeHandle",
    "useTranslation", "useNavigate", "useParams", "useLocation",
    "useSelector", "useDispatch", "useQuery", "useMutation",
    "createElement", "Fragment", "StrictMode", "Suspense", "forwardRef",
  ],
  vue: [
    "defineComponent", "defineProps", "defineEmits", "defineExpose",
    "computed", "watch", "watchEffect", "onMounted", "onUnmounted",
    "onCreated", "onUpdated", "reactive", "readonly", "toRefs", "toRef",
    "nextTick", "inject", "provide", "ref", "shallowRef",
  ],
  angular: [
    "Component", "Injectable", "NgModule", "Directive", "Pipe",
    "Input", "Output", "OnInit", "OnDestroy", "ViewChild", "HostListener",
    "ActivatedRoute", "HttpClient", "Observable", "Subject",
    "BehaviorSubject", "takeUntil", "subscribe", "unsubscribe",
  ],
  svelte: [
    "onMount", "onDestroy", "beforeUpdate", "afterUpdate", "tick",
    "writable", "readable", "derived", "get", "setContext", "getContext",
    "createEventDispatcher",
  ],
  nestjs: [
    "Controller", "Injectable", "Module", "Get", "Post", "Put", "Delete",
    "Patch", "Body", "Param", "Query", "Headers", "UseGuards", "UseInterceptors",
    "UsePipes", "UseFilters", "HttpException", "HttpStatus",
  ],
  fastify: [
    "fastify", "register", "addHook", "decorateRequest", "decorateReply",
    "setErrorHandler", "setNotFoundHandler", "schema", "preHandler",
  ],
  express: [
    "router", "middleware", "listen", "require", "module", "exports",
    "process", "Buffer", "EventEmitter", "next", "app",
  ],
  laravel: [
    "Route", "Request", "Response", "Eloquent", "Schema", "Migration",
    "Seeder", "Factory", "Collection", "Facade", "Auth", "Gate",
    "Policy", "Event", "Listener", "Queue", "artisan", "blade",
    "config", "session", "redirect", "view", "Controller", "Model",
  ],
  symfony: [
    "Container", "Kernel", "Bundle", "Service", "Repository",
    "EntityManager", "Doctrine", "Twig", "FormType", "Validator",
    "Security", "EventDispatcher", "HttpFoundation", "Console",
    "autowire", "inject", "tagged",
  ],
  django: [
    "HttpResponse", "JsonResponse", "render", "redirect", "reverse",
    "queryset", "serializer", "forms", "views", "urls", "signals",
    "migrations", "admin", "models", "settings", "request",
  ],
  flask: [
    "app", "route", "jsonify", "request", "abort", "Blueprint",
    "render_template", "url_for", "flash", "session", "current_app",
    "before_request", "after_request", "teardown_appcontext",
  ],
  fastapi: [
    "FastAPI", "APIRouter", "Depends", "HTTPException", "status",
    "BaseModel", "Field", "Query", "Path", "Body", "Header", "Cookie",
    "BackgroundTasks", "Request", "Response", "JSONResponse",
  ],
  spring: [
    "SpringApplication", "RestController", "Service", "Repository",
    "Autowired", "Configuration", "Bean", "Entity", "GetMapping",
    "PostMapping", "PutMapping", "DeleteMapping", "RequestMapping",
    "PathVariable", "RequestBody", "ResponseBody", "Component",
  ],
  rails: [
    "before_action", "has_many", "belongs_to", "has_one",
    "validates", "scope", "render", "redirect_to", "params",
    "ApplicationRecord", "ApplicationController", "ActiveRecord",
    "ActionController", "ActionMailer", "ActiveJob", "ActionCable",
  ],
  gin: [
    "gin", "Context", "RouterGroup", "Engine", "Default",
    "GET", "POST", "PUT", "DELETE", "PATCH", "Group",
    "ShouldBindJSON", "JSON", "String", "AbortWithStatus",
  ],
  actix: [
    "HttpServer", "App", "web", "HttpRequest", "HttpResponse",
    "Responder", "actix_web", "Data", "Path", "Query", "Json",
    "get", "post", "put", "delete", "route",
  ],
  aspnet: [
    "Controller", "ApiController", "HttpGet", "HttpPost", "HttpPut",
    "HttpDelete", "IActionResult", "ActionResult", "OkObjectResult",
    "NotFoundResult", "BadRequestResult", "ILogger", "IServiceCollection",
    "AddScoped", "AddSingleton", "AddTransient", "UseRouting", "UseEndpoints",
  ],
  flutter: [
    "Widget", "BuildContext", "StatelessWidget", "StatefulWidget",
    "Scaffold", "MaterialApp", "Column", "Row", "Container", "Text",
    "setState", "initState", "dispose", "build", "context",
  ],
  testing: [
    "describe", "test", "expect", "beforeEach", "afterEach",
    "beforeAll", "afterAll", "jest", "mock", "spy", "assert",
    "assertEqual", "assertTrue", "assertFalse", "fixture", "setup",
    "teardown", "patch", "mock_object", "it", "context",
    "RSpec", "Minitest", "JUnit", "pytest", "vitest", "Mocha",
  ],
};

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "typescript", ".jsx": "typescript",
  ".mjs": "typescript", ".cjs": "typescript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".php": "php",
  ".java": "java",
  ".rb": "ruby",
  ".swift": "swift",
  ".kt": "kotlin", ".kts": "kotlin",
  ".cs": "csharp",
  ".cpp": "c", ".cc": "c", ".cxx": "c", ".c": "c", ".h": "c", ".hpp": "c",
  ".dart": "dart",
  ".vue": "typescript",
  ".svelte": "typescript",
  ".scala": "scala",
  ".ex": "elixir", ".exs": "elixir",
};

const IMPORT_TO_FRAMEWORK: Array<{ pattern: RegExp; framework: string }> = [
  // JS / TS
  { pattern: /from ['"]react['"]|require\(['"]react['"]\)/, framework: "react" },
  { pattern: /from ['"]vue['"]|createApp|defineComponent/, framework: "vue" },
  { pattern: /@angular\/core|@Component|@Injectable/, framework: "angular" },
  { pattern: /from ['"]svelte|<script.*svelte/, framework: "svelte" },
  { pattern: /@nestjs\/|from ['"]@nestjs/, framework: "nestjs" },
  { pattern: /require\(['"]fastify['"]\)|from ['"]fastify['"]/, framework: "fastify" },
  { pattern: /require\(['"]express['"]\)|from ['"]express['"]/, framework: "express" },
  // PHP
  { pattern: /Illuminate\\|use App\\|Laravel/, framework: "laravel" },
  { pattern: /Symfony\\|Doctrine\\|use Symfony/, framework: "symfony" },
  // Python
  { pattern: /from django|import django|Django/, framework: "django" },
  { pattern: /from flask|import flask|Flask\(/, framework: "flask" },
  { pattern: /from fastapi|import fastapi|FastAPI\(/, framework: "fastapi" },
  // Java
  { pattern: /springframework|@SpringBootApplication/, framework: "spring" },
  // Ruby
  { pattern: /Rails|ActionController|ActiveRecord|ApplicationRecord/, framework: "rails" },
  // Go
  { pattern: /["']github\.com\/gin-gonic\/gin["']/, framework: "gin" },
  // Rust
  { pattern: /actix_web|use actix/, framework: "actix" },
  // C#
  { pattern: /Microsoft\.AspNetCore|using Microsoft\.AspNet/, framework: "aspnet" },
  // Dart / Flutter
  { pattern: /package:flutter\/|import 'package:flutter/, framework: "flutter" },
  // Testing
  { pattern: /describe\(|test\(|it\(|expect\(|beforeEach\(|RSpec|pytest|JUnit/, framework: "testing" },
];

export function detectContext(filePath: string, code: string): LanguageContext {
  const ext = path.extname(filePath).toLowerCase();
  const language = EXTENSION_TO_LANGUAGE[ext] ?? "unknown";

  const frameworks: string[] = [];
  for (const { pattern, framework } of IMPORT_TO_FRAMEWORK) {
    if (pattern.test(code)) frameworks.push(framework);
  }

  const genericKeywords = new Set<string>([...BASE_KEYWORDS]);

  const langKeywords = KEYWORDS_BY_LANGUAGE[language] ?? [];
  for (const kw of langKeywords) genericKeywords.add(kw);

  for (const fw of frameworks) {
    const fwKeywords = KEYWORDS_BY_FRAMEWORK[fw] ?? [];
    for (const kw of fwKeywords) genericKeywords.add(kw);
  }

  return { language, frameworks, genericKeywords };
}
