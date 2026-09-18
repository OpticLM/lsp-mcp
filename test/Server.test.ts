import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
} from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Diagnostics } from "../src/lsp/Diagnostics.ts";
import { Documents } from "../src/lsp/Documents.ts";
import * as Resources from "../src/Resources.ts";
import * as Server from "../src/Server.ts";
import { workspace } from "./fixtures/workspace.ts";

const mcp = McpServer.layerHttp({
  name: "test",
  version: "0.0.0",
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
});

const app = Layer.mergeAll(Server.tools, Resources.layer).pipe(
  Layer.provide(mcp),
  Layer.provide(
    Layer.mergeAll(
      Documents.layer({ capacity: 4, languages: {} }),
      Diagnostics.layer,
    ),
  ),
  Layer.provide(workspace({ "a.ts": "const alpha = 1\n" })),
  Layer.provide(NodeServices.layer),
);

/** An MCP client talking to the app over in-memory HTTP. */
const client = Effect.gen(function* () {
  const { dispose, handler } = HttpRouter.toWebHandler(app, {
    disableLogger: true,
  });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const headers = new Map<string, string>();
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      for (const [name, value] of headers) request.headers.set(name, value);
      const response = await handler(request);
      for (const name of ["Mcp-Session-Id", "Mcp-Protocol-Version"]) {
        const value = response.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      return response;
    },
    { preconnect() {} },
  );
  const transport = RpcClient.layerProtocolHttp({
    url: "http://localhost/mcp",
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader(
        "accept",
        "application/json, text/event-stream",
      ),
    ),
  }).pipe(
    Layer.provideMerge([
      FetchHttpClient.layer,
      RpcSerialization.layerJsonRpc(),
    ]),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  const client = yield* RpcClient.make(McpSchema.ClientRpcs).pipe(
    Effect.provide(transport),
  );
  yield* client.initialize({
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  return client;
});

describe("MCP server", () => {
  it.live(
    "offers only the tools the language server supports, and serves them",
    () =>
      Effect.gen(function* () {
        const mcp = yield* client;
        const { tools } = yield* mcp["tools/list"]({});
        assert.deepStrictEqual(tools.map((t) => t.name).sort(), [
          "definition",
          "diagnostics",
          "document_symbols",
          "hover",
          "references",
          "rename",
        ]);
        assert.isTrue(
          tools.find((t) => t.name === "hover")?.annotations?.readOnlyHint,
        );
        assert.isFalse(
          tools.find((t) => t.name === "rename")?.annotations?.readOnlyHint,
        );

        const result = yield* mcp["tools/call"]({
          name: "hover",
          arguments: { file: "a.ts", line: 1, symbol: "alpha" },
        });
        assert.deepStrictEqual(result.structuredContent, {
          contents: "word **alpha**",
        });

        const failure = yield* mcp["tools/call"]({
          name: "hover",
          arguments: { file: "missing.ts", line: 1 },
        });
        assert.isTrue(failure.isError);
        assert.match(JSON.stringify(failure.content), /missing\.ts/);
      }).pipe(Effect.scoped),
  );

  it.live("exposes the server and its diagnostics as resources", () =>
    Effect.gen(function* () {
      const mcp = yield* client;
      const { resources } = yield* mcp["resources/list"]({});
      assert.deepStrictEqual(resources.map((r) => r.uri).sort(), [
        "lsp://diagnostics",
        "lsp://server",
      ]);
      const server = yield* mcp["resources/read"]({ uri: "lsp://server" });
      const contents = server.contents[0];
      assert.isTrue(
        contents !== undefined &&
          "text" in contents &&
          JSON.parse(contents.text).name === "fixture",
      );
      const { resourceTemplates } = yield* mcp["resources/templates/list"]({});
      assert.deepStrictEqual(
        resourceTemplates.map((t) => t.uriTemplate),
        ["lsp://diagnostics/{param0}"],
      );
    }).pipe(Effect.scoped),
  );
});
