import { Symbol } from "../indexer";

export interface ParserPattern {
  regex: RegExp;
  type: Symbol["type"];
  nameGroup: number;
}
