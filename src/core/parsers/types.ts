import { Symbol } from "../indexer";

export interface ParserPattern {
  regex: RegExp;
  type: Symbol["type"];
  nameGroup: number;
  // Optional file filter — only run this pattern on matching files. Useful for
  // patterns that target specific DSLs/configs (e.g. CGRates profiles in JSON)
  // and would otherwise produce noise in unrelated files.
  appliesTo?: (file: string) => boolean;
}
