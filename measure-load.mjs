import { TOOLS } from './dist/mcp/tools-registry.js';
import { LEXIS_INSTRUCTIONS } from './dist/mcp/instructions.js';
import { ULTRA_DESCRIPTIONS } from './dist/mcp/tool-filtering.js';

const approxTokens = (s) => Math.round(s.length / 3.5);
const bytes = (s) => Buffer.byteLength(s, 'utf8');

const toolsListPayload = JSON.stringify(TOOLS);
console.log('═══ DEFAULT MODE ═══');
console.log(`Tools count:              ${TOOLS.length}`);
console.log(`Tools JSON bytes:         ${bytes(toolsListPayload).toLocaleString()}`);
console.log(`Tools JSON ~tokens:       ${approxTokens(toolsListPayload).toLocaleString()}`);
console.log();
console.log(`Instructions bytes:       ${bytes(LEXIS_INSTRUCTIONS).toLocaleString()}`);
console.log(`Instructions ~tokens:     ${approxTokens(LEXIS_INSTRUCTIONS).toLocaleString()}`);
console.log();
console.log(`TOTAL default ~tokens:    ${approxTokens(toolsListPayload + LEXIS_INSTRUCTIONS).toLocaleString()}`);

const ultraTools = TOOLS.map(t => ({ ...t, description: ULTRA_DESCRIPTIONS[t.name] || t.description }));
const ultraPayload = JSON.stringify(ultraTools);
console.log();
console.log('═══ ULTRA MODE (LEXIS_COMPRESSION=ultra) ═══');
console.log(`Tools JSON bytes:         ${bytes(ultraPayload).toLocaleString()}`);
console.log(`TOTAL ultra ~tokens:      ${approxTokens(ultraPayload + LEXIS_INSTRUCTIONS).toLocaleString()}`);

console.log();
console.log('═══ Top 5 heaviest tools ═══');
[...TOOLS].map(t => ({ name: t.name, bytes: bytes(JSON.stringify(t)) }))
  .sort((a,b) => b.bytes - a.bytes).slice(0, 5)
  .forEach(t => console.log(`  ${t.name.padEnd(30)} ${t.bytes.toLocaleString().padStart(6)} bytes`));
