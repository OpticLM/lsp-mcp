/**
 * A running language server: process, JSON-RPC connection and the LSP
 * lifecycle, exposed as an Effect service.
 *
 * `request` waits for the server to become idle (no `$/progress` work in
 * flight) and retries transient `ContentModified` / `ServerCancelled`
 * failures, so callers can treat the server as if it were always ready.
 *
 * The process is supervised: when it exits unexpectedly it is started again
 * according to the restart policy, the documents that were open are opened in
 * the new process, and requests caught by the crash wait for it and retry.
 * Once the policy gives up, every request fails with an `LspError` saying so.
 */
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { NodeStream } from "@effect/platform-node";
import {
  Cause,
  Context,
  Deferred,
  Duration,
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
  type ConfigurationParams,
  ConfigurationRequest,
  createMessageConnection,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  type DidChangeTextDocumentParams,
  DidCloseTextDocumentNotification,
  type DidCloseTextDocumentParams,
  DidOpenTextDocumentNotification,
  type DidOpenTextDocumentParams,
  ErrorCodes,
  ExitNotification,
  type HandlerResult,
  InitializedNotification,
  InitializeRequest,
  type InitializeResult,
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
  type TextDocumentItem,
  UnregistrationRequest,
  WorkDoneProgressCreateRequest,
  WorkspaceFoldersRequest,
} from "vscode-languageserver-protocol/node";
import { URI } from "vscode-uri";

/**
 * What to do when the server exits unexpectedly: never start it again, always
 * start it again, or start it again but give up after this many crashes in a
 * row (less than a minute apart).
 */
export type Restart = "never" | "always" | number;

export interface Options {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Absolute path of the workspace root. */
  readonly root: string;
  readonly initializationOptions?: unknown;
  /** Served as `workspace/configuration` and pushed via `didChangeConfiguration`. */
  readonly settings?: unknown;
  /** Defaults to giving up after 3 crashes in a row. */
  readonly restart?: Restart;
}

/** Failures worth retrying: the server was busy, or it went away and may come back. */
const transient: ReadonlySet<number> = new Set([
  LSPErrorCodes.ContentModified,
  LSPErrorCodes.ServerCancelled,
  ErrorCodes.ConnectionInactive,
  ErrorCodes.PendingResponseRejected,
  ErrorCodes.MessageWriteError,
]);

