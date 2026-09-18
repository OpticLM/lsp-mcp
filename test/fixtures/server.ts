/**
 * A miniature language server used by the tests. Words are symbols: hover
 * describes the word under the cursor, definition is its first occurrence,
 * references and rename cover every occurrence, and each line containing
 * "TODO" yields a warning. `fixture/state` reports open/close counts.
 */
import {
  createConnection,
  DiagnosticSeverity,
  type Position,
  TextDocumentSyncKind,
  TextDocuments,
  WorkDoneProgress,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

const connection = createConnection(process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let closes = 0;
let progressToken = 0;

const wordAt = (doc: TextDocument, position: Position) => {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  let start = offset;
  let end = offset;
  while (start > 0 && /\w/.test(text.charAt(start - 1))) start--;
  while (end < text.length && /\w/.test(text.charAt(end))) end++;
  return start === end ? undefined : text.slice(start, end);
};

const occurrences = (doc: TextDocument, word: string) => {
  const text = doc.getText();
  const ranges = [];
  const pattern = new RegExp(`\\b${word}\\b`, "g");
  for (const match of text.matchAll(pattern)) {
    ranges.push({
      start: doc.positionAt(match.index),
      end: doc.positionAt(match.index + word.length),
    });
  }
  return ranges;
};

documents.onDidClose(() => closes++);
documents.onDidChangeContent(({ document }) => {
  const diagnostics = document
    .getText()
    .split("\n")
    .flatMap((line, i) =>
      line.includes("TODO")
        ? [
            {
              range: {
                start: { line: i, character: 0 },
                end: { line: i, character: line.length },
              },
              severity: DiagnosticSeverity.Warning,
              message: "unresolved TODO",
              source: "fixture",
            },
          ]
        : [],
    );
  void connection.sendDiagnostics({
    uri: document.uri,
    version: document.version,
    diagnostics,
  });
});

connection.onInitialize(() => ({
  serverInfo: { name: "fixture", version: "1.0.0" },
  capabilities: {
    textDocumentSync: {
      openClose: true,
      change: TextDocumentSyncKind.Full,
      save: { includeText: true },
    },
    hoverProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    renameProvider: true,
    documentSymbolProvider: true,
  },
}));

connection.onHover(({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  const word = doc && wordAt(doc, position);
  return word
    ? { contents: { kind: "markdown", value: `word **${word}**` } }
    : null;
});

connection.onDefinition(({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  const word = doc && wordAt(doc, position);
  const range = word && occurrences(doc, word)[0];
  return range ? { uri: textDocument.uri, range } : null;
});

connection.onReferences(({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  const word = doc && wordAt(doc, position);
  return word
    ? occurrences(doc, word).map((range) => ({ uri: textDocument.uri, range }))
    : [];
});

connection.onRenameRequest(({ textDocument, position, newName }) => {
  const doc = documents.get(textDocument.uri);
  const word = doc && wordAt(doc, position);
  if (!word) return null;
  return {
    documentChanges: [
      {
        textDocument: { uri: textDocument.uri, version: doc.version },
        edits: occurrences(doc, word).map((range) => ({
          range,
          newText: newName,
        })),
      },
    ],
  };
});

connection.onDocumentSymbol(({ textDocument }) => {
  const doc = documents.get(textDocument.uri);
  if (!doc) return [];
  const words = new Set(doc.getText().match(/\b[A-Za-z_]\w*\b/g) ?? []);
  return [...words].flatMap((name) =>
    occurrences(doc, name)
      .slice(0, 1)
      .map((range) => ({ name, kind: 13, range, selectionRange: range })),
  );
});

connection.onRequest("fixture/state", () => ({
  open: documents.all().length,
  closes,
}));
connection.onRequest("fixture/progress", async (ms: number) => {
  const token = `work-${progressToken++}`;
  void connection.sendProgress(WorkDoneProgress.type, token, {
    kind: "begin",
    title: "indexing",
  });
  setTimeout(
    () =>
      void connection.sendProgress(WorkDoneProgress.type, token, {
        kind: "end",
      }),
    ms,
  );
  return token;
});

documents.listen(connection);
connection.listen();
