# Effect 4 notes for this repo

Effect `4.0.0-rc.115` (pinned in `package.json`; `repos/effect` is the same version, check
`repos/effect/packages/effect/package.json` if either is bumped). The API differs from Effect 3
in places, and the type stripper gives no hints, so agents kept re-verifying the same shapes.
This file records what has been verified against the source so the next agent does not have to.

When something is not listed here, grep the source, not `node_modules`:
`grep -n "^export const NAME" repos/effect/packages/effect/src/MODULE.ts` shows the signature
and implementation; `repos/effect/packages/effect/test/` has usage examples. Add what you learn.

## Renames from Effect 3 (the things that bite)

- `Effect.async` → `Effect.callback`; `Effect.catchAll` → `Effect.catch`; `Effect.catchAllCause` → `Effect.catchCause`.
- Every `unsafeX` is `xUnsafe`: `Deferred.doneUnsafe`, `Deferred.isDoneUnsafe`, `PubSub.publishUnsafe`,
  `SubscriptionRef.getUnsafe`, `Latch.openUnsafe`, `Scope.makeUnsafe`.
- `Context.Tag` classes are `Context.Service<Self, Shape>()("id")`; layers are built with `Layer.effect(Tag, make)`.
- `Schema.Union([A, B])` and `Schema.Literals(["a", "b"])` take an array. Filters are `.check(Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0))`, not `.pipe(Schema.int())`. `.annotate({ description, message })`.
  `Schema.TaggedError<Self>()("Tag", fields)`; `Schema.NumberFromString`; `Schema.fromJsonString(Schema.Json)`.
- `Duration.isGreaterThan` / `isLessThan` (not `greaterThan`); `Duration.format(d)` prints `1s 500ms`.
- `Effect.timeout` / `timeoutOption` / `timeoutOrElse`; `Stream.runHead` returns an `Option`.
- `Effect.forkScoped(effect, { startImmediately?, uninterruptible? })`; `Effect.forkIn(scope)`; `Effect.forkDetach`.
- `Effect.tap` accepts an effect or a function; `Effect.when(condition)` returns an `Option`.
- `Effect.fn("name")(function* (...) {})` for traced generator functions (used everywhere in `src/lsp/`).

## Schedule (reshaped in v4)

- Constructors: `exponential(base, factor)`, `spaced`, `fixed`, `recurs(n)`, `forever`, `jittered`, `cron`.
- Limits: `Schedule.upTo({ times, duration })` (replaces `intersect(recurs(n))`); `Schedule.while(meta => boolean | Effect)`
  replaces `whileInput` / `whileOutput` / `recurWhile`; `Schedule.modifyDelay(meta => Duration.Input)`; `Schedule.tap(meta => ...)`;
  `Schedule.passthrough`. Combinators: `Schedule.max(a, b)` recurs while both do, with the slower delay (Effect 3
  `intersect`); `Schedule.min` recurs while either does, with the faster delay (`union`); `Schedule.concat` runs one
  then the other (`andThen`). There is no `resetAfter`: write a step with its own state instead (below).
- `Metadata` given to those callbacks: `{ input, output, duration, attempt, start, now, elapsed, elapsedSincePrevious }`.
  `elapsedSincePrevious` is the time between consecutive steps (between crashes, for a restart policy).
- Custom schedules: `Schedule.fromStepWithMetadata(Effect.sync(() => (meta: InputMetadata<Input>) => ...))`, where the step
  returns `Effect.succeed([output, delay])` to continue or `Cause.done(output)` to stop. `Effect.sync` runs once per `retry`,
  so closure state (a crash streak) is per run. See `restarts` in `src/lsp/LanguageServer.ts`.
- `Effect.retry` takes `{ while, until, times, schedule }`, a `Schedule`, or a builder `($) => ...`. `Effect.retryOrElse(schedule,
  (lastError, output) => ...)` runs the fallback once the schedule stops. The effect under retry/repeat sees
  `Schedule.CurrentMetadata` as a service.

