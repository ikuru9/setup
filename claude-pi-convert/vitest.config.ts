import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Converted packages intentionally preserve source fixtures. Do not treat
    // those third-party files as this converter's own test suite.
    include: ["test/**/*.test.ts"],
  },
});
