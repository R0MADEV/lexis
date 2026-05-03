# Lexis — instrucciones para Claude Code

Servidor MCP `lexis-lexis` indexa este proyecto. Úsalo como fuente primaria — no leas archivos enteros.

## Flujo
1. `search_code(query)` — compact por default (~50 tokens/resultado). Oriéntate primero.
2. `read_file(path, offset=X, limit=40)` — solo el rango que necesitas.

## Reglas
- `output='content'` solo si necesitas 2+ implementaciones completas (~500 tok/resultado).
- `depth=2` solo para conceptos amplios (default=1).
- Usa siempre `offset` en `read_file` cuando sabes la línea exacta.

## Estructura
`src/core/` searcher·indexer·query-analyzer·chunker | `src/mcp/` server.ts | `src/cli/` main.ts | `src/adapters/` storage | `dist/` compilado (no editar)
