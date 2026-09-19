# lsp-mcp

An MCP server that exposes one Language Server to agents as a headless editor.
Effect 4 (`effect/unstable/ai` for MCP, `effect/unstable/cli` for the CLI) plus
`vscode-languageserver-protocol` for LSP. TypeScript is bundled for Node 26 with
tsdown; source files can still run directly through Node's type stripping.

## Commands

- `pnpm tsc` — type-check (tsgo with the Effect language-service plugin)
- `pnpm build` — bundle the CLI to `dist/main.mjs` with tsdown
- `pnpm dev` — run the TypeScript source directly
- `pnpm test` — vitest; integration tests spawn `test/fixtures/server.ts`, a real LSP server
- `pnpm biome check --write --unsafe` — lint/format (run before committing; its rewrites are safe)
- `node dist/main.mjs --help` — the built CLI; smoke-test with `node dist/main.mjs --root <dir> -- <server> [args]`
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
  LanguageServer.ts   spawn + JSON-RPC + initialize/shutdown, supervised: restarts on crash per policy, reopens documents
                      request() waits for $/progress idle and retries ContentModified / a server that is being restarted
  Documents.ts        on-demand didOpen, LRU via ScopedCache, disk change detection → didChange+didSave, applyEdit
  Diagnostics.ts      publishDiagnostics accumulation; pull (textDocument/diagnostic) or settled push per doc version
  Editor.ts           the operations = MCP tool handlers; LSP results → Model values
test/fixtures/server.ts   fixture language server (hover/definition/references/rename/symbols/TODO diagnostics)
test/fixtures/workspace.ts temp workspace layer running the fixture server
```

Rule: outside `src/lsp/`, `vscode-*` may only be imported as types.

`EFFECT.md` lists the Effect 4 API shapes already verified against `repos/effect` (renames from Effect 3, Schedule,
CLI, MCP, vitest). Read it before grepping the Effect source, and add to it when you verify something new.

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
- Crashes: `--restart never|always|N` (default 3). A crash is the process exiting or closing the connection after a
  successful initialize; a server that cannot initialize fails lsp-mcp immediately. Restarts back off from 500ms to 30s,
  a crash more than a minute after the previous one starts a new streak, and the streak limit `N` ends restarting for good.
  Requests in flight during a crash wait for the new process and retry; documents are re-`didOpen`ed with their current
  text; the capabilities and tool set stay those of the first process. Each restart and the final give-up are logged and
  sent to the MCP client as `notifications/message`. Once given up, every tool call fails with an `LspError` that says so.

## Status

Complete for the first release: 13 tools, 2 resources + 1 template, stdio and HTTP transports,
verified against the fixture server and `typescript-language-server`.

Ideas not done: inlay hints, type hierarchy, semantic tokens, partial results, workspace/didChangeWatchedFiles
when a server insists on it.
