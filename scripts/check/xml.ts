#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { SyntaxValidator } from "fast-xml-validator";

export function validateXML(contents: string): void {
  if (/<!ENTITY\s/i.test(contents))
    throw new Error("XML entity declarations are forbidden");
  SyntaxValidator.validate(contents, {
    invalidCharSequence: { comment: true, tagValue: true, attrLt: true },
  });
}

if (import.meta.main) {
  for (const path of process.argv.slice(2)) {
    try {
      validateXML(readFileSync(path, "utf8"));
    } catch (error) {
      console.error(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  }
}
