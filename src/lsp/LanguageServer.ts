/**
 * A running language server: process, JSON-RPC connection and the LSP
 * lifecycle, exposed as an Effect service.
 *
 * `request` waits for the server to become idle (no `$/progress` work in
 * flight) and retries transient `ContentModified` / `ServerCancelled`
 * failures, so callers can treat the server as if it were always ready.
 */
import { spawn } from "node:child_process";
import { NodeStream } from "@effect/platform-node";
import {
  Context,
  Deferred,
  Effect,
  FiberSet,
  HashSet,
  Layer,
  PubSub,
  Schedule,
  Schema,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  CancellationTokenSource,
  type ClientCapabilities,
  type CompletionItemKind,
  ConfigurationRequest,
  createMessageConnection,
  DidChangeConfigurationNotification,
  ErrorCodes,
  ExitNotification,
  type HandlerResult,
  InitializedNotification,
  InitializeRequest,
  LogMessageNotification,
  type LSPAny,
  LSPErrorCodes,
  type MessageType,
  type NotificationType,
  RegistrationRequest,
  type RequestType,
  ResponseError,
  type ServerCapabilities,
  ShowMessageNotification,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
  type SymbolKind,
  UnregistrationRequest,
  WorkDoneProgressCreateRequest,
  WorkspaceFoldersRequest,
} from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";

export interface Options {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Absolute path of the workspace root. */
  readonly root: string;
  readonly initializationOptions?: unknown;
  /** Served as `workspace/configuration` and pushed via `didChangeConfiguration`. */
  readonly settings?: unknown;
}

export class LspError extends Schema.TaggedError<LspError>()("LspError", {
  method: Schema.String,
  message: Schema.String,
  code: Schema.optional(Schema.Int),
}) {
  get retryable() {
    return (
      this.code === LSPErrorCodes.ContentModified ||
      this.code === LSPErrorCodes.ServerCancelled
    );
  }
}

export type LogLevel = "error" | "warning" | "info" | "debug";
export interface LogMessage {
  readonly level: LogLevel;
  readonly message: string;
}

