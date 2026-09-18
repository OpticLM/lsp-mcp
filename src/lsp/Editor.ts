/**
 * The operations an agent performs on the headless editor.
 *
 * Each function resolves agent-facing input (paths, 1-based positions,
 * symbols on a line) to LSP requests and presents the results in the
 * `Model` vocabulary. These functions are the MCP tool handlers.
 */
import { Effect, Option } from "effect";
import {
  CallHierarchyIncomingCallsRequest,
  CallHierarchyOutgoingCallsRequest,
  CallHierarchyPrepareRequest,
  CodeAction,
  CodeActionRequest,
  CodeActionResolveRequest,
  CodeActionTriggerKind,
  type Command,
  CompletionItemKind,
  CompletionRequest,
  CompletionTriggerKind,
  DeclarationRequest,
  DefinitionRequest,
  type Diagnostic,
  DocumentFormattingRequest,
  type DocumentSymbol,
  DocumentSymbolRequest,
  ExecuteCommandRequest,
  type Hover,
  HoverRequest,
  ImplementationRequest,
  type Location,
  type LocationLink,
  type MarkupContent,
  type Position,
  type Range,
  ReferencesRequest,
  RenameRequest,
  type ServerCapabilities,
  SignatureHelpRequest,
  SymbolKind,
  TextDocumentEdit,
  TypeDefinitionRequest,
  type WorkspaceEdit,
  WorkspaceSymbolRequest,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import type * as Model from "../Model.ts";
import { Diagnostics } from "./Diagnostics.ts";
import { changes, Documents } from "./Documents.ts";
import { LanguageServer, LspError } from "./LanguageServer.ts";

// --- Presentation ----------------------------------------------------------

const range = (r: Range): Model.Range => ({
  line: r.start.line + 1,
  column: r.start.character + 1,
  endLine: r.end.line + 1,
  endColumn: r.end.character + 1,
});

const lineText = (doc: TextDocument, line: number) =>
  doc
    .getText()
    .slice(
      doc.offsetAt({ line, character: 0 }),
      doc.offsetAt({ line: line + 1, character: 0 }),
    )
    .replace(/\r?\n$/, "");

const preview = (doc: TextDocument | undefined, line: number) =>
  doc === undefined ? "" : lineText(doc, line).trim();

const markup = (content: Hover["contents"] | MarkupContent | string): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map(markup).join("\n\n")
      : "kind" in content
        ? content.value
        : `\`\`\`${content.language}\n${content.value}\n\`\`\``;

/** `{ Class: 5 }` → `{ 5: "class" }`, `{ TypeParameter: 26 }` → `{ 26: "typeParameter" }`. */
const kindNames = (kinds: Record<string, number>): Record<number, string> =>
  Object.fromEntries(
    Object.entries(kinds).map(([name, value]) => [
      value,
      name[0]?.toLowerCase() + name.slice(1),
    ]),
  );
const symbolKinds = kindNames(SymbolKind);
const completionKinds = kindNames(CompletionItemKind);
const severities = [
  "error",
  "warning",
  "information",
  "hint",
] as const satisfies ReadonlyArray<Model.Severity>;

// --- Resolution ------------------------------------------------------------

const unsupported = (feature: string) =>
  new LspError({
    method: feature,
    message: `the language server does not support ${feature}`,
  });

const ensure = (
  capabilities: ServerCapabilities,
  key: keyof ServerCapabilities,
) => (capabilities[key] ? Effect.void : Effect.fail(unsupported(key)));

/** Turn agent-facing `Where` into an LSP text document position. */
const locate = Effect.fn("Editor.locate")(function* (where: Model.Where) {
  const docs = yield* Documents;
  const doc = yield* docs.open(where.file);
  const line = where.line - 1;
  if (line >= doc.lineCount) {
    return yield* new LspError({
      method: "locate",
      message: `${where.file} has only ${doc.lineCount} lines`,
    });
  }
  const text = lineText(doc, line);
  const character =
    where.column !== undefined
      ? where.column - 1
      : where.symbol !== undefined
        ? findSymbol(text, where.symbol)
        : Math.max(0, text.search(/\S/));
  if (character < 0) {
    return yield* new LspError({
      method: "locate",
      message: `"${where.symbol}" does not occur on line ${where.line}`,
    });
  }
  const position: Position = {
    line,
    character: Math.min(character, text.length),
  };
  return { doc, position, textDocument: { uri: doc.uri } };
});

/** Index of `symbol` as a whole word on the line, else its first occurrence, else -1. */
const findSymbol = (text: string, symbol: string) => {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const index = text.search(
    new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "u"),
  );
  return index >= 0 ? index : text.indexOf(symbol);
};

