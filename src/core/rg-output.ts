// ripgrep prints a matched line exactly as the file stores it, so a file with
// CRLF endings yields "...content\r" before the \n that separates results.
// Every consumer splits that output on \n and parses it with a $-anchored
// regex — and JavaScript's $ does not match before \r, nor does . consume it.
// The line therefore fails to parse and the match disappears without a word.
//
// Normalizing where ripgrep's output enters the program fixes every consumer at
// once, including ones written later that would not think to allow for \r.
// Only the CRLF pair is collapsed: a lone \r inside a line is content.

export function normalizeRgOutput(stdout: string): string {
  return stdout.replace(/\r\n/g, "\n");
}

export interface RgLine {
  file: string;
  line: number;
  content: string;
}

// ripgrep prints "<file>:<line>:<content>", and the content can contain that
// same shape — a test asserting on "a.ts:1:hello", a URL with a port, a
// timestamp. A greedy leading group takes the LAST such marker in the line, so
// the file becomes a fragment of source text and the line number comes out of
// the code. The result still looks like a hit, which is why it went unnoticed.
//
// The first marker is the real one, so the file group is lazy. Content may be
// empty: a match on a blank line is still a match.
const RG_LINE = /^(.+?):(\d+):([\s\S]*)$/;

export function parseRgLine(raw: string): RgLine | null {
  const match = RG_LINE.exec(raw);
  if (!match) return null;
  return { file: match[1]!, line: Number(match[2]), content: match[3] ?? "" };
}
