import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function lintFixtures(paths: readonly string[]): string {
  try {
    execFileSync("node", ["node_modules/eslint/bin/eslint.js", "--no-ignore", ...paths], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error: unknown) {
    if (error !== null && typeof error === "object" && "stdout" in error) {
      return String(error.stdout);
    }
  }
  throw new Error(`Los fixtures ${paths.join(", ")} no fallaron el lint como se esperaba`);
}

describe("gate estático", () => {
  it("rechaza promesas flotantes e imports core hacia sites", () => {
    const output = lintFixtures([
      "test/lint-fixtures/floating-promise.ts",
      "test/lint-fixtures/core/forbidden-import.ts",
    ]);
    expect(output).toContain("@typescript-eslint/no-floating-promises");
    expect(output).toContain("no-restricted-imports");
  }, 15_000);
});
