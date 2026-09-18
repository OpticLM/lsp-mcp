/**
 * MCP resources and notifications: the server's identity and capabilities,
 * live diagnostics (subscribable), and the language server's log messages
 * forwarded as MCP log notifications.
 */
import { Effect, Layer, Schema, Stream } from "effect";
import { McpServer } from "effect/unstable/ai";
import { Diagnostics } from "./lsp/Diagnostics.ts";
import { Documents } from "./lsp/Documents.ts";
import * as Editor from "./lsp/Editor.ts";
import { LanguageServer } from "./lsp/LanguageServer.ts";

const json = (value: unknown) => JSON.stringify(value, null, 2);
const diagnosticsUri = "lsp://diagnostics";
const fileDiagnosticsUri = (file: string) =>
  `${diagnosticsUri}/${encodeURIComponent(file)}`;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const lsp = yield* LanguageServer;
    const docs = yield* Documents;
    const diagnostics = yield* Diagnostics;
    const mcp = yield* McpServer.McpServer;

    yield* McpServer.registerResource({
      uri: "lsp://server",
      name: "Language server",
      description:
        "Name, version, workspace root and capabilities of the connected language server",
      mimeType: "application/json",
      content: Effect.succeed(
        json({
          ...lsp.serverInfo,
          root: lsp.root,
          capabilities: lsp.capabilities,
        }),
      ),
    });

    yield* McpServer.registerResource({
      uri: diagnosticsUri,
      name: "Diagnostics",
      description:
        "All diagnostics the language server has reported. Subscribe to be told when they change.",
      mimeType: "application/json",
      content: Effect.map(Editor.diagnostics({}), json),
    });

    yield* McpServer.registerResource`lsp://diagnostics/${Schema.String}`({
      name: "File diagnostics",
      description:
        "Diagnostics of one file (path URL-encoded, relative to the workspace root)",
      mimeType: "application/json",
      completion: {
        param0: (input) =>
          Effect.map(docs.opened, (uris) =>
            uris.map(docs.file).filter((file) => file.startsWith(input)),
          ),
      },
      content: (_, file) =>
        Effect.map(
          Editor.diagnostics({ file: decodeURIComponent(file) }),
          json,
        ),
    });

    const updated = (uri: string) =>
      mcp.notifications["notifications/resources/updated"]({ uri });
    yield* diagnostics.changes.pipe(
      Stream.runForEach((uri) =>
        Effect.all([
          updated(diagnosticsUri),
          updated(fileDiagnosticsUri(docs.file(uri))),
        ]),
      ),
      Effect.forkScoped,
    );

    yield* lsp.logs.pipe(
      Stream.runForEach(({ level, message }) =>
        mcp.notifications["notifications/message"]({
          level,
          logger: "lsp",
          data: message,
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
