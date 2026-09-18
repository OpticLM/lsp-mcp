/**
 * Diagnostics reconcile LSP's push model with the agent's pull model.
 *
 * Published diagnostics are accumulated per URI. Asking for a document's
 * diagnostics either pulls them (when the server supports
 * `textDocument/diagnostic`) or waits for the push that follows the document's
 * latest version to settle, bounded by a timeout.
 */
import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
} from "effect";
import {
  type Diagnostic,
  DocumentDiagnosticReportKind,
  DocumentDiagnosticRequest,
  PublishDiagnosticsNotification,
  type PublishDiagnosticsParams,
  WorkspaceDiagnosticRequest,
} from "vscode-languageserver-protocol";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { LanguageServer, type LspError } from "./LanguageServer.ts";

/** Quiet period after a publish before diagnostics count as settled. */
const settle = "250 millis";
/** How long to wait for a server that never publishes for a change. */
const patience = "5 seconds";

const make = Effect.gen(function* () {
  const lsp = yield* LanguageServer;
  const state = yield* Ref.make(
    HashMap.empty<string, PublishDiagnosticsParams>(),
  );
  const updates = yield* PubSub.unbounded<string>();
  const settled = new Map<string, number>();
  const provider = lsp.capabilities.diagnosticProvider;

  const publish = (params: PublishDiagnosticsParams) =>
    Ref.update(state, HashMap.set(params.uri, params)).pipe(
      Effect.andThen(PubSub.publish(updates, params.uri)),
    );
  yield* lsp
    .notifications(PublishDiagnosticsNotification.type)
    .pipe(Stream.runForEach(publish), Effect.forkScoped);

  const current = (uri: string) =>
    Ref.get(state).pipe(
      Effect.map((map) => Option.getOrUndefined(HashMap.get(map, uri))),
    );

  const pull = Effect.fn("Diagnostics.pull")(function* (doc: TextDocument) {
    const report = yield* lsp.request(DocumentDiagnosticRequest.type, {
      textDocument: { uri: doc.uri },
    });
    if (report.kind === DocumentDiagnosticReportKind.Full) {
      yield* publish({
        uri: doc.uri,
        version: doc.version,
        diagnostics: report.items,
      });
    }
    return (yield* current(doc.uri))?.diagnostics ?? [];
  });

  const awaitPush = Effect.fn("Diagnostics.awaitPush")(function* (
    doc: TextDocument,
  ) {
    if (settled.get(doc.uri) !== doc.version) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(updates);
          const fresh = (yield* current(doc.uri))?.version === doc.version;
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((uri) => uri === doc.uri),
            Stream.debounce(settle),
            Stream.runHead,
            Effect.timeoutOption(fresh ? settle : patience),
          );
        }),
      );
      settled.set(doc.uri, doc.version);
    }
    return (yield* current(doc.uri))?.diagnostics ?? [];
  });

  const all = Effect.gen(function* () {
    if (provider?.workspaceDiagnostics) {
      const report = yield* lsp.request(WorkspaceDiagnosticRequest.type, {
        previousResultIds: [],
      });
      for (const item of report.items) {
        if (item.kind === DocumentDiagnosticReportKind.Full) {
          yield* publish({
            uri: item.uri,
            diagnostics: item.items,
            ...(item.version === null ? {} : { version: item.version }),
          });
        }
      }
    }
    return Array.from(HashMap.values(yield* Ref.get(state)));
  });

  return Diagnostics.of({
    all,
    forDocument: provider ? pull : awaitPush,
    changes: Stream.fromPubSub(updates),
  });
});

export class Diagnostics extends Context.Service<
  Diagnostics,
  {
    /** Everything the server has reported, per URI. */
    readonly all: Effect.Effect<
      ReadonlyArray<PublishDiagnosticsParams>,
      LspError
    >;
    /** Diagnostics matching the document's current version. */
    readonly forDocument: (
      doc: TextDocument,
    ) => Effect.Effect<ReadonlyArray<Diagnostic>, LspError>;
    /** URIs whose diagnostics changed. */
    readonly changes: Stream.Stream<string>;
  }
>()("lsp-mcp/lsp/Diagnostics") {
  static readonly layer = Layer.effect(Diagnostics, make);
}