## Concurrency primitives (as expected, with v4 names)

- `Deferred.make<A, E>()`, `await`, `succeed`, `fail`, `done(exit)`, `isDone`; the `*Unsafe` variants are synchronous and return
  `boolean` (whether this call completed it). Waiters of `Deferred.await` resume synchronously inside `doneUnsafe`.
- `PubSub.unbounded<A>({ replay? })`, `publish`, `publishUnsafe`, `subscribe`, `Stream.fromPubSub`, `Stream.fromSubscription`.
- `SubscriptionRef.make/get/set/update/changes`; `changes` emits the current value first (replay 1).
- `Latch.make(open?)` with `.open`, `.close`, `.await`, `.release`, `.whenOpen(effect)`.
- `Semaphore.make(n)`, `.withPermits(n)(effect)`; `FiberSet.makeRuntime<R>()` / `makeRuntimePromise` to run effects from callbacks.
- `ScopedCache.makeWith({ capacity, timeToLive: (exit) => Duration, lookup })`, `get`, `has`, `invalidate`, `keys`, `values`, `entries`.
- `Cause.done(value)` is the halt signal used by `Pull`, `Schedule` and `Stream` internals; `Cause.hasInterruptsOnly(cause)`.

## `effect/unstable/cli`

- `Command.make(name, { flag: Flag..., arg: Argument... }, Effect.fn(function* (config) {}))`, `Command.withDescription`,
  `Command.withExamples([{ command, description }])`, `Command.run({ version })`.
- `Flag.String/Int/Boolean/Directory(name, { mustExist })/KeyValuePair/Literals(name, [...])`; `Flag.withSchema(schema)`
  (decodes from the flag's type, so `Schema.NumberFromString` for a string flag), `withDescription`, `withDefault`, `withAlias`,
  `withMetavar("never|always|N")`, `optional` (→ `Option`), `map`, `orElse`. `Argument.String`, `Argument.variadic`.
- Help does not print default values; put them in the description. Schema failures print `Invalid value for flag --x: "v".
  Expected: Schema validation failed: <message annotation or issue>`.

## `effect/unstable/ai` MCP (see `src/Server.ts`, `src/Tools.ts`, `src/Resources.ts`)

- `McpServer.layerStdio(info)` / `layerHttp({ ...info, path })` served with `HttpRouter.serve`; `McpServer.registerToolkit(toolkit)`
  after `Toolkit.toLayer(handlers)`; `McpServer.registerResource({ uri | template, name, description, mimeType, content, completion })`.
- `Tool.make(name, { description, parameters, success, failure, dependencies }).annotate(Tool.Readonly, ...)`.
- `McpServer.McpServer` service exposes `notifications["notifications/message" | "notifications/resources/updated"]`.

## `@effect/vitest`

- `it.effect` / `it.live` tests run inside a `Scope`; `it.layer(layer, { excludeTestServices: true })("name", (it) => ...)` shares the
  layer across the block and, with that option, uses the real clock (`Stream.debounce` and timeouts hang under `TestClock`).
- Real processes and `Effect.sleep` need real time, so every fixture-server test uses `excludeTestServices` or `it.live`.

## `vscode-jsonrpc` (not Effect, but verified the same way)

- Loss of the peer: `connection.onClose` fires on transport close and on `dispose()`; pending requests reject with
  `ResponseError` codes `ConnectionInactive` (-32096), `PendingResponseRejected` (-32097) or `MessageWriteError` (-32099).
- Writing to a dead child's stdin rejects a promise nobody handles (EPIPE crashes the process). `LanguageServer.ts` writes through
  a `PassThrough` piped into stdin and listens for stdin errors instead.
- `connection.onRequest((method, params) => ...)` registers a catch-all ("star") handler; handlers registered per type are
  consulted first.
