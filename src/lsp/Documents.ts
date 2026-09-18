/**
 * The headless editor's document store.
 *
 * Documents are opened in the language server on demand and kept in an LRU
 * set; the least recently used one is closed when the capacity is exceeded.
 * Every access re-checks the file on disk and, if it changed, pushes the new
 * content as `didChange` + `didSave`, so edits agents make with other tools
 * are visible to the server without any explicit synchronization step.
 */
import {
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Schema,
  ScopedCache,
  Semaphore,
} from "effect";
import {
  ApplyWorkspaceEditRequest,
  CreateFile,
  DeleteFile,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  RenameFile,
  type TextDocumentEdit,
  type TextEdit,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { LanguageServer } from "./LanguageServer.ts";

export interface Options {
  /** How many documents stay open in the server before the least recently used is closed. */
  readonly capacity: number;
  /** Extra file extension (without dot) to LSP `languageId` mappings. */
  readonly languages: Readonly<Record<string, string>>;
}

export class DocumentError extends Schema.TaggedError<DocumentError>()(
  "DocumentError",
  {
    file: Schema.String,
    message: Schema.String,
  },
) {}

export type Change = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;

export class Documents extends Context.Service<
  Documents,
  {
    /** URI for a path that is absolute or relative to the workspace root. */
    readonly uri: (file: string) => string;
    /** Display path for a URI: relative to the root when inside it. */
    readonly file: (uri: string) => string;
    /** Open (or refresh) a document in the server and return its current text. */
    readonly open: (file: string) => Effect.Effect<TextDocument, DocumentError>;
    /** Current content of a URI without opening it in the server. */
    readonly peek: (uri: string) => Effect.Effect<TextDocument, DocumentError>;
    /** Replace an open document's content on disk and in the server. */
    readonly write: (
      uri: string,
      text: string,
    ) => Effect.Effect<void, DocumentError>;
    /** Apply a server-provided edit to disk, in order, refusing stale versions. */
    readonly applyEdit: (
      edit: WorkspaceEdit,
    ) => Effect.Effect<void, DocumentError>;
    readonly opened: Effect.Effect<ReadonlyArray<string>>;
  }
>()("lsp-mcp/lsp/Documents") {
  static readonly layer = (options: Options) =>
    Layer.effect(Documents, make(options));
}

/** The ordered list of changes described by a `WorkspaceEdit`. */
export const changes = (edit: WorkspaceEdit): ReadonlyArray<Change> =>
  edit.documentChanges ??
  Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({
    textDocument: { uri, version: null },
    edits,
  }));

const textEdits = (edit: TextDocumentEdit): Array<TextEdit> =>
  edit.edits.filter((e): e is TextEdit => "newText" in e);

interface Entry {
  readonly doc: TextDocument;
  stamp: string;
}

