// Elixir
import { ParserPattern } from "./types";

export const ELIXIR_PATTERNS: ParserPattern[] = [
  { regex: /^(def|defp|defmacro)\s+(\w+)/, type: "function", nameGroup: 2 },
  { regex: /^defmodule\s+(\w[\w.]+)/, type: "class", nameGroup: 1 },
];
