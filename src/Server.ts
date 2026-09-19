/**
 * Wires the language server, the headless editor and the MCP server together.
 *
 * Build order matters: the language server initializes first (so tool
 * registration can consult its capabilities), then the editor services, then
 * the MCP transport, then tools and resources are registered.
 */
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import { Diagnostics } from "./lsp/Diagnostics.ts";
import * as Documents from "./lsp/Documents.ts";
import * as LanguageServer from "./lsp/LanguageServer.ts";
import * as Resources from "./Resources.ts";
import * as Tools from "./Tools.ts";

export type Transport =
  | { readonly _tag: "stdio" }
  | { readonly _tag: "http"; readonly port: number };

export interface Options {
  readonly transport: Transport;
  readonly server: LanguageServer.Options;
  readonly documents: Documents.Options;
}

const info = {
  name: "lsp-mcp",
  version: "0.1.2",
  protocols: [
    McpProtocol.v2025_11_25,
    McpProtocol.v2025_06_18,
    McpProtocol.v2025_03_26,
    McpProtocol.v2024_11_05,
  ],
} as const;

const transport = (transport: Transport) =>
  transport._tag === "stdio"
    ? McpServer.layerStdio(info)
    : HttpRouter.serve(McpServer.layerHttp({ ...info, path: "/mcp" }), {
        disableLogger: true,
      }).pipe(
        Layer.provide(
          NodeHttpServer.layer(createServer, { port: transport.port }),
        ),
      );

/** Registers the tools the connected server can serve. */
export const tools = Layer.effectDiscard(
  Effect.gen(function* () {
    const { capabilities } = yield* LanguageServer.LanguageServer;
    yield* McpServer.registerToolkit(Tools.supportedBy(capabilities));
  }),
).pipe(Layer.provide(Tools.layer));

export const layer = (options: Options) =>
  Layer.mergeAll(tools, Resources.layer).pipe(
    Layer.provide(transport(options.transport)),
    Layer.provide(
      Layer.mergeAll(
        Documents.Documents.layer(options.documents),
        Diagnostics.layer,
      ),
    ),
    Layer.provide(LanguageServer.LanguageServer.layer(options.server)),
  );