const locations = Effect.fn("Editor.locations")(function* (
  items: ReadonlyArray<Location | LocationLink>,
) {
  const docs = yield* Documents;
  const targets = items.map((item) =>
    "targetUri" in item
      ? { uri: item.targetUri, range: item.targetSelectionRange }
      : item,
  );
  const previews = new Map(
    yield* Effect.forEach([...new Set(targets.map((t) => t.uri))], (uri) =>
      docs.peek(uri).pipe(
        Effect.option,
        Effect.map((doc) => [uri, Option.getOrUndefined(doc)] as const),
      ),
    ),
  );
  return targets.map(
    ({ uri, range: r }): Model.Location => ({
      file: docs.file(uri),
      ...range(r),
      preview: preview(previews.get(uri), r.start.line),
    }),
  );
});

const workspaceEdit = Effect.fn("Editor.workspaceEdit")(function* (
  edit: WorkspaceEdit,
  apply: boolean,
) {
  const docs = yield* Documents;
  const files: Array<typeof Model.FileEdits.Type> = [];
  const operations: Array<string> = [];
  for (const change of changes(edit)) {
    if (TextDocumentEdit.is(change)) {
      files.push({
        file: docs.file(change.textDocument.uri),
        edits: change.edits.flatMap((e) =>
          "newText" in e ? [{ ...range(e.range), newText: e.newText }] : [],
        ),
      });
    } else if (change.kind === "rename") {
      operations.push(
        `rename ${docs.file(change.oldUri)} -> ${docs.file(change.newUri)}`,
      );
    } else {
      operations.push(`${change.kind} ${docs.file(change.uri)}`);
    }
  }
  if (apply) yield* docs.applyEdit(edit);
  return { applied: apply, files, operations } satisfies Model.WorkspaceEdit;
});

// --- Operations ------------------------------------------------------------

export const hover = Effect.fn("Editor.hover")(function* (where: Model.Where) {
  const lsp = yield* LanguageServer;
  const { textDocument, position } = yield* locate(where);
  const result = yield* lsp.request(HoverRequest.type, {
    textDocument,
    position,
  });
  return result === null
    ? null
    : ({
        contents: markup(result.contents),
        range: result.range && range(result.range),
      } satisfies Model.Hover);
});

const gotoRequests = {
  definition: DefinitionRequest.type,
  typeDefinition: TypeDefinitionRequest.type,
  implementation: ImplementationRequest.type,
  declaration: DeclarationRequest.type,
};

export const definition = Effect.fn("Editor.definition")(function* ({
  kind = "definition",
  ...where
}: Model.Goto) {
  const lsp = yield* LanguageServer;
  yield* ensure(lsp.capabilities, `${kind}Provider`);
  const { textDocument, position } = yield* locate(where);
  const result = yield* lsp.request(
    gotoRequests[kind] as typeof DefinitionRequest.type,
    { textDocument, position },
  );
  return yield* locations(
    result === null ? [] : Array.isArray(result) ? result : [result],
  );
});

export const references = Effect.fn("Editor.references")(function* ({
  includeDeclaration = true,
  ...where
}: Model.References) {
  const lsp = yield* LanguageServer;
  const { textDocument, position } = yield* locate(where);
  const result = yield* lsp.request(ReferencesRequest.type, {
    textDocument,
    position,
    context: { includeDeclaration },
  });
  return yield* locations(result ?? []);
});

export const documentSymbols = Effect.fn("Editor.documentSymbols")(function* ({
  file,
}: {
  readonly file: string;
}) {
  const lsp = yield* LanguageServer;
  const docs = yield* Documents;
  const doc = yield* docs.open(file);
  const result = yield* lsp.request(DocumentSymbolRequest.type, {
    textDocument: { uri: doc.uri },
  });
  const present = (symbol: DocumentSymbol): Model.DocumentSymbol => ({
    name: symbol.name,
    kind: symbolKinds[symbol.kind] ?? "unknown",
    detail: symbol.detail || undefined,
    ...range(symbol.range),
    children: symbol.children?.length
      ? symbol.children.map(present)
      : undefined,
  });
  return (result ?? []).map(
    (symbol): Model.DocumentSymbol =>
      "range" in symbol
        ? present(symbol)
        : {
            name: symbol.name,
            kind: symbolKinds[symbol.kind] ?? "unknown",
            container: symbol.containerName || undefined,
            ...range(symbol.location.range),
          },
  );
});

export const workspaceSymbols = Effect.fn("Editor.workspaceSymbols")(
  function* ({ query, limit = 50 }: Model.WorkspaceQuery) {
    const lsp = yield* LanguageServer;
    const docs = yield* Documents;
    const result = yield* lsp.request(WorkspaceSymbolRequest.type, { query });
    return (result ?? []).slice(0, limit).map(
      (symbol): Model.WorkspaceSymbol => ({
        name: symbol.name,
        kind: symbolKinds[symbol.kind] ?? "unknown",
        container: symbol.containerName || undefined,
        file: docs.file(symbol.location.uri),
        ...("range" in symbol.location
          ? {
              line: symbol.location.range.start.line + 1,
              column: symbol.location.range.start.character + 1,
            }
          : {}),
      }),
    );
  },
);

