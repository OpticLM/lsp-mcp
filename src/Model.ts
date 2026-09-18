/**
 * The agent-facing vocabulary of the server.
 *
 * Everything an agent sends or receives is described here as `Schema`, so the
 * same definitions drive MCP tool input/output schemas and the values the
 * `lsp/` bridge produces. Positions are 1-based (line and column), the way
 * agents and editors display them; the bridge converts to LSP's 0-based form.
 */
import { Option, Predicate, Schema, SchemaGetter } from "effect";

/** An optional field whose key is omitted, rather than set to `undefined`, in JSON output. */
const optional = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema).pipe(
    Schema.encodeTo(Schema.optionalKey(schema), {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.transformOptional(
        Option.filter(Predicate.isNotUndefined),
      ),
    }),
  );

const positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const File = Schema.String.annotate({
  description: "File path, absolute or relative to the workspace root",
});
export const Line = positive.annotate({ description: "1-based line number" });
export const Column = positive.annotate({
  description:
    "1-based column, counted in UTF-16 code units (plain characters for ASCII)",
});

export const Where = Schema.Struct({
  file: File,
  line: Line,
  column: optional(
    positive.annotate({
      description:
        "1-based column. Omit to place the cursor on `symbol`, or on the first non-blank character of the line",
    }),
  ),
  symbol: optional(
    Schema.String.annotate({
      description:
        "Identifier on the line to place the cursor at; used when `column` is omitted",
    }),
  ),
});
export type Where = typeof Where.Type;

export const Range = Schema.Struct({
  line: Line,
  column: Column,
  endLine: Line,
  endColumn: Column,
});
export type Range = typeof Range.Type;

export const Location = Schema.Struct({
  file: Schema.String,
  ...Range.fields,
  preview: Schema.String.annotate({
    description: "Trimmed source text of the starting line",
  }),
});
export type Location = typeof Location.Type;

export const Hover = Schema.Struct({
  contents: Schema.String.annotate({ description: "Markdown" }),
  range: optional(Range),
});
export type Hover = typeof Hover.Type;

export const GotoKind = Schema.Literals([
  "definition",
  "typeDefinition",
  "implementation",
  "declaration",
]);
export const Goto = Schema.Struct({
  ...Where.fields,
  kind: optional(
    GotoKind.annotate({
      description: "What to navigate to (default: definition)",
    }),
  ),
});
export type Goto = typeof Goto.Type;

export const References = Schema.Struct({
  ...Where.fields,
  includeDeclaration: optional(
    Schema.Boolean.annotate({ description: "Default: true" }),
  ),
});
export type References = typeof References.Type;

export interface DocumentSymbol extends Range {
  readonly name: string;
  readonly kind: string;
  readonly detail?: string | undefined;
  readonly container?: string | undefined;
  readonly children?: ReadonlyArray<DocumentSymbol> | undefined;
}
export const DocumentSymbol: Schema.Codec<DocumentSymbol> = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  detail: optional(Schema.String),
  container: optional(Schema.String),
  ...Range.fields,
  children: optional(
    Schema.Array(
      Schema.suspend((): Schema.Codec<DocumentSymbol> => DocumentSymbol),
    ),
  ),
});

export const WorkspaceSymbol = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  container: optional(Schema.String),
  file: Schema.String,
  line: optional(Line),
  column: optional(Column),
});
export type WorkspaceSymbol = typeof WorkspaceSymbol.Type;

export const WorkspaceQuery = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Symbol name or fragment; matching is fuzzy and server-defined",
  }),
  limit: optional(positive.annotate({ description: "Default: 50" })),
});
export type WorkspaceQuery = typeof WorkspaceQuery.Type;

export const Severity = Schema.Literals([
  "error",
  "warning",
  "information",
  "hint",
]);
export type Severity = typeof Severity.Type;

export const Diagnostic = Schema.Struct({
  file: Schema.String,
  ...Range.fields,
  severity: Severity,
  code: optional(Schema.String),
  source: optional(Schema.String),
  message: Schema.String,
  related: optional(
    Schema.Array(
      Schema.Struct({
        file: Schema.String,
        line: Line,
        column: Column,
        message: Schema.String,
      }),
    ),
  ),
});
export type Diagnostic = typeof Diagnostic.Type;

