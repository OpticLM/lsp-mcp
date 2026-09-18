import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { RequestType } from "vscode-languageserver-protocol";
import { Diagnostics } from "../src/lsp/Diagnostics.ts";
import { Documents } from "../src/lsp/Documents.ts";
import * as Editor from "../src/lsp/Editor.ts";
import { LanguageServer } from "../src/lsp/LanguageServer.ts";
import { workspace } from "./fixtures/workspace.ts";

const State = new RequestType<null, { open: number; closes: number }, void>(
  "fixture/state",
);
const Progress = new RequestType<number, string, void>("fixture/progress");

const TestLayer = Layer.mergeAll(
  Documents.layer({ capacity: 2, languages: {} }),
  Diagnostics.layer,
).pipe(
  Layer.provideMerge(
    workspace({
      "a.ts": "const alpha = 1\nexport const beta = alpha + alpha\n",
      "b.ts": "// TODO fix\n",
      "c.ts": "",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("Editor", () => {
  it.layer(TestLayer, { excludeTestServices: true })(
    "with the fixture server",
    (it) => {
      it.effect("addresses positions by 1-based line and symbol name", () =>
        Effect.gen(function* () {
          const byColumn = yield* Editor.hover({
            file: "a.ts",
            line: 2,
            column: 22,
          });
          const bySymbol = yield* Editor.hover({
            file: "a.ts",
            line: 2,
            symbol: "alpha",
          });
          assert.strictEqual(byColumn?.contents, "word **alpha**");
          assert.strictEqual(bySymbol?.contents, "word **alpha**");

          const refs = yield* Editor.references({
            file: "a.ts",
            line: 1,
            symbol: "alpha",
          });
          assert.deepStrictEqual(
            refs.map((r) => [r.line, r.column, r.preview]),
            [
              [1, 7, "const alpha = 1"],
              [2, 21, "export const beta = alpha + alpha"],
              [2, 29, "export const beta = alpha + alpha"],
            ],
          );
        }),
      );

      it.effect("sees edits made on disk without being told", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const docs = yield* Documents;
          const lsp = yield* LanguageServer;
          const before = yield* Editor.diagnostics({ file: "b.ts" });
          assert.deepStrictEqual(
            before.map((d) => [d.severity, d.line]),
            [["warning", 1]],
          );

          yield* fs.writeFileString(
            docs.uri("b.ts").replace("file://", ""),
            "// done\n// TODO more\n",
          );
          const after = yield* Editor.diagnostics({ file: "b.ts" });
          assert.deepStrictEqual(
            after.map((d) => [d.severity, d.line]),
            [["warning", 2]],
          );
          assert.strictEqual((yield* lsp.request(State, null)).open, 2);
        }),
      );

      it.effect("closes the least recently used document beyond capacity", () =>
        Effect.gen(function* () {
          const lsp = yield* LanguageServer;
          const docs = yield* Documents;
          yield* docs.open("a.ts");
          yield* docs.open("b.ts");
          yield* docs.open("c.ts");
          yield* Effect.sleep("50 millis");
          const state = yield* lsp.request(State, null);
          assert.strictEqual(state.open, 2);
          assert.isAtLeast(state.closes, 1);
          assert.deepStrictEqual((yield* docs.opened).map(docs.file).sort(), [
            "b.ts",
            "c.ts",
          ]);
        }),
      );

      it.effect("previews a rename, and applies it only when asked", () =>
        Effect.gen(function* () {
          const docs = yield* Documents;
          const preview = yield* Editor.rename({
            file: "a.ts",
            line: 1,
            symbol: "alpha",
            newName: "first",
          });
          assert.isFalse(preview.applied);
          assert.strictEqual(preview.files[0]?.edits.length, 3);
          assert.include((yield* docs.open("a.ts")).getText(), "alpha");

          const applied = yield* Editor.rename({
            file: "a.ts",
            line: 1,
            symbol: "alpha",
            newName: "first",
            apply: true,
          });
          assert.isTrue(applied.applied);
          const text = (yield* docs.peek(docs.uri("a.ts"))).getText();
          assert.strictEqual(
            text,
            "const first = 1\nexport const beta = first + first\n",
          );
          assert.strictEqual(
            (yield* Editor.hover({ file: "a.ts", line: 1, symbol: "first" }))
              ?.contents,
            "word **first**",
          );
        }),
      );

      it.effect("waits for the server's background work before asking", () =>
        Effect.gen(function* () {
          const lsp = yield* LanguageServer;
          yield* lsp.request(Progress, 300);
          const started = Date.now();
          const symbols = yield* Editor.documentSymbols({ file: "c.ts" });
          assert.isAtLeast(Date.now() - started, 250);
          assert.deepStrictEqual(symbols, []);
        }),
      );

      it.effect("explains what the server cannot do", () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            Editor.definition({
              file: "a.ts",
              line: 1,
              symbol: "alpha",
              kind: "implementation",
            }),
          );
          assert.strictEqual(error._tag, "LspError");
          assert.match(
            error.message,
            /does not support implementationProvider/,
          );
        }),
      );
    },
  );
});
