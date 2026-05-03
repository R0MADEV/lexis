# Lexis — Arquitectura Técnica

## ¿Qué es?

Lexis es una CLI que hace recuperación léxica de código para LLMs. La idea central: en vez de vectorizar todo el proyecto o enviárselo completo a una IA, Lexis encuentra los fragmentos de código exactos que son relevantes a una pregunta usando búsqueda por grep y traversal del grafo de dependencias, y solo esos chunks se envían al LLM.

Sin bases de datos vectoriales. Sin modelos de embedding. Sin búsqueda semántica. Solo búsqueda léxica rápida y exacta.

---

## Estructura del proyecto

```
lexis/
├── src/
│   ├── core/                        # Lógica pura, sin dependencias externas
│   │   ├── indexer.ts               # Recorre archivos del proyecto, extrae símbolos
│   │   ├── searcher.ts              # Motor de búsqueda + traversal de grafo
│   │   ├── chunker.ts               # Constructor de prompts, parser de respuestas, estimador de tokens
│   │   ├── language-detector.ts     # Detecta lenguaje y framework desde las cabeceras de archivos
│   │   └── git-context.ts           # Rama git, commits recientes, cambios recientes
│   ├── adapters/
│   │   ├── llm/
│   │   │   ├── claude.ts            # Anthropic SDK — ask() + askWithTools()
│   │   │   └── openai.ts            # OpenAI SDK — ask() + askWithTools()
│   │   └── storage/
│   │       └── index-file.ts        # Guarda/carga el índice de símbolos en disco
│   └── cli/
│       ├── main.ts                  # Punto de entrada, carga .env.local
│       └── commands/
│           ├── index.ts             # `lexis index <ruta>`
│           └── ask.ts               # `lexis ask "<pregunta>"`
├── .env                             # Plantilla (se commitea)
├── .env.local                       # Claves reales (en .gitignore)
├── package.json
└── tsconfig.json
```

---

## Arquitectura

Arquitectura Clean/Hexagonal con tres capas:

**Core** — lógica pura. No importa nada de adapters ni CLI. Se puede testear de forma aislada.

**Adapters** — implementan las interfaces que define el core. Se puede cambiar Claude por GPT, o el almacenamiento en disco por S3, sin tocar la lógica del core.

**CLI** — capa fina. Parsea argumentos, conecta dependencias, llama al core a través de los adapters.

---

## Cómo se responde una pregunta

### Modo 1: Native Tool Calling (por defecto)

```
lexis ask "pregunta"
        │
        ├── loadIndex(projectPath)
        ├── getGitContext(projectPath)         ← rama, últimos commits, diffs recientes
        │
        └── toolCallingMode()
              │
              ├── define herramientas:
              │     search_code(query)         ← llama a search() internamente
              │     read_file(path)            ← lee hasta 300 líneas
              │
              ├── estimateTokens(systemPrompt + pregunta)
              │
              └── askClaudeWithTools() / askOpenAIWithTools()
                    │
                    ├── LLM llama search_code("termino1")  → resultados devueltos
                    ├── LLM llama search_code("termino2")  → resultados devueltos
                    ├── LLM llama read_file("/ruta")        → contenido del archivo
                    └── LLM deja de llamar herramientas → respuesta final
```

El LLM controla el loop de recuperación. Él decide qué buscar, cuándo tiene suficiente contexto y cuándo parar.

### Modo 2: JSON Protocol (LEXIS_TOOL_CALLING=false)

```
lexis ask "pregunta"
        │
        └── reasoningLoop()
              │
              por cada iteración (hasta LEXIS_MAX_ITERATIONS):
              │
              ├── revisa searchCache — salta si ya se buscó
              ├── search(query, index, projectPath, topK=5)
              ├── construye prompt con chunks + git context
              ├── estimateTokens(prompt) → log
              ├── llm(prompt)
              │
              └── parsea respuesta JSON:
                    {
                      needs_more_context: true/false,
                      search_terms: ["termino1", "termino2"],
                      partial_analysis: "...",
                      answer: "...",
                      read_file: "/ruta/al/archivo.ts"  ← opcional
                    }
                    │
                    ├── si read_file → lee y agrega como chunk, continúa
                    ├── si needs_more_context → currentQuery = search_terms, continúa
                    └── si answer → imprime y termina
```

---

## Módulos del Core

### indexer.ts

Recorre todos los archivos del proyecto de forma recursiva (ignora `node_modules`, `.git`, `dist`, `build`, `.next`) y extrae símbolos por regex:

- `function nombreFuncion`
- `const nombre = () =>`
- `class NombreClase`
- `fn nombre(` (Rust)
- `def nombre(` (Python)
- `func nombre(` (Go)

Guarda el resultado en `.lexis-index.json` en la raíz del proyecto.