const make = Effect.fn("Documents.make")(function* (options: Options) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lsp = yield* LanguageServer;
  const lock = yield* Semaphore.make(1);
  const sync = lsp.capabilities.textDocumentSync;
  const save = typeof sync === "object" ? sync.save : undefined;

  const uri = (file: string) =>
    URI.file(path.resolve(lsp.root, file)).toString();
  const fsPath = (uri: string) => URI.parse(uri).fsPath;
  const file = (uri: string) => {
    const parsed = URI.parse(uri);
    if (parsed.scheme !== "file") return uri;
    const relative = path.relative(lsp.root, parsed.fsPath);
    return relative.startsWith("..") || path.isAbsolute(relative)
      ? parsed.fsPath
      : relative;
  };
  const io = (uri: string) => (error: PlatformError.PlatformError) =>
    new DocumentError({ file: file(uri), message: error.message });
  const read = (uri: string) =>
    fs.readFileString(fsPath(uri)).pipe(Effect.mapError(io(uri)));
  const stamp = (uri: string) =>
    fs.stat(fsPath(uri)).pipe(
      Effect.map(
        (info) =>
          `${Option.getOrUndefined(info.mtime)?.getTime()}:${info.size}`,
      ),
      Effect.mapError(io(uri)),
    );

  const languageId = (uri: string) => {
    const name = path.basename(fsPath(uri)).toLowerCase();
    const ext = path.extname(name).slice(1);
    return (
      options.languages[ext] ?? languages[ext] ?? languages[name] ?? "plaintext"
    );
  };

  const cache = yield* ScopedCache.makeWith<string, Entry, DocumentError>({
    capacity: options.capacity,
    timeToLive: (exit) =>
      Exit.isFailure(exit) ? Duration.zero : Duration.infinity,
    lookup: (uri) =>
      Effect.gen(function* () {
        const [text, current] = yield* Effect.all([read(uri), stamp(uri)]);
        const doc = TextDocument.create(uri, languageId(uri), 1, text);
        yield* Effect.acquireRelease(
          lsp.notify(DidOpenTextDocumentNotification.type, {
            textDocument: {
              uri,
              languageId: doc.languageId,
              version: doc.version,
              text,
            },
          }),
          () =>
            lsp.notify(DidCloseTextDocumentNotification.type, {
              textDocument: { uri },
            }),
        );
        return { doc, stamp: current } satisfies Entry;
      }),
  });

  const change = Effect.fn("Documents.change")(function* (
    entry: Entry,
    text: string,
  ) {
    const { uri } = entry.doc;
    const version = entry.doc.version + 1;
    TextDocument.update(entry.doc, [{ text }], version);
    yield* lsp.notify(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    if (save) {
      yield* lsp.notify(DidSaveTextDocumentNotification.type, {
        textDocument: { uri },
        ...(typeof save === "object" && save.includeText ? { text } : {}),
      });
    }
  });

  /** Bring an open document in line with the file on disk. */
  const refresh = Effect.fn("Documents.refresh")(function* (uri: string) {
    const entry = yield* ScopedCache.get(cache, uri);
    const current = yield* stamp(uri).pipe(
      Effect.tapError(() => ScopedCache.invalidate(cache, uri)),
    );
    if (current !== entry.stamp) {
      const text = yield* read(uri);
      entry.stamp = current;
      if (text !== entry.doc.getText()) yield* change(entry, text);
    }
    return entry.doc;
  });

  const open = (file: string) => lock.withPermits(1)(refresh(uri(file)));

  const peek = (uri: string) =>
    Effect.flatMap(ScopedCache.has(cache, uri), (open) =>
      open
        ? lock.withPermits(1)(refresh(uri))
        : Effect.map(read(uri), (text) =>
            TextDocument.create(uri, "", 0, text),
          ),
    );

  /** Persist new content for an open document and tell the server. */
  const store = Effect.fn("Documents.store")(function* (
    uri: string,
    text: string,
  ) {
    const entry = yield* ScopedCache.get(cache, uri);
    yield* fs.writeFileString(fsPath(uri), text).pipe(Effect.mapError(io(uri)));
    entry.stamp = yield* stamp(uri);
    if (text !== entry.doc.getText()) yield* change(entry, text);
  });

  const write = (uri: string, text: string) =>
    lock.withPermits(1)(store(uri, text));

  const forget = (uri: string) => ScopedCache.invalidate(cache, uri);

  const apply = Effect.fn("Documents.applyChange")(function* (change: Change) {
    if (CreateFile.is(change)) {
      const target = fsPath(change.uri);
      if (
        change.options?.ignoreIfExists &&
        (yield* fs.exists(target).pipe(Effect.mapError(io(change.uri))))
      )
        return;
      yield* fs
        .makeDirectory(path.dirname(target), { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(target, "")),
          Effect.mapError(io(change.uri)),
        );
    } else if (RenameFile.is(change)) {
      yield* Effect.all([forget(change.oldUri), forget(change.newUri)]);
      yield* fs
        .rename(fsPath(change.oldUri), fsPath(change.newUri))
        .pipe(Effect.mapError(io(change.oldUri)));
    } else if (DeleteFile.is(change)) {
      yield* forget(change.uri);
      yield* fs
        .remove(fsPath(change.uri), {
          recursive: change.options?.recursive ?? false,
        })
        .pipe(Effect.mapError(io(change.uri)));
    } else {
      const { uri, version } = change.textDocument;
      const doc = yield* refresh(uri);
      if (
        version !== null &&
        version !== undefined &&
        version !== doc.version
      ) {
        return yield* new DocumentError({
          file: file(uri),
          message: "document changed since the edit was computed",
        });
      }
      yield* store(uri, TextDocument.applyEdits(doc, textEdits(change)));
    }
  });

  const applyEdit = (edit: WorkspaceEdit) =>
    lock.withPermits(1)(
      Effect.forEach(changes(edit), apply, { discard: true }),
    );

  yield* lsp.onRequest(ApplyWorkspaceEditRequest.type, ({ edit }) =>
    applyEdit(edit).pipe(
      Effect.as({ applied: true }),
      Effect.catch((error) =>
        Effect.succeed({ applied: false, failureReason: error.message }),
      ),
    ),
  );

  return Documents.of({
    uri,
    file,
    open,
    peek,
    write,
    applyEdit,
    opened: ScopedCache.keys(cache),
  });
});

const languages: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "jsonc",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  cs: "csharp",
  fs: "fsharp",
  swift: "swift",
  rb: "ruby",
  php: "php",
  lua: "lua",
  zig: "zig",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  cljs: "clojurescript",
  dart: "dart",
  elm: "elm",
  nix: "nix",
  r: "r",
  jl: "julia",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  sql: "sql",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  tf: "terraform",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",
  tex: "latex",
  vim: "vim",
  dockerfile: "dockerfile",
  makefile: "makefile",
};
