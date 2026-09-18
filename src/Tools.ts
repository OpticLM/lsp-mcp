/**
 * The MCP tools: one per editor operation, described for agents. Tools whose
 * capability the connected language server lacks are not offered.
 */
import { Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type { ServerCapabilities } from "vscode-languageserver-protocol";
import { Diagnostics } from "./lsp/Diagnostics.ts";
import { DocumentError, Documents } from "./lsp/Documents.ts";
import * as Editor from "./lsp/Editor.ts";
import { LanguageServer, LspError } from "./lsp/LanguageServer.ts";
import * as Model from "./Model.ts";

const Failure = Schema.Union([LspError, DocumentError]);

const define = <
  const Name extends string,
  Parameters extends Schema.Constraint,
  Success extends Schema.Constraint,
>(
  name: Name,
  options: {
    readonly description: string;
    readonly parameters: Parameters;
    readonly success: Success;
    readonly mutates?: boolean;
  },
) =>
  Tool.make(name, {
    description: options.description,
    parameters: options.parameters,
    success: options.success,
    failure: Failure,
    dependencies: [LanguageServer, Documents, Diagnostics],
  })
    .annotate(Tool.Readonly, !options.mutates)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, !options.mutates)
    .annotate(Tool.OpenWorld, false);

const positions =
  "Positions are 1-based lines and columns; instead of a column you may name the `symbol` on that line to point at.";
const preview =
  "Without `apply` the edits are only previewed; with `apply: true` they are written to disk.";

export const Tools = Toolkit.make(
  define("hover", {
    description: `Type signature and documentation of the symbol at a position, as an editor shows on hover. ${positions}`,
    parameters: Model.Where,
    success: Schema.NullOr(Model.Hover),
  }),
  define("definition", {
    description: `Where the symbol at a position is defined (or its type definition, implementations, or declaration). Returns locations with a preview of each target line. ${positions}`,
    parameters: Model.Goto,
    success: Schema.Array(Model.Location),
  }),
  define("references", {
    description: `Every place the symbol at a position is used across the workspace, with a preview of each line. ${positions}`,
    parameters: Model.References,
    success: Schema.Array(Model.Location),
  }),
  define("document_symbols", {
    description:
      "Outline of a file: its functions, classes, methods, variables and so on, with their ranges, as a tree.",
    parameters: Schema.Struct({ file: Model.File }),
    success: Schema.Array(Model.DocumentSymbol),
  }),
  define("workspace_symbols", {
    description:
      "Find symbols by name across the whole workspace, including files you have not opened.",
    parameters: Model.WorkspaceQuery,
    success: Schema.Array(Model.WorkspaceSymbol),
  }),
  define("diagnostics", {
    description:
      "Errors, warnings and hints from the language server. Files are re-read from disk first, so call this right after editing to check your changes. Without `file`, returns everything reported so far.",
    parameters: Model.DiagnosticsQuery,
    success: Schema.Array(Model.Diagnostic),
  }),
  define("completions", {
    description: `Completion items at a position: discover members, imports, or valid identifiers the server suggests. ${positions}`,
    parameters: Model.Completions,
    success: Schema.Array(Model.Completion),
  }),
  define("signature_help", {
    description: `Signatures and parameters of the call surrounding a position. ${positions}`,
    parameters: Model.Where,
    success: Model.SignatureHelp,
  }),
  define("rename", {
    description: `Rename the symbol at a position everywhere it is referenced, across files. ${positions} ${preview}`,
    parameters: Model.Rename,
    success: Model.WorkspaceEdit,
    mutates: true,
  }),
  define("code_actions", {
    description:
      "Quick fixes and refactorings the server offers for a selection (whole lines unless columns are given), including fixes for the diagnostics there. Apply one with apply_code_action.",
    parameters: Model.CodeActions,
    success: Schema.Array(Model.CodeAction),
  }),
  define("apply_code_action", {
    description:
      "Apply a code action by title, for the same selection given to code_actions. Edits are written to disk.",
    parameters: Model.ApplyCodeAction,
    success: Model.WorkspaceEdit,
    mutates: true,
  }),
  define("format", {
    description: `Format a whole file with the language server's formatter. ${preview}`,
    parameters: Model.Format,
    success: Model.WorkspaceEdit,
    mutates: true,
  }),
  define("call_hierarchy", {
    description: `Callers of the function at a position (incoming) or the functions it calls (outgoing). ${positions}`,
    parameters: Model.CallHierarchy,
    success: Schema.Array(Model.Call),
  }),
);

export const layer = Tools.toLayer({
  hover: Editor.hover,
  definition: Editor.definition,
  references: Editor.references,
  document_symbols: Editor.documentSymbols,
  workspace_symbols: Editor.workspaceSymbols,
  diagnostics: Editor.diagnostics,
  completions: Editor.completions,
  signature_help: Editor.signatureHelp,
  rename: Editor.rename,
  code_actions: Editor.codeActions,
  apply_code_action: Editor.applyCodeAction,
  format: Editor.format,
  call_hierarchy: Editor.callHierarchy,
});

const requirements: Record<
  keyof typeof Tools.tools,
  (c: ServerCapabilities) => unknown
> = {
  hover: (c) => c.hoverProvider,
  definition: (c) =>
    c.definitionProvider ??
    c.typeDefinitionProvider ??
    c.implementationProvider ??
    c.declarationProvider,
  references: (c) => c.referencesProvider,
  document_symbols: (c) => c.documentSymbolProvider,
  workspace_symbols: (c) => c.workspaceSymbolProvider,
  diagnostics: () => true,
  completions: (c) => c.completionProvider,
  signature_help: (c) => c.signatureHelpProvider,
  rename: (c) => c.renameProvider,
  code_actions: (c) => c.codeActionProvider,
  apply_code_action: (c) => c.codeActionProvider,
  format: (c) => c.documentFormattingProvider,
  call_hierarchy: (c) => c.callHierarchyProvider,
};

/** The subset of `Tools` the server can serve; handled by the same `layer`. */
export const supportedBy = (capabilities: ServerCapabilities): typeof Tools =>
  Toolkit.make(
    ...Object.values(Tools.tools).filter((tool) =>
      requirements[tool.name](capabilities),
    ),
  ) as typeof Tools;
