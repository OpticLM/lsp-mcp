import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Layer, Path } from "effect";
import { LanguageServer, type Options } from "../../src/lsp/LanguageServer.ts";

const server = fileURLToPath(new URL("./server.ts", import.meta.url));

/** A temporary workspace with the given files, served by the fixture language server. */
export const workspace = (
  files: Record<string, string>,
  options?: Pick<Options, "restart">,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lsp-mcp-" });
      for (const [name, content] of Object.entries(files)) {
        yield* fs.writeFileString(path.join(root, name), content);
      }
      return LanguageServer.layer({
        command: process.execPath,
        args: [server],
        root,
        ...options,
      });
    }),
  );
