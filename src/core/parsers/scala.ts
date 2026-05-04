// Scala
import { ParserPattern } from "./types";

export const SCALA_PATTERNS: ParserPattern[] = [
  { regex: /^(def)\s+(\w+)/, type: "function", nameGroup: 2 },
  { regex: /^(class|object|trait|case class|abstract class)\s+(\w+)/, type: "class", nameGroup: 2 },
];