export class LanguageServer extends Context.Service<
  LanguageServer,
  {
    readonly root: string;
    readonly capabilities: ServerCapabilities;
    readonly serverInfo:
    | { readonly name: string; readonly version?: string | undefined }
    | undefined;
    readonly request: <P, R>(
      type: RequestType<P, R, unknown>,
      params: P,
    ) => Effect.Effect<R, LspError>;
    readonly notify: <P>(
      type: NotificationType<P>,
      params: P,
    ) => Effect.Effect<void>;
    readonly notifications: <P>(type: NotificationType<P>) => Stream.Stream<P>;
    /** Handle a request the server sends to us; unhandled methods answer `MethodNotFound`. */
    readonly onRequest: <P, R>(
      type: RequestType<P, R, unknown>,
      handler: (params: P) => Effect.Effect<R, unknown>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** `window/logMessage` and `window/showMessage` traffic. */
    readonly logs: Stream.Stream<LogMessage>;
  }
>()("lsp-mcp/lsp/LanguageServer") {
  static readonly layer = (options: Options) =>
    Layer.effect(LanguageServer, make(options));
}

const make = Effect.fn("LanguageServer.make")(function* (options: Options) {
  const run = yield* FiberSet.makeRuntime<never>();
  const runPromise = yield* FiberSet.makeRuntimePromise<never>();
  const exited = yield* Deferred.make<never, LspError>();
  const events = yield* PubSub.unbounded<{
    readonly method: string;
    readonly params: unknown;
  }>();
  const progress = yield* SubscriptionRef.make(
    HashSet.empty<string | number>(),
  );
  const exit = (message: string) =>
    Deferred.doneUnsafe(
      exited,
      Effect.fail(new LspError({ method: "connection", message })),
    );

  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(options.command, options.args, {
        cwd: options.root,
        stdio: "pipe",
      }),
    ),
    (child) =>
      Effect.sync(() => void (child.exitCode === null && child.kill())),
  );
  child.on("error", (error) =>
    exit(`failed to start ${options.command}: ${error.message}`),
  );
  child.on("exit", (code, signal) =>
    exit(`${options.command} exited (${signal ?? code})`),
  );
  yield* NodeStream.fromReadable<Uint8Array, never>({
    evaluate: () => child.stderr,
    onError: () => undefined as never,
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Effect.logDebug(line)),
    Effect.annotateLogs("source", `${options.command}:stderr`),
    Effect.forkScoped,
  );

  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
    {
      error: (m) => run(Effect.logError(m)),
      warn: (m) => run(Effect.logWarning(m)),
      info: (m) => run(Effect.logInfo(m)),
      log: (m) => run(Effect.logDebug(m)),
    },
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => connection.dispose()));
  connection.onClose(() => exit(`${options.command} closed the connection`));
  connection.onNotification((method, params) => {
    PubSub.publishUnsafe(events, { method, params });
  });
  connection.onUnhandledProgress(({ token, value }) =>
    run(
      SubscriptionRef.update(progress, (active) =>
        value.kind === "begin"
          ? HashSet.add(active, token)
          : value.kind === "end"
            ? HashSet.remove(active, token)
            : active,
      ),
    ),
  );
  connection.onRequest(WorkDoneProgressCreateRequest.type, () => undefined);
  connection.onRequest(RegistrationRequest.type, () => undefined);
  connection.onRequest(UnregistrationRequest.type, () => undefined);
  connection.onRequest(ConfigurationRequest.type, ({ items }) =>
    items.map((item) => section(options.settings, item.section)),
  );
  const rootUri = URI.file(options.root).toString();
  const workspaceFolders = [
    { uri: rootUri, name: options.root.split(/[\\/]/).pop() ?? options.root },
  ];
  connection.onRequest(WorkspaceFoldersRequest.type, () => workspaceFolders);
  connection.listen();

  const failure = (method: string, error: unknown) =>
    error instanceof ResponseError
      ? new LspError({ method, message: error.message, code: error.code })
      : new LspError({
        method,
        message: error instanceof Error ? error.message : String(error),
      });

  const send = <P, R>(type: RequestType<P, R, unknown>, params: P) =>
    Effect.callback<R, LspError>((resume) => {
      const cancellation = new CancellationTokenSource();
      try {
        connection.sendRequest(type, params as never, cancellation.token).then(
          (result) => resume(Effect.succeed(result)),
          (error) => resume(Effect.fail(failure(type.method, error))),
        );
      } catch (error) {
        resume(Effect.fail(failure(type.method, error)));
      }
      return Effect.ignore(Effect.try(() => cancellation.cancel()));
    }).pipe(Effect.raceFirst(Deferred.await(exited)));

  const idle = SubscriptionRef.changes(progress).pipe(
    Stream.filter(HashSet.isEmpty),
    Stream.runHead,
    Effect.timeoutOption("15 seconds"),
    Effect.asVoid,
  );

  const request = <P, R>(type: RequestType<P, R, unknown>, params: P) =>
    idle.pipe(
      Effect.andThen(send(type, params)),
      Effect.retry({
        while: (error) => error.retryable,
        schedule: Schedule.exponential("100 millis").pipe(
          Schedule.upTo({ times: 5 }),
        ),
      }),
    );

  const notify = <P>(type: NotificationType<P>, params: P) =>
    Effect.tryPromise({
      try: () => connection.sendNotification(type, params as never),
      catch: (error) => failure(type.method, error),
    }).pipe(Effect.catch((error) => Effect.logWarning(error.message)));

  const notifications = <P>(type: NotificationType<P>): Stream.Stream<P> =>
    Stream.fromPubSub(events).pipe(
      Stream.filter((event) => event.method === type.method),
      Stream.map((event) => event.params as P),
    );

  const onRequest = <P, R>(
    type: RequestType<P, R, unknown>,
    handler: (params: P) => Effect.Effect<R, unknown>,
  ) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        connection.onRequest(
          type.method,
          (params: P): HandlerResult<R, unknown> =>
            runPromise(
              handler(params).pipe(
                Effect.mapError((error) =>
                  error instanceof ResponseError
                    ? error
                    : new ResponseError(
                      ErrorCodes.InternalError,
                      error instanceof Error ? error.message : String(error),
                    ),
                ),
              ),
            ) as Promise<never>,
        ),
      ),
      (disposable) => Effect.sync(() => disposable.dispose()),
    ).pipe(Effect.asVoid);

  const initialized = yield* send(InitializeRequest.type, {
    processId: process.pid,
    clientInfo: { name: "lsp-mcp", version: "0.1.0" },
    locale: "en",
    rootPath: options.root,
    rootUri,
    workspaceFolders,
    capabilities: clientCapabilities,
    initializationOptions: options.initializationOptions as LSPAny,
  });
  yield* notify(InitializedNotification.type, {});
  if (options.settings !== undefined) {
    yield* notify(DidChangeConfigurationNotification.type, {
      settings: options.settings as LSPAny,
    });
  }
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() => connection.sendRequest(ShutdownRequest.type)).pipe(
      Effect.timeout("3 seconds"),
      Effect.andThen(
        Effect.tryPromise(() =>
          connection.sendNotification(ExitNotification.type),
        ),
      ),
      Effect.andThen(Deferred.await(exited).pipe(Effect.timeout("2 seconds"))),
      Effect.ignore,
    ),
  );

  const logs = Stream.merge(
    notifications(LogMessageNotification.type),
    notifications(ShowMessageNotification.type),
  ).pipe(
    Stream.map(
      ({ type, message }): LogMessage => ({
        level: logLevels[type] ?? "info",
        message,
      }),
    ),
  );

  return LanguageServer.of({
    root: options.root,
    capabilities: initialized.capabilities,
    serverInfo: initialized.serverInfo,
    request,
    notify,
    notifications,
    onRequest,
    logs,
  });
});

