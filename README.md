# lsp-mcp

```sh
npx -y @opticlm/lsp-mcp
```

An [MCP](https://modelcontextprotocol.io/) server that exposes a single [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) server to agents as a headless editor.

`lsp-mcp` starts the language server you provide, keeps its document state in sync with the workspace, and exposes the language server's capabilities through MCP tools and resources. It is written in TypeScript and [Effect](https://effect.website).

## Features

- stdio and Streamable HTTP MCP transports
- Diagnostics exposed both as a tool and subscribable MCP resources
- Preview-by-default edits for rename and formatting, with explicit disk application
- Language-server crash supervision, restart backoff, and document reopening
- Initialization options, workspace settings, language-id mappings, and open-document capacity configuration

Underlying techniques:

- On-demand document opening, disk change detection, and an LRU cache of open documents
- 1-based line and column positions designed for agent-facing use
- Capability-aware tool registration: unsupported LSP features are not advertised

## Usage

The general form is:

```sh
npx -y @opticlm/lsp-mcp [lsp-mcp options] -- <language-server> [language-server args...]
```

The `--` separates `lsp-mcp` options from the executable and arguments passed to the language server.

### stdio

stdio is the default transport and is suitable for MCP clients that launch a local server process:

```sh
npx -y @opticlm/lsp-mcp --root /path/to/project -- typescript-language-server --stdio
```

For example, an MCP client configuration can point at the checkout like this:

```json
{
  "mcpServers": {
    "typescript": {
      "command": "npx",
      "args": [
        "-y",
        "@opticlm/lsp-mcp",
        "--root",
        "/path/to/project",
        "--",
        "typescript-language-server",
        "--stdio"
      ]
    }
  }
}
```

### Streamable HTTP

Run the MCP endpoint on a local port with `--http`:

```sh
npx -y @opticlm/lsp-mcp --http 9010 --root ./crate -- rust-analyzer
```

The endpoint is available at:

```text
http://localhost:9010/mcp
```

### Configuration examples

```sh
# Pass JSON initialization options to the language server.
npx -y @opticlm/lsp-mcp \
  --init-options '{"typescript":{"useInferredProjectPerProjectRoot":true}}' \
  -- typescript-language-server --stdio

# Serve workspace/configuration and didChangeConfiguration with JSON settings.
npx -y @opticlm/lsp-mcp \
  --settings '{"gopls":{"staticcheck":true}}' \
  -- gopls

# Add a file-extension to language-id mapping.
npx -y @opticlm/lsp-mcp --language vue=vue --root ./web -- vue-language-server --stdio

# Keep more documents open, and always restart a crashed language server.
npx -y @opticlm/lsp-mcp --open-documents 64 --restart always -- clangd
```

## Development

Requirements:

- Node.js 26+
- pnpm 12.4.2+

```sh
pnpm test   # Run the Vitest suite, including the fixture LSP integration tests
pnpm check  # Type-check without emitting JavaScript
pnpm lint   # Format and lint with Biome
```

The main source layout is:

```text
src/Model.ts      Agent-facing schemas and 1-based positions
src/Tools.ts      MCP tool definitions and capability gating
src/Resources.ts  MCP resources and notifications
src/Server.ts     Effect layer composition and transports
src/main.ts       CLI entry point
src/lsp/          LSP process, document, diagnostic, and editor bridge
test/             Unit and integration tests with a fixture language server
```

The `vscode-*` packages are intentionally confined to `src/lsp/`; the rest of the application uses the agent-facing schemas and Effect services.

## License

MIT
