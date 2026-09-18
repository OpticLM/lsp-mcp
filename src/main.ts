#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   lsp-mcp [--stdio | --http <port>] [--root <dir>] -- <server> [args...]
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Layer, Option, Path, References, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import * as Server from "./Server.ts";

const Json = Flag.withSchema(Schema.fromJsonString(Schema.Json));

const command = Command.make(
  "lsp-mcp",
  {
    transport: Flag.Int("http").pipe(
      Flag.withDescription(
        "Serve MCP over Streamable HTTP at http://localhost:<port>/mcp",
      ),
      Flag.map((port) => ({ _tag: "http", port }) as const),
      Flag.orElse(() =>
        Flag.Boolean("stdio").pipe(
          Flag.withDescription("Serve MCP over stdio (the default)"),
          Flag.withDefault(false),
          Flag.map(() => ({ _tag: "stdio" }) as const),
        ),
      ),
    ),
    root: Flag.Directory("root", { mustExist: true }).pipe(
      Flag.withAlias("r"),
      Flag.withDescription("Workspace root handed to the language server"),
      Flag.withDefault("."),
    ),
    initOptions: Flag.String("init-options").pipe(
      Json,
      Flag.withDescription(
        "JSON passed to the language server as initializationOptions",
      ),
      Flag.optional,
    ),
    settings: Flag.String("settings").pipe(
      Json,
      Flag.withDescription(
        "JSON served as workspace/configuration and sent as didChangeConfiguration",
      ),
      Flag.optional,
    ),
    languages: Flag.KeyValuePair("language").pipe(
      Flag.withDescription(
        "Extra file extension to languageId mapping, e.g. --language vue=vue",
      ),
      Flag.withDefault({}),
    ),
    capacity: Flag.Int("open-documents").pipe(
      Flag.withDescription(
        "Documents kept open in the language server before the least recently used is closed",
      ),
      Flag.withDefault(32),
    ),
    command: Argument.String("server").pipe(
      Argument.withDescription("Language server executable"),
    ),
    args: Argument.String("args").pipe(
      Argument.withDescription(
        "Arguments for the language server; put `--` before them",
      ),
      Argument.variadic(),
    ),
  },
  Effect.fn(function* ({
    transport,
    root,
    initOptions,
    settings,
    languages,
    capacity,
    command,
    args,
  }) {
    const path = yield* Path.Path;
    return yield* Layer.launch(
      Server.layer({
        transport,
        server: {
          // a relative executable path is relative to where lsp-mcp was started, not to the root
          command: command.includes("/") ? path.resolve(command) : command,
          args,
          root: path.resolve(root),
          initializationOptions: Option.getOrUndefined(initOptions),
          settings: Option.getOrUndefined(settings),
        },
        documents: { capacity, languages },
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Expose a Language Server to MCP clients as a headless editor",
  ),
  Command.withExamples([
    {
      command: "lsp-mcp -- typescript-language-server --stdio",
      description: "TypeScript over stdio",
    },
    {
      command: "lsp-mcp --http 3000 --root ./crate -- rust-analyzer",
      description: "Rust over HTTP",
    },
    {
      command: `lsp-mcp --settings '{"gopls":{"staticcheck":true}}' -- gopls`,
      description: "Go with workspace settings",
    },
  ]),
);

command.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause),
  ),
  // stdout may be the MCP channel, so every log line goes to stderr
  Effect.provideService(References.LogToStderr, true),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