const logLevels: Record<MessageType, LogLevel> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "debug",
  5: "debug",
};

/** Resolve a dotted `section` path inside the configured settings. */
const section = (settings: unknown, path: string | undefined): LSPAny =>
  (path === undefined
    ? settings
    : path
      .split(".")
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown> | null)?.[key],
        settings,
      )) as LSPAny;

/**
 * What we tell the server we can do. Deliberately narrow: no dynamic
 * registration, no snippets, no watched files (servers fall back to their
 * own watchers), UTF-16 positions only.
 */
const clientCapabilities: ClientCapabilities = {
  general: {
    positionEncodings: ["utf-16"],
    markdown: { parser: "marked", version: "1.1.0" },
  },
  workspace: {
    applyEdit: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: ["create", "rename", "delete"],
      failureHandling: "abort",
    },
    configuration: true,
    workspaceFolders: true,
    symbol: { symbolKind: { valueSet: allSymbolKinds() } },
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: false },
  },
  window: {
    workDoneProgress: true,
    showMessage: {},
    showDocument: { support: false },
  },
  textDocument: {
    synchronization: {
      didSave: true,
      willSave: false,
      willSaveWaitUntil: false,
    },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
      codeDescriptionSupport: true,
      dataSupport: true,
    },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    completion: {
      completionItem: {
        snippetSupport: false,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
      },
      completionItemKind: {
        valueSet: Array.from({ length: 25 }, (_, i) => (i + 1) as CompletionItemKind),
      },
      contextSupport: true,
    },
    signatureHelp: {
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
    },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
    declaration: { linkSupport: true },
    references: {},
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: allSymbolKinds() },
    },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "",
            "quickfix",
            "refactor",
            "refactor.extract",
            "refactor.inline",
            "refactor.rewrite",
            "source",
            "source.organizeImports",
            "source.fixAll",
          ],
        },
      },
      isPreferredSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ["edit"] },
    },
    rename: { prepareSupport: true },
    formatting: {},
    callHierarchy: {},
  },
};

function allSymbolKinds() {
  return Array.from({ length: 26 }, (_, i) => (i + 1) as SymbolKind);
}
