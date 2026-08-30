import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Apps Script ES2020 compatibility", () => {
  it("contains no Array.at usage in source", () => {
    const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
    const source = filesUnder(sourceRoot)
      .filter((path) => path.endsWith(".ts"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toMatch(/\.\s*at\s*\(/u);
  });
});

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = `${directory}/${name}`;
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}