export class LspError extends Schema.TaggedError<LspError>()("LspError", {
  method: Schema.String,
  message: Schema.String,
  code: Schema.optional(Schema.Int),
}) {
  get retryable() {
    return this.code !== undefined && transient.has(this.code);
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
    /** `window/logMessage` and `window/showMessage` traffic, plus restart announcements. */
    readonly logs: Stream.Stream<LogMessage>;
  }
>()("lsp-mcp/lsp/LanguageServer") {
  static readonly layer = (options: Options) =>
    Layer.effect(LanguageServer, make(options));
}

/** One process and its connection; replaced on crash. */
interface Session {
  readonly initialized: InitializeResult;
  readonly exited: Deferred.Deferred<never, LspError>;
  readonly send: <P, R>(
    type: RequestType<P, R, unknown>,
    params: P,
  ) => Effect.Effect<R, LspError>;
  readonly notify: <P>(
    type: NotificationType<P>,
    params: P,
  ) => Effect.Effect<void, LspError>;
}

const make = Effect.fn("LanguageServer.make")(function* (options: Options) {
  const run = yield* FiberSet.makeRuntime<never>();
  const runPromise = yield* FiberSet.makeRuntimePromise<never>();
  const events = yield* PubSub.unbounded<{
    readonly method: string;
    readonly params: unknown;
  }>();
  const lifecycle = yield* PubSub.unbounded<LogMessage>();
  const progress = yield* SubscriptionRef.make(
    HashSet.empty<string | number>(),
  );
  const initialized = yield* Deferred.make<InitializeResult, LspError>();
  /** The live session, or the one being started; failed once the policy gives up. */
  let current = Deferred.makeUnsafe<Session, LspError>();
  const session = Effect.suspend(() => Deferred.await(current));
  /** What the server has been told is open, to open it again after a restart. */
  const documents = new Map<string, TextDocumentItem>();
  const limit =
    options.restart === "never"
      ? 0
      : options.restart === "always"
        ? Number.POSITIVE_INFINITY
        : (options.restart ?? 3);

  const rootUri = URI.file(options.root).toString();
  const workspaceFolders = [
    { uri: rootUri, name: options.root.split(/[\\/]/).pop() ?? options.root },
  ];
  const handlers = new Map<
    string,
    (params: unknown) => HandlerResult<unknown, unknown>
  >([
    [WorkDoneProgressCreateRequest.method, () => undefined],
    [RegistrationRequest.method, () => undefined],
    [UnregistrationRequest.method, () => undefined],
    [
      ConfigurationRequest.method,
      (params) =>
        (params as ConfigurationParams).items.map((item) =>
          section(options.settings, item.section),
        ),
    ],
    [WorkspaceFoldersRequest.method, () => workspaceFolders],
  ]);

  const failure = (method: string, error: unknown) =>
    error instanceof ResponseError
      ? new LspError({ method, message: error.message, code: error.code })
      : new LspError({
          method,
          message: error instanceof Error ? error.message : String(error),
        });

  const announce = (level: LogLevel, message: string) =>
    Effect.andThen(
      level === "error" ? Effect.logError(message) : Effect.logWarning(message),
      PubSub.publish(lifecycle, { level, message }),
    );

  const start = Effect.fn("LanguageServer.start")(function* () {
    const exited = yield* Deferred.make<never, LspError>();
    const exit = (message: string) => {
      if (Deferred.isDoneUnsafe(exited)) return;
      // Whoever was using this session now waits for the next one; swap before
      // signalling, as waiters resume synchronously and may give up right away.
      if (Deferred.isDoneUnsafe(current)) current = Deferred.makeUnsafe();
      Deferred.doneUnsafe(
        exited,
        Effect.fail(
          new LspError({
            method: "connection",
            message,
            code: ErrorCodes.ConnectionInactive,
          }),
        ),
      );
    };

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

    // Writes go through a buffer: a broken pipe must end the session, not
    // surface as a write failure (vscode-jsonrpc leaks those as unhandled rejections).
    const input = new PassThrough();
    input.pipe(child.stdin);
    child.stdin.on("error", (error) =>
      exit(`${options.command}: ${error.message}`),
    );
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(input),
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
    connection.onRequest(
      (method, params) =>
        handlers.get(method)?.(params) ??
        new ResponseError(ErrorCodes.MethodNotFound, `unhandled ${method}`),
    );
    connection.listen();

    const send = <P, R>(type: RequestType<P, R, unknown>, params: P) =>
      Effect.callback<R, LspError>((resume) => {
        const cancellation = new CancellationTokenSource();
        try {
          connection
            .sendRequest(type, params as never, cancellation.token)
            .then(
              (result) => resume(Effect.succeed(result)),
              (error) => resume(Effect.fail(failure(type.method, error))),
            );
        } catch (error) {
          resume(Effect.fail(failure(type.method, error)));
        }
        return Effect.ignore(Effect.try(() => cancellation.cancel()));
      }).pipe(Effect.raceFirst(Deferred.await(exited)));

    const notify = <P>(type: NotificationType<P>, params: P) =>
      Effect.tryPromise({
        try: () => connection.sendNotification(type, params as never),
        catch: (error) => failure(type.method, error),
      });

    yield* SubscriptionRef.set(progress, HashSet.empty());
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
    yield* Effect.forEach(
      documents.values(),
      (textDocument) =>
        notify(DidOpenTextDocumentNotification.type, { textDocument }),
      { discard: true },
    );
    const shutdown = Effect.tryPromise(() =>
      connection.sendRequest(ShutdownRequest.type),
    ).pipe(
      Effect.timeout("3 seconds"),
      Effect.andThen(
        Effect.tryPromise(() =>
          connection.sendNotification(ExitNotification.type),
        ),
      ),
      Effect.andThen(Deferred.await(exited).pipe(Effect.timeout("2 seconds"))),
      Effect.ignore,
    );
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() =>
        Deferred.isDoneUnsafe(exited) ? Effect.void : shutdown,
      ),
    );
    return { initialized, exited, send, notify } satisfies Session;
  });

  /** Runs one session until its process exits, and fails with the reason. */
  const serve = Effect.scoped(
    Effect.gen(function* () {
      const session = yield* start().pipe(
        Effect.tapError((error) => Deferred.fail(initialized, error)),
      );
      yield* Deferred.succeed(current, session);
      yield* Deferred.succeed(initialized, session.initialized);
      return yield* Deferred.await(session.exited);
    }),
  );

  const policy = restarts(limit).pipe(
    // Only crashes are worth retrying; a server that fails to initialize is broken.
    Schedule.while(({ input }) => input.code === ErrorCodes.ConnectionInactive),
    Schedule.tap(({ input, output, duration }) =>
      announce(
        "warning",
        `${input.message}; restarting in ${Duration.format(duration)}${
          Number.isFinite(limit) ? ` (crash ${output} of ${limit})` : ""
        }`,
      ),
    ),
  );

  const giveUp = (error: LspError) => {
    const reason =
      error.code !== ErrorCodes.ConnectionInactive
        ? `restarting ${options.command} failed (${error.method}: ${error.message})`
        : limit === 0
          ? `${error.message}; restarting is disabled`
          : `${error.message}; that is ${limit} crash${limit === 1 ? "" : "es"} in a row`;
    const message = `${reason}. Restart lsp-mcp to recover`;
    return Effect.andThen(
      announce("error", message),
      Deferred.fail(current, new LspError({ method: "connection", message })),
    );
  };

  yield* serve.pipe(Effect.retryOrElse(policy, giveUp), Effect.forkScoped);
  const first = yield* Deferred.await(initialized);

  const idle = SubscriptionRef.changes(progress).pipe(
    Stream.filter(HashSet.isEmpty),
    Stream.runHead,
    Effect.timeoutOption("15 seconds"),
    Effect.asVoid,
  );

  const request = <P, R>(type: RequestType<P, R, unknown>, params: P) =>
    session.pipe(
      Effect.tap(() => idle),
      Effect.flatMap((session) => session.send(type, params)),
      Effect.retry({
        while: (error) => error.retryable,
        schedule: Schedule.exponential("100 millis").pipe(
          Schedule.upTo({ times: 5 }),
        ),
      }),
    );

  const notify = <P>(type: NotificationType<P>, params: P) =>
    Effect.sync(() => track(documents, type.method, params)).pipe(
      Effect.andThen(session),
      Effect.flatMap((session) => session.notify(type, params)),
      Effect.catch((error) => Effect.logWarning(error.message)),
    );

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
        handlers.set(
          type.method,
          (params) =>
            runPromise(
              handler(params as P).pipe(
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
      () => Effect.sync(() => handlers.delete(type.method)),
    ).pipe(Effect.asVoid);

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
    Stream.merge(Stream.fromPubSub(lifecycle)),
  );

  return LanguageServer.of({
    root: options.root,
    capabilities: first.capabilities,
    serverInfo: first.serverInfo,
    request,
    notify,
    notifications,
    onRequest,
    logs,
  });
});