export const diagnostics = Effect.fn("Editor.diagnostics")(function* ({
  file,
  severity = "hint",
}: Model.DiagnosticsQuery) {
  const docs = yield* Documents;
  const diags = yield* Diagnostics;
  const present =
    (uri: string) =>
    (d: Diagnostic): Model.Diagnostic => ({
      file: docs.file(uri),
      ...range(d.range),
      severity: severities[(d.severity ?? 1) - 1] ?? "error",
      code: d.code === undefined ? undefined : String(d.code),
      source: d.source,
      message: markup(d.message),
      related: d.relatedInformation?.map((r) => ({
        file: docs.file(r.location.uri),
        line: r.location.range.start.line + 1,
        column: r.location.range.start.character + 1,
        message: r.message,
      })),
    });
  const items =
    file === undefined
      ? (yield* diags.all).flatMap((p) => p.diagnostics.map(present(p.uri)))
      : yield* docs
          .open(file)
          .pipe(
            Effect.flatMap((doc) =>
              Effect.map(diags.forDocument(doc), (ds) =>
                ds.map(present(doc.uri)),
              ),
            ),
          );
  const threshold = severities.indexOf(severity);
  return items
    .filter((d) => severities.indexOf(d.severity) <= threshold)
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
    );
});

export const completions = Effect.fn("Editor.completions")(function* ({
  prefix,
  limit = 20,
  ...where
}: Model.Completions) {
  const lsp = yield* LanguageServer;
  const { textDocument, position } = yield* locate(where);
  const result = yield* lsp.request(CompletionRequest.type, {
    textDocument,
    position,
    context: { triggerKind: CompletionTriggerKind.Invoked },
  });
  const items = Array.isArray(result) ? result : (result?.items ?? []);
  const lower = prefix?.toLowerCase();
  return items
    .filter(
      (item) =>
        lower === undefined ||
        (item.filterText ?? item.label).toLowerCase().startsWith(lower),
    )
    .sort((a, b) =>
      (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label),
    )
    .slice(0, limit)
    .map(
      (item): Model.Completion => ({
        label: item.label,
        kind: completionKinds[item.kind ?? 1] ?? "text",
        detail: item.detail,
        documentation:
          item.documentation === undefined
            ? undefined
            : markup(item.documentation),
      }),
    );
});

export const signatureHelp = Effect.fn("Editor.signatureHelp")(function* (
  where: Model.Where,
) {
  const lsp = yield* LanguageServer;
  const { textDocument, position } = yield* locate(where);
  const result = yield* lsp.request(SignatureHelpRequest.type, {
    textDocument,
    position,
  });
  return {
    active: result?.activeSignature ?? 0,
    signatures: (result?.signatures ?? []).map((s) => ({
      label: s.label,
      documentation:
        s.documentation === undefined ? undefined : markup(s.documentation),
      parameters: (s.parameters ?? []).map((p) =>
        typeof p.label === "string"
          ? p.label
          : s.label.slice(p.label[0], p.label[1]),
      ),
      activeParameter:
        s.activeParameter ?? result?.activeParameter ?? undefined,
    })),
  } satisfies Model.SignatureHelp;
});

export const rename = Effect.fn("Editor.rename")(function* ({
  newName,
  apply = false,
  ...where
}: Model.Rename) {
  const lsp = yield* LanguageServer;
  const { textDocument, position } = yield* locate(where);
  const edit = yield* lsp.request(RenameRequest.type, {
    textDocument,
    position,
    newName,
  });
  if (edit === null)
    return yield* new LspError({
      method: "rename",
      message: "nothing to rename at this position",
    });
  return yield* workspaceEdit(edit, apply);
});

const selection = Effect.fn("Editor.selection")(function* ({
  file,
  line,
  column,
  endLine,
  endColumn,
}: Model.Selection) {
  const docs = yield* Documents;
  const doc = yield* docs.open(file);
  const end = (endLine ?? line) - 1;
  const range: Range = {
    start: { line: line - 1, character: column === undefined ? 0 : column - 1 },
    end: {
      line: end,
      character:
        endColumn === undefined ? lineText(doc, end).length : endColumn - 1,
    },
  };
  return { doc, textDocument: { uri: doc.uri }, range };
});

const overlaps = (a: Range, b: Range) =>
  (a.start.line < b.end.line ||
    (a.start.line === b.end.line && a.start.character <= b.end.character)) &&
  (b.start.line < a.end.line ||
    (b.start.line === a.end.line && b.start.character <= a.end.character));

