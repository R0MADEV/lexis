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