/** A crash this long after the previous one starts a fresh streak. */
const quiet = Duration.minutes(1);

/**
 * Restart delays: exponential from 500ms, capped at 30s, giving up once
 * `limit` crashes happened in a row. The output is the length of the streak.
 */
const restarts = (limit: number) =>
  Schedule.fromStepWithMetadata(
    Effect.sync(() => {
      let streak = 0;
      return ({ elapsedSincePrevious }: Schedule.InputMetadata<LspError>) => {
        streak =
          elapsedSincePrevious > Duration.toMillis(quiet) ? 1 : streak + 1;
        return streak > limit
          ? Cause.done(streak)
          : Effect.succeed<[number, Duration.Duration]>([
              streak,
              Duration.millis(Math.min(500 * 2 ** (streak - 1), 30_000)),
            ]);
      };
    }),
  );

/** Keep the open-document bookkeeping in step with what we tell the server. */
const track = (
  documents: Map<string, TextDocumentItem>,
  method: string,
  params: unknown,
) => {
  switch (method) {
    case DidOpenTextDocumentNotification.method: {
      const { textDocument } = params as DidOpenTextDocumentParams;
      documents.set(textDocument.uri, textDocument);
      break;
    }
    case DidChangeTextDocumentNotification.method: {
      const { textDocument, contentChanges } =
        params as DidChangeTextDocumentParams;
      const open = documents.get(textDocument.uri);
      const last = contentChanges.at(-1);
      if (open && last && !("range" in last)) {
        documents.set(textDocument.uri, {
          ...open,
          version: textDocument.version,
          text: last.text,
        });
      }
      break;
    }
    case DidCloseTextDocumentNotification.method:
      documents.delete((params as DidCloseTextDocumentParams).textDocument.uri);
  }
};

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
        valueSet: Array.from(
          { length: 25 },
          (_, i) => (i + 1) as CompletionItemKind,
        ),
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