export const DiagnosticsQuery = Schema.Struct({
  file: optional(
    File.annotate({
      description:
        "Restrict to one file; omit for every file the server has reported on",
    }),
  ),
  severity: optional(
    Severity.annotate({
      description:
        "Least severe level to include (default: hint, i.e. everything)",
    }),
  ),
});
export type DiagnosticsQuery = typeof DiagnosticsQuery.Type;

export const Completions = Schema.Struct({
  ...Where.fields,
  prefix: optional(
    Schema.String.annotate({
      description: "Keep only items whose label starts with this",
    }),
  ),
  limit: optional(positive.annotate({ description: "Default: 20" })),
});
export type Completions = typeof Completions.Type;

export const Completion = Schema.Struct({
  label: Schema.String,
  kind: Schema.String,
  detail: optional(Schema.String),
  documentation: optional(Schema.String),
});
export type Completion = typeof Completion.Type;

export const Signature = Schema.Struct({
  label: Schema.String,
  documentation: optional(Schema.String),
  parameters: Schema.Array(Schema.String),
  activeParameter: optional(Schema.Int),
});
export const SignatureHelp = Schema.Struct({
  signatures: Schema.Array(Signature),
  active: Schema.Int,
});
export type SignatureHelp = typeof SignatureHelp.Type;

export const TextEdit = Schema.Struct({
  ...Range.fields,
  newText: Schema.String,
});
export const FileEdits = Schema.Struct({
  file: Schema.String,
  edits: Schema.Array(TextEdit),
});
export const WorkspaceEdit = Schema.Struct({
  applied: Schema.Boolean.annotate({
    description: "Whether the edits were written to disk",
  }),
  files: Schema.Array(FileEdits),
  operations: Schema.Array(Schema.String).annotate({
    description: "File creations, renames, deletions and executed commands",
  }),
});
export type WorkspaceEdit = typeof WorkspaceEdit.Type;

const apply = optional(
  Schema.Boolean.annotate({
    description:
      "Write the resulting edits to disk (default: false, preview only)",
  }),
);

export const Rename = Schema.Struct({
  ...Where.fields,
  newName: Schema.String,
  apply,
});
export type Rename = typeof Rename.Type;

export const Selection = Schema.Struct({
  file: File,
  line: Line,
  column: optional(Column.annotate({ description: "Default: start of line" })),
  endLine: optional(Line.annotate({ description: "Default: same as line" })),
  endColumn: optional(
    Column.annotate({ description: "Default: end of endLine" }),
  ),
});
export type Selection = typeof Selection.Type;

export const CodeActions = Schema.Struct({
  ...Selection.fields,
  kind: optional(
    Schema.String.annotate({
      description:
        "Only actions of this kind prefix, e.g. quickfix, refactor, refactor.extract, source.organizeImports",
    }),
  ),
});
export type CodeActions = typeof CodeActions.Type;

export const CodeAction = Schema.Struct({
  title: Schema.String,
  kind: optional(Schema.String),
  preferred: Schema.Boolean,
  fixes: Schema.Array(Schema.String).annotate({
    description: "Messages of the diagnostics this action addresses",
  }),
});
export type CodeAction = typeof CodeAction.Type;

export const ApplyCodeAction = Schema.Struct({
  ...CodeActions.fields,
  title: Schema.String.annotate({
    description:
      "Exact title of an action returned by code_actions for the same selection",
  }),
});
export type ApplyCodeAction = typeof ApplyCodeAction.Type;

export const Format = Schema.Struct({
  file: File,
  tabSize: optional(positive.annotate({ description: "Default: 4" })),
  insertSpaces: optional(
    Schema.Boolean.annotate({ description: "Default: true" }),
  ),
  apply,
});
export type Format = typeof Format.Type;

export const CallDirection = Schema.Literals(["incoming", "outgoing"]);
export const CallHierarchy = Schema.Struct({
  ...Where.fields,
  direction: optional(
    CallDirection.annotate({
      description:
        "incoming: who calls this; outgoing: what this calls (default: incoming)",
    }),
  ),
});
export type CallHierarchy = typeof CallHierarchy.Type;

export const Call = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  detail: optional(Schema.String),
  file: Schema.String,
  line: Line,
  column: Column,
  sites: Schema.Array(Schema.Struct({ line: Line, column: Column })).annotate({
    description: "Call sites, located in the caller's file",
  }),
});
export type Call = typeof Call.Type;
