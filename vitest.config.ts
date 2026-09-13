import { defineConfig } from "vitest/config";

// Tests are pure logic (diff, chunking, parsing, applying fixes) under
// src/lib and must NOT pick up the Cloudflare vite plugin — that plugin is
// for building/serving the app, not for the unit-test pipeline.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
