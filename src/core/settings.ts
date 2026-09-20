// Numeric settings arrive as strings from the environment or a CLI flag, and a
// typo in one used to turn into NaN. NaN is the worst possible value here:
// `results.slice(0, NaN)` is `[]`, so a mistyped LEXIS_TOOL_RESULT_LIMIT made
// every search return nothing, with no error to explain it. The reader would
// conclude their code was not indexed.
//
// So a value is either valid or it is refused and said out loud. "20abc" is
// refused too — parseInt would take the 20 and hide the typo forever.

const REJECTED = new Set<string>();
const INTEGER = /^\d+$/;

export function resetSettingWarningsForTests(): void {
  REJECTED.clear();
}

export function intSetting(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;

  const value = raw.trim();
  if (value === "") return fallback;

  if (!INTEGER.test(value)) {
    warnOnce(label, raw, fallback);
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    warnOnce(label, raw, fallback);
    return fallback;
  }
  return parsed;
}

function warnOnce(label: string, raw: string, fallback: number): void {
  if (REJECTED.has(label)) return;
  REJECTED.add(label);
  process.stderr.write(`[lexis] ignoring invalid ${label}="${raw}" — using ${fallback}\n`);
}