```typescript
interface Symbol {
  name: string;
  file: string;      // ruta absoluta
  lineStart: number;
  lineEnd: number;   // lineStart + 20 (aproximado)
  type: "function" | "class" | "variable";
}

interface Index {
  symbols: Symbol[];
  projectPath: string;
  createdAt: string;
}
```

---

### searcher.ts

El pipeline principal de búsqueda. El punto de entrada es `search()`.

#### Paso 1 — Extrae términos técnicos

```typescript
extractTechnicalTerms("how does useContactMatchOrder work")
// → ["useContactMatchOrder", "does", "work"]
// primero se extraen términos camelCase, luego palabras > 4 chars
```

#### Paso 2 — Búsqueda con ripgrep

Busca `\bterm1\b|\bterm2\b` en todo el proyecto. Si `rg` no está instalado, hace fallback a un walk de `fs` en Node.js.

`findRipgrep()` prueba: `rg`, `/opt/homebrew/bin/rg`, `/usr/local/bin/rg`, `~/.cargo/bin/rg`

#### Paso 3 — Extraer contexto de función

Por cada match, `extractFunction()` sube desde la línea encontrada buscando la función de nivel superior (regex que requiere que no haya espacios al inicio), luego baja contando `{` y `}` para encontrar el cierre. Máximo 60 líneas.

#### Paso 4 — Filtrar por capa dominante

`filterByDominantLayer()` — en proyectos fullstack, determina si los resultados son mayormente frontend o backend y filtra la capa minoritaria a menos que tengan score ≥ 2 matches.

```typescript
const LAYER_BY_EXT = {
  ".ts": "frontend", ".tsx": "frontend", ".js": "frontend",
  ".go": "backend", ".py": "backend", ".rb": "backend", ...
}
```

Los resultados cross-layer solo se conservan si el archivo origen tiene llamadas explícitas a API o WebSocket (`fetch()`, `axios.*`, `socket.emit`, strings con `/api/`, etc.).

#### Paso 5 — Traversal del grafo

`traverseGraph()` expande los resultados iniciales siguiendo referencias:

- Imports: `import { X, Y } from 'z'` → extrae `X`, `Y`
- Llamadas a funciones: `nombreFuncion(` → extrae `nombreFuncion`
- Identificadores camelCase: `useContactMatchOrder` → extraído

Por cada referencia, lanza una nueva búsqueda con ripgrep. Los resultados de capas distintas se filtran con `isConnected()`, que lee el archivo origen y verifica si tiene patrones cross-layer.

Los resultados del traversal se re-puntúan contra los **términos de la query original** (no del término de traversal). Si el score es 0, el resultado se descarta. Esto evita que código no relacionado contamine el contexto.

La profundidad es configurable (default: 2). Cada nivel expande hasta 5 archivos nuevos.

#### Paso 6 — Ordenar y deduplicar

- `dedup()` — elimina resultados solapados (mismo archivo, rangos de líneas que se superponen)
- `sortByRelevanceAndRecency()` — ordena por cantidad de matches, luego por fecha de modificación del archivo (los más recientes primero)

---

### language-detector.ts

Detecta el lenguaje (por extensión de archivo) y el framework (por patrones de import en las primeras 20 líneas del archivo).

```typescript
interface LanguageContext {
  language: string;
  framework: string | null;
  genericKeywords: Set<string>;
}
```

El set `genericKeywords` lo usa `extractReferences()` para filtrar el ruido de frameworks (ej: `useState`, `useEffect`, `render`, `computed`) para que el traversal no siga internals de React/Vue.

**Lenguajes soportados**: TypeScript, JavaScript, Python, Rust, Go, PHP, Java, Ruby, Swift, Kotlin

