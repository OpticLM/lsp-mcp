# lsp-mcp

An MCP server that exposes one Language Server to agents as a headless editor.
Effect 4 (`effect/unstable/ai` for MCP, `effect/unstable/cli` for the CLI) plus
`vscode-languageserver-protocol` for LSP. TypeScript runs directly on Node 26
(type stripping); there is no build step.

## Commands

- `pnpm tsc` — type-check (tsgo with the Effect language-service plugin)
- `pnpm test` — vitest; integration tests spawn `test/fixtures/server.ts`, a real LSP server
- `pnpm biome check --write --unsafe` — lint/format (run before committing; its rewrites are safe)
- `node src/main.ts --help` — the CLI; smoke-test with `node src/main.ts --root <dir> -- <server> [args]`
- Commit with `jj commit -m "..."`, never `git`

The shell may have an HTTP proxy configured; when curling the `--http` transport locally, pass `--noproxy '*'`.

## Layout

```
src/Model.ts          agent-facing Schemas (1-based positions); drives tool input/output schemas
src/Tools.ts          Toolkit definition + handlers wiring + capability gating (supportedBy)
src/Resources.ts      MCP resources (lsp://server, lsp://diagnostics[/{file}]) and notifications
src/Server.ts         layer composition: LanguageServer → Documents+Diagnostics → transport → tools/resources
src/main.ts           CLI entry (Command/Flag/Argument), logs to stderr, NodeRuntime.runMain
src/lsp/              the ONLY place vscode-* packages are used at runtime
  LanguageServer.ts   spawn + JSON-RPC + initialize/shutdown; request() waits for $/progress idle and retries ContentModified
  Documents.ts        on-demand didOpen, LRU via ScopedCache, disk change detection → didChange+didSave, applyEdit
  Diagnostics.ts      publishDiagnostics accumulation; pull (textDocument/diagnostic) or settled push per doc version
  Editor.ts           the operations = MCP tool handlers; LSP results → Model values
test/fixtures/server.ts   fixture language server (hover/definition/references/rename/symbols/TODO diagnostics)
test/fixtures/workspace.ts temp workspace layer running the fixture server
```

Rule: outside `src/lsp/`, `vscode-*` may only be imported as types.

## Design decisions worth knowing

- Positions handed to agents are 1-based; `Where` accepts `column` or a `symbol` name to find on the line.
- Client capabilities are deliberately narrow (no dynamic registration, no watched files, UTF-16 only) so
  servers fall back to their own file watching. Settings come from `--settings` via `workspace/configuration`.
- Tools are registered after LSP `initialize` so unsupported ones are never offered
  (`Tools.supportedBy`). `diagnostics` is always offered.
- Tool failures are `LspError | DocumentError` (declared `failure` schema), so their messages reach the agent.
- Optional fields in `Model` use a local `optional` helper that omits the key when encoding, because MCP
  `structuredContent` must be JSON (no `undefined`).
- Diagnostics waiting: pull if the server supports it; otherwise wait for a publish for the doc's version
  plus a 250ms quiet period, bounded by 5s, memoized per (uri, version).
- Tests that talk to the fixture server use `it.layer(..., { excludeTestServices: true })` so the real
  clock is used (Stream.debounce / timeouts would hang under TestClock).

## Status

Complete for the first release: 13 tools, 2 resources + 1 template, stdio and HTTP transports,
verified against the fixture server and `typescript-language-server`.

Ideas not done: inlay hints, type hierarchy, semantic tokens, partial results, workspace/didChangeWatchedFiles
when a server insists on it, restarting a crashed language server (currently requests fail with a clear
`LspError` until the MCP client restarts the process).