const codeActionsAt = Effect.fn("Editor.codeActionsAt")(function* ({
  kind,
  ...where
}: Model.CodeActions) {
  const lsp = yield* LanguageServer;
  const diags = yield* Diagnostics;
  const { doc, textDocument, range } = yield* selection(where);
  const diagnostics = (yield* diags.forDocument(doc)).filter((d) =>
    overlaps(d.range, range),
  );
  const actions = yield* lsp.request(CodeActionRequest.type, {
    textDocument,
    range,
    context: {
      diagnostics,
      triggerKind: CodeActionTriggerKind.Invoked,
      ...(kind === undefined ? {} : { only: [kind] }),
    },
  });
  return actions ?? [];
});

export const codeActions = Effect.fn("Editor.codeActions")(function* (
  params: Model.CodeActions,
) {
  return (yield* codeActionsAt(params)).map(
    (action): Model.CodeAction => ({
      title: action.title,
      kind: CodeAction.is(action) ? action.kind : undefined,
      preferred: CodeAction.is(action) && action.isPreferred === true,
      fixes: CodeAction.is(action)
        ? (action.diagnostics ?? []).map((d) => markup(d.message))
        : [],
    }),
  );
});

export const applyCodeAction = Effect.fn("Editor.applyCodeAction")(function* ({
  title,
  ...params
}: Model.ApplyCodeAction) {
  const lsp = yield* LanguageServer;
  const action = (yield* codeActionsAt(params)).find((a) => a.title === title);
  if (action === undefined)
    return yield* new LspError({
      method: "codeAction",
      message: `no code action titled "${title}"`,
    });
  const execute = (command: Command) =>
    lsp
      .request(ExecuteCommandRequest.type, {
        command: command.command,
        ...(command.arguments && { arguments: command.arguments }),
      })
      .pipe(Effect.as(`command ${command.command}`));
  if (!CodeAction.is(action)) {
    return {
      applied: true,
      files: [],
      operations: [yield* execute(action)],
    } satisfies Model.WorkspaceEdit;
  }
  const resolved =
    action.edit === undefined &&
    action.command === undefined &&
    lsp.capabilities.codeActionProvider
      ? yield* lsp.request(CodeActionResolveRequest.type, action)
      : action;
  const result = yield* workspaceEdit(resolved.edit ?? {}, true);
  const operations = resolved.command
    ? [...result.operations, yield* execute(resolved.command)]
    : result.operations;
  return { ...result, operations };
});

export const format = Effect.fn("Editor.format")(function* ({
  file,
  tabSize = 4,
  insertSpaces = true,
  apply = false,
}: Model.Format) {
  const lsp = yield* LanguageServer;
  const docs = yield* Documents;
  const doc = yield* docs.open(file);
  const edits =
    (yield* lsp.request(DocumentFormattingRequest.type, {
      textDocument: { uri: doc.uri },
      options: { tabSize, insertSpaces },
    })) ?? [];
  if (apply && edits.length > 0)
    yield* docs.write(doc.uri, TextDocument.applyEdits(doc, edits));
  return {
    applied: apply,
    files: [
      {
        file: docs.file(doc.uri),
        edits: edits.map((e) => ({ ...range(e.range), newText: e.newText })),
      },
    ],
    operations: [],
  } satisfies Model.WorkspaceEdit;
});

export const callHierarchy = Effect.fn("Editor.callHierarchy")(function* ({
  direction = "incoming",
  ...where
}: Model.CallHierarchy) {
  const lsp = yield* LanguageServer;
  const docs = yield* Documents;
  const { textDocument, position } = yield* locate(where);
  const item = (yield* lsp.request(CallHierarchyPrepareRequest.type, {
    textDocument,
    position,
  }))?.[0];
  if (item === undefined) return [];
  const calls =
    direction === "incoming"
      ? (
          (yield* lsp.request(CallHierarchyIncomingCallsRequest.type, {
            item,
          })) ?? []
        ).map((c) => ({ item: c.from, sites: c.fromRanges }))
      : (
          (yield* lsp.request(CallHierarchyOutgoingCallsRequest.type, {
            item,
          })) ?? []
        ).map((c) => ({ item: c.to, sites: c.fromRanges }));
  return calls.map(
    ({ item, sites }): Model.Call => ({
      name: item.name,
      kind: symbolKinds[item.kind] ?? "unknown",
      detail: item.detail,
      file: docs.file(item.uri),
      line: item.selectionRange.start.line + 1,
      column: item.selectionRange.start.character + 1,
      sites: sites.map((r) => ({
        line: r.start.line + 1,
        column: r.start.character + 1,
      })),
    }),
  );
});