**Frameworks detectados por imports**:
- React: `from 'react'`
- Vue: `from 'vue'`
- Angular: `@angular/`
- Laravel: `use Illuminate\`
- Symfony: `use Symfony\`
- Django: `from django`
- Flask: `from flask`
- Spring: `org.springframework`
- Express: `require('express')`
- Testing: `describe(`, `it(`, `test(`, `expect(`

---

### chunker.ts

Construye prompts y parsea respuestas del LLM.

**`buildPrompt()`** — primera iteración. Construye el prompt simple y el iterativo.

**`buildIterativePrompt()`** — iteraciones posteriores. Incluye todos los chunks acumulados más el análisis parcial de iteraciones anteriores. Acepta `gitContext` opcional que se inyecta en el system prompt.

**`parseLLMResponse()`** — extrae JSON de la respuesta del LLM. Maneja tanto bloques ` ```json ``` ` como objetos `{...}` crudos.

**`estimateTokens(text)`** — `Math.ceil(text.length / 4)`. Estimación aproximada, útil para monitorear el coste antes de cada llamada al LLM.

**Interfaz `LLMResponse`**:
```typescript
interface LLMResponse {
  needs_more_context: boolean;
  search_terms: string[];
  partial_analysis: string | null;
  answer: string | null;
  read_file?: string | null;   // el LLM puede pedir ver un archivo completo
}
```

**Interfaz `LexisTool`** — compartida entre claude.ts y openai.ts:
```typescript
interface LexisTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  execute: (args: Record<string, unknown>) => Promise<string>;
}
```

---

### git-context.ts

Ejecuta tres comandos git con `execSync` (silencia stderr, captura todos los errores):

```bash
git rev-parse --abbrev-ref HEAD      # rama actual
git log --oneline -10                # últimos 10 commits
git diff HEAD~1 --stat               # archivos cambiados en el último commit
```

Devuelve `null` si no es un repo git o git no está instalado. Seguro llamarlo desde cualquier lugar.

---

## Adaptadores LLM

### claude.ts

- `ask(prompt)` — llamada simple de un solo turno a `claude-sonnet-4-6`, máx 4096 tokens
- `askWithTools(systemPrompt, userMessage, tools)` — ejecuta un loop de tool use hasta 15 turnos. En cada turno: si `stop_reason === "tool_use"`, ejecuta todas las herramientas solicitadas y devuelve los resultados. Si `stop_reason === "end_turn"`, devuelve la respuesta de texto.

### openai.ts

- `ask(prompt)` — llamada simple a `gpt-4o`, máx 4096 tokens
- `askWithTools(systemPrompt, userMessage, tools)` — misma lógica de loop usando function calling de OpenAI. Maneja el narrowing de tipos con el guard `toolCall.type === "function"` para `ChatCompletionMessageFunctionToolCall`.

---

## Comandos CLI

### `lexis index <ruta>`

Llama a `buildIndex(projectPath)` del `indexer.ts`. Recorre todos los archivos, extrae símbolos, guarda en `<ruta>/.lexis-index.json`. Imprime el conteo de símbolos al terminar.

### `lexis ask "<pregunta>" [--lang en|es]`

1. Carga el índice desde `.lexis-index.json`
2. Resuelve el LLM (primero busca `ANTHROPIC_API_KEY`, luego `OPENAI_API_KEY`)
3. Si `LEXIS_TOOL_CALLING !== "false"` → ejecuta `toolCallingMode()`
4. Si no → ejecuta `reasoningLoop()`

Ambos modos comparten:
- Caché de búsquedas (`Set<string>`) — evita queries duplicadas
- Git context — inyectado una sola vez en el system prompt
- Estimación de tokens — se loguea antes de cada llamada al LLM

---

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Activa Claude. Tiene prioridad sobre OpenAI. |
| `OPENAI_API_KEY` | — | Activa GPT-4o. Se usa si no hay clave de Anthropic. |
| `LEXIS_LANG` | `en` | Idioma de respuesta. `en` o `es`. |
| `LEXIS_MAX_ITERATIONS` | `3` | Máximo de iteraciones en modo JSON protocol. |
| `LEXIS_TOOL_CALLING` | `true` | Poner `false` para usar JSON protocol en vez de tool calling nativo. |
| `LEXIS_DEBUG` | `false` | Poner `true` para ver logs de debug del traversal. |

`.env` es la plantilla que se commitea. `.env.local` tiene las claves reales y sobreescribe `.env` (cargado por `dotenv` en `main.ts`).

---

## Decisiones de diseño

**¿Por qué búsqueda léxica y no semántica?**
La búsqueda semántica requiere un modelo de embedding y un vector store. La búsqueda léxica funciona de inmediato en cualquier proyecto, no cuesta nada indexar, y es exacta — los nombres de funciones, variables y call sites son strings exactos, no conceptos aproximados.

**¿Por qué traversal de grafo?**
Un simple grep de "useContactMatchOrder" encuentra la definición de la función pero no el estado que lee, los hooks que llama, ni la API que consulta. El traversal sigue la cadena de dependencias para sacar a la superficie el contexto completo que el LLM necesita.

**¿Por qué filtrar por capa dominante?**
En proyectos fullstack, buscar "session" devuelve tanto el hook de sesión de React como el middleware de sesión de Go. La pregunta del LLM normalmente es sobre una sola capa. Filtrar a la capa dominante (por score total de matches) reduce el ruido y evita confundir al LLM con código no relacionado.

**¿Por qué tool calling nativo en vez de JSON protocol?**
El JSON protocol requiere que el LLM formatee su respuesta como JSON válido en cada turno. El tool calling es una feature de primera clase de la API — el LLM llama herramientas sin necesidad de producir JSON formateado, y el loop de búsqueda lo controla el modelo en vez de nuestro código. Más robusto, menos fallos de formato, mejores resultados.

**¿Por qué re-puntuar los resultados del traversal contra la query original?**
Sin re-puntuar, el traversal puede traer archivos que hacen match con un término de traversal (ej: `useState`) pero no tienen nada que ver con la pregunta original. Re-puntuar contra los términos originales y descartar los de score 0 mantiene limpio el contexto que se envía al LLM.
