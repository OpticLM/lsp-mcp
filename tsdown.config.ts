import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/main.ts",
  format: "esm",
  outDir: "dist",

  deps: {
    alwaysBundle: ["*"],
  },

  treeshake: true,
  minify: true,
  sourcemap: false,
});
