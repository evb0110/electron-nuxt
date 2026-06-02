# EVB Viewer MCP Architecture

This document describes the current local MCP architecture for EVB Viewer so future threads can iterate without re-discovering the wiring.

## Current Shape

EVB Viewer exposes a local, desktop-only MCP server from the Electron main process. The server gives agents a live view of the workspace, including panes, tabs, the active document when one is present, page numbers, document readiness, searchable text coverage, PDF search, page text reads, and navigation commands.

There are two agent-facing entry points:

- **Embedded EVB Assistant**: EVB Viewer owns a sandboxed `codex app-server` child process, an isolated `CODEX_HOME`, and a private random-port MCP server protected by a bearer token. This powers the in-app assistant panel, works with empty workspaces as well as open documents, uses the system browser for ChatGPT sign-in, and does not mutate global Codex configuration.
- **External MCP Server**: the advanced Settings switch starts the fixed-port MCP server and registers it in global Codex settings using the Codex CLI. The same HTTP server URL can be configured manually in other MCP clients such as Claude Code or Cursor.

The embedded assistant panel has its own normal app preference, separate from the external MCP switch. Disabling the in-app assistant hides the sidebar and launcher only; it does not start, stop, or register the external MCP server.

When the external switch is enabled, EVB Viewer starts the local MCP server and registers it in global Codex settings using the Codex CLI. When disabled, EVB Viewer removes the Codex MCP entry and shuts the local server down. Other clients use the same local URL while EVB Viewer is running and external MCP is enabled.

```mermaid
flowchart LR
    User["User toggles External MCP in Settings"] --> Renderer["Settings UI"]
    Renderer --> Preload["preload agent API"]
    Preload --> MainIPC["Electron IPC"]
    MainIPC --> CodexIntegration["codexMcpIntegration.ts"]
    CodexIntegration --> LocalServer["mcpServer.ts on 127.0.0.1"]
    CodexIntegration --> CodexCLI["codex mcp add/remove"]
    Codex["Codex / Claude Code / Cursor"] --> LocalServer
    LocalServer --> WorkspaceBridge["workspaceBridge.ts"]
    WorkspaceBridge --> AppShell["useAgentWorkspaceSnapshot.ts"]
    AppShell --> WorkspaceExpose["Document workspace expose API"]
    LocalServer --> SearchIndex["documentText.ts / search worker"]
```

The embedded assistant uses the same MCP tool implementation, but through a separate random-port listener:

```mermaid
flowchart LR
    User["User opens EVB Assistant panel"] --> Renderer["Assistant UI"]
    Renderer --> AssistantIPC["typed assistant IPC"]
    AssistantIPC --> Runtime["codexAssistant.ts"]
    Runtime --> AppServer["codex app-server child process"]
    Runtime --> PrivateMcp["private MCP server on 127.0.0.1:random with bearer token"]
    AppServer --> PrivateMcp
    PrivateMcp --> WorkspaceBridge
```

## File Map

- `electron/features/agent/mcpServer.ts`
  Local HTTP JSON-RPC MCP server, tool/resource/prompt definitions, server identity, port selection, and request dispatch.

- `electron/features/agent/codexMcpIntegration.ts`
  End-user Codex integration: Codex CLI discovery, native permission dialogs, global Codex config mutation, status reporting, and startup sync with app settings.

- `electron/features/agent/codexAssistant.ts`
  Embedded assistant runtime: EVB-managed Codex install/login/status flow, isolated app-server process, assistant chat thread lifecycle, and renderer-safe event streaming.

- `electron/features/agent/codexCli.ts`
  Shared cross-platform Codex discovery, version checks, managed install directory, and official standalone installer execution.

- `electron/features/agent/workspaceBridge.ts`
  Main-to-renderer request bridge for workspace snapshots and UI navigation commands. Uses request ids, sender-window validation, and timeouts.

- `electron/features/agent/documentText.ts`
  Main-process document text operations backed by the existing PDF search worker and search indexes.

- `electron/features/search/public.ts`
  Public feature entrypoint used by the agent feature for search worker path resolution, allowed PDF path resolution, and `SearchWorkerService`.

- `app/modules/workspace-shell/composables/useAgentWorkspaceSnapshot.ts`
  Renderer-side snapshot builder and command handler. It sees panes, tabs, layout, workspace refs, toolbar snapshots, and navigation APIs.

- `packages/contracts/agent.ts`
  Shared agent/MCP contracts for snapshots, commands, readiness, Codex integration status, and update results.

- `packages/contracts/electronApiAgent.ts`
  Platform capability for agent IPC: request subscriptions, response submission, MCP status, MCP toggle, and embedded assistant lifecycle methods.

- `app/components/settings/SettingsAgentPanel.vue`
  Desktop settings panel with separate in-app assistant visibility and external MCP status/setup controls.

- `app/components/agent/AgentAssistantPanel.vue`
  Desktop assistant panel with Codex install/update, ChatGPT sign-in, workspace/document empty states, and chat composer.

- `scripts/evb-mcp-proxy.mjs`
  Compatibility stdio proxy for development/manual MCP clients. It mirrors the MCP descriptors and forwards JSON-RPC to the local HTTP endpoint.

- Tests:
  `tests/unit/electron/agentMcpServer.test.ts`,
  `tests/unit/electron/agentMcpProxy.test.ts`,
  `tests/unit/app/modules/workspace-shell/composables/useAgentWorkspaceSnapshot.test.ts`,
  plus settings tests for persisted agent preferences.

## Server Identity And Ports

The server binds to loopback only:

- Host: `127.0.0.1`
- Packaged app: server name `evb_viewer`, default port `38671`
- Dev app: server name `evb_viewer_dev`, default port `38672`
- Port override: `EVB_MCP_PORT`

The identity is derived in `createLocalMcpServerIdentity()` from Electron `app.isPackaged`, `app.getName()`, `app.getVersion()`, and `app.getPath('userData')`.

The `/health` endpoint returns identity plus available tools, resources, and prompts. MCP JSON-RPC requests are accepted by `POST` to the same HTTP server.

## Settings, Assistant Visibility, And Codex Registration

The persisted settings are:

- `assistantPanelEnabled`, defaulting to `true`. This is a normal renderer-managed app preference. It only controls whether the embedded assistant sidebar and launcher are available.
- `agentMcpEnabled`, defaulting to `false`. This is managed by the Electron Codex MCP flow because toggling it starts/stops the external server and mutates global Codex configuration.

When the user enables MCP:

1. Renderer calls `getPlatformAPI().agent.setMcpIntegrationEnabled(true)`.
2. Preload invokes `agent:setMcpIntegrationEnabled`.
3. Main process calls `setAgentMcpIntegrationEnabled(true, parentWindow)`.
4. The app finds Codex by checking:
   - `CODEX_CLI_PATH`
   - `/Applications/Codex.app/Contents/Resources/codex` on macOS
   - each `PATH` entry
   - common user/system binary locations
   - `command -v codex` in the login shell on non-Windows hosts
5. If Codex is missing, a native dialog offers to open `https://developers.openai.com/codex/app`.
6. If Codex exists, EVB Viewer asks permission before mutating global Codex settings.
7. The local MCP server starts.
8. EVB Viewer runs:
   - `codex mcp remove <server-name>` as a best-effort cleanup
   - `codex mcp add <server-name> --url <server-url>`
9. `agentMcpEnabled` is saved as `true`.

When disabling, EVB Viewer asks permission, removes the Codex MCP entry, shuts down the local server, and saves `agentMcpEnabled` as `false`.

The current registration target is direct Streamable HTTP in Codex, not stdio:

```toml
[mcp_servers.evb_viewer_dev]
url = "http://127.0.0.1:38672"
```

Manual setup for common external clients uses the same server name and URL:

```bash
codex mcp add evb_viewer_dev --url http://127.0.0.1:38672
claude mcp add --transport http --scope user evb_viewer_dev http://127.0.0.1:38672
```

```json
{
  "mcpServers": {
    "evb_viewer_dev": {
      "url": "http://127.0.0.1:38672"
    }
  }
}
```

Renderer settings saves intentionally preserve `agentMcpEnabled` in `electron/ipc/registry.ts` so stale renderer settings snapshots cannot clobber a value managed by the Codex mutation flow. `assistantPanelEnabled` is allowed through normal settings saves because it has no external side effects.

## Startup And Shutdown

After `runInitSequence()` completes, `electron/main.ts` calls `syncAgentMcpServerWithSettings()`.

- If `agentMcpEnabled` is `true`, `startLocalMcpServer()` runs.
- If `false`, `shutdownLocalMcpServer()` is called.

Shutdown cleanup always includes `shutdownLocalMcpServer()` before updates, DjVu, OCR, and working-copy cleanup.

The old environment toggle `EVB_MCP_SERVER=1` is no longer used. `pnpm dev` starts the app normally; the Settings toggle controls whether MCP runs.

## MCP Protocol Surface

The server uses JSON-RPC 2.0 and reports protocol version `2025-11-25`.

Supported methods:

- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call`
- `resources/list`
- `resources/templates/list`
- `resources/read`
- `prompts/list`
- `prompts/get`

Batch JSON-RPC requests are supported. Request bodies are capped at 1 MiB. Responses are JSON with `Cache-Control: no-store`. Notifications get `202` when there is no response payload.

Initialize instructions explicitly tell agents to use EVB Viewer MCP tools before inspecting processes, files, windows, debug ports, or the repository when the user asks about EVB Viewer, the workspace, or the open document. A document may not be open, so agents should inspect the workspace before assuming document-specific context.

## Tools

| Tool | Purpose | Mutation |
| --- | --- | --- |
| `evb_workspace_snapshot` | Full live workspace: summary mode, panes, tabs, active ids, layout tree, document kind, page numbers, readiness, and recent-file list metadata. | Read-only |
| `evb_viewer_open_documents` | Fast answer for "what document is open?" including workspace mode, real open documents, active document, pane/tab mapping, and recent-file list metadata. Empty tabs are not reported as documents. | Read-only |
| `evb_document_readiness` | Preparation hints for all tabs or a selected tab. | Read-only |
| `evb_inspect_document_text` | Warm/reuse the search index and report searchable text coverage plus OCR recommendations. | Read-only |
| `evb_search_document` | Search text in a selected or active open PDF. | Read-only |
| `evb_viewer_search_open_document` | Same search surface with stronger naming for discovery by agents. | Read-only |
| `evb_read_document_pages` | Read extracted text for selected PDF pages from the search index. | Read-only |
| `evb_activate_tab` | Activate an existing tab by id. | UI navigation |
| `evb_go_to_page` | Activate a tab if needed and navigate to a one-based page number. | UI navigation |

Read-only tools set MCP annotations with `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. Navigation tools are non-destructive but not read-only.

## Resources And Prompts

Resources:

- `evb://workspace/current`
  JSON workspace snapshot.
- `evb://document/{tabId}/text-status`
  JSON searchable text coverage and OCR recommendations for an open PDF tab.
- `evb://document/{tabId}/page/{page}`
  Extracted searchable text for one PDF page.

Resource templates are exposed for page text and text status. `resources/list` also adds concrete text-status resources for currently open PDF tabs.

Prompts:

- `evb_find_in_current_pdf`
  Guides an agent to identify the active tab, search for topic variants, inspect candidate pages, and navigate only after choosing the best page.
- `evb_check_document_prep`
  Guides an agent to inspect readiness and recommend OCR or conversion when needed.

## Workspace Snapshot Model

The renderer builds `IAgentWorkspaceSnapshot` from the workspace shell:

- `capturedAt`
- `activePaneId`
- `activeTabId`
- `summary`
  - `mode`: `empty-workspace`, `open-document`, or `documents-open-no-active-document`
  - `activeDocument`
    - `tabId`
    - `paneId`
    - `fileName`
    - `originalPath`
    - `kind`
  - `documentCount`
  - `recentFileCount`
  - `recentFilesResolved`
- `panes`
  - `paneId`
  - `tabIds`
  - `activeTabId`
- `tabs`
  - `tabId`
  - `paneId`
  - `fileName`
  - `originalPath`
  - `isDirty`
  - `kind`: `empty`, `pdf`, `djvu`, `image`, or `unknown`
  - `workspaceAttached`
  - `hasPdf`
  - `isDjvu`
  - `isOpeningDocument`
  - `hasOpenError`
  - `currentPage`
  - `totalPages`
  - `readiness`
- `recentFiles`
  - `fileName`
  - `originalPath`
  - `kind`
  - `openedAt`
  - `fileSize`
- `layout`
  - cloned pane split tree

Only the word `pane` is used externally and internally for split editor containers. A pane can hold several tabs. A tab can be active in one pane.

The snapshot intentionally separates real open document tabs from empty workspace tabs. Empty tabs can still be attached to a workspace pane, but they keep `kind: empty`, `summary.documentCount: 0` when no documents are open, and `evb_viewer_open_documents` excludes them from `documents`.

Recent files are list metadata only. Agents may report filenames, kinds, and counts from this list, but must not infer or summarize file contents until the user opens a file and the relevant EVB document tools can inspect it.

Readiness is intentionally conservative:

- Empty tabs are `empty`.
- DjVu and image tabs recommend `convert_to_pdf`.
- PDF tabs initially report OCR coverage as `unknown` and recommend `ocr_all_pages` as a general preparation hint.
- Exact PDF text coverage comes from `evb_inspect_document_text`, which builds or reads the search index.

## Renderer Bridge And Commands

Main process requests are sent over trusted IPC event channels:

- `agent:workspaceSnapshotRequest`
- `agent:commandRequest`

Renderer responses use invoke channels:

- `agent:submitWorkspaceSnapshot`
- `agent:submitCommandResponse`

`workspaceBridge.ts` stores pending requests by random UUID, validates that the response comes from the same Electron window, and rejects after 2500 ms by default.

Renderer command support currently includes:

- `activate_tab`
  Activates a tab by finding its pane and calling the existing tab activation path.
- `go_to_page`
  Activates the target tab if needed, waits for its workspace expose API, then calls `handleGoToPage(page)`.

## Document Text And Search

`documentText.ts` reuses the existing search infrastructure rather than reading PDFs ad hoc:

1. Resolve the PDF path with `resolveSearchablePdfPath()`.
2. Use `SearchWorkerService` with `resolveSearchWorkerPath`.
3. Warm or query the search index.
4. Load the index with `loadSearchIndex()` for coverage and page text.

Important limits:

- Search defaults to 25 results and caps at 100.
- Page text defaults to 6000 characters per page and caps at 30000.
- Missing text page samples cap at 80 pages.

Only PDF tabs with readable paths can use search/page text tools. DjVu and image documents should be converted to PDF first.

## UI And Platform API

Settings UI:

- `SettingsContent.vue` renders `SettingsAgentPanel.vue` only in desktop runtime.
- The panel shows enabled/disabled/ready/missing/mismatched/error status.
- If Codex is missing, it offers an install action.
- If the setting is enabled but the server or Codex entry is not configured, the main action becomes repair.

Platform API:

- Desktop preload implements the agent capability through IPC.
- Browser runtime provides no-op agent methods and an unavailable MCP status so web builds remain type-compatible.
- Embedded assistant status includes a `turn` object with `phase` values (`idle`, `starting`, `running`, `interrupting`, `error`) so the UI can distinguish ready, still-working, and stopping states.
- `resetAssistantChat()` interrupts the active turn if needed, archives the previous Codex thread best-effort, clears local messages, and starts the next user message in a fresh ephemeral thread.

## Security And Safety Boundaries

- Server binds only to `127.0.0.1`.
- Codex config mutation requires a native user confirmation dialog.
- Codex CLI calls are spawned with fixed argument arrays, not shell command strings.
- Trusted IPC validation in `electron/ipc/registry.ts` rejects untrusted renderer URLs and non-main-frame senders.
- Renderer bridge responses are accepted only from the window that received the request.
- MCP tools are scoped to current EVB Viewer windows and open tabs.
- The embedded assistant MCP server uses a random loopback port and bearer token known only to the sandboxed Codex app-server process.
- The external fixed-port MCP server has no authentication on the loopback HTTP server today, so only enable it when local agent access is desired.

## Stdio Proxy

`scripts/evb-mcp-proxy.mjs` exists for development and MCP clients that need stdio. It is not the default end-user registration path.

Behavior:

- Resolves target URL from `EVB_MCP_URL` or `EVB_MCP_HOST`/`EVB_MCP_PORT`, defaulting to dev port `38672`.
- Accepts newline-delimited JSON-RPC and `Content-Length` framed input.
- Writes newline-delimited JSON-RPC responses.
- Handles `initialize`, `tools/list`, `resources/templates/list`, and `prompts/list` locally for better discoverability.
- Forwards tool calls and resource reads to the local HTTP server.

Because descriptors are duplicated between the proxy and `mcpServer.ts`, any tool/resource/prompt descriptor changes should update both files or replace the duplication with a shared generator.

## Manual Checks

Inspect app status from the local server:

```bash
curl http://127.0.0.1:38672/health
```

Inspect Codex registration:

```bash
codex mcp get evb_viewer_dev --json
```

Expected dev registration after enabling from Settings:

```json
{
  "name": "evb_viewer_dev",
  "enabled": true,
  "transport": {
    "type": "streamable_http",
    "url": "http://127.0.0.1:38672"
  }
}
```

Ask Codex to use the MCP explicitly when verifying discoverability:

```bash
codex exec --json --cd /path/to/evb-viewer \
  "What document is open in EVB Viewer? Use the evb_viewer_dev MCP server."
```

## Test And Release Coverage

Focused tests:

```bash
pnpm exec vitest run \
  tests/unit/app/modules/workspace-shell/composables/useAgentWorkspaceSnapshot.test.ts \
  tests/unit/app/shared/settingsSanitizer.test.ts \
  tests/unit/app/composables/useSettings.test.ts \
  tests/unit/electron/agentMcpServer.test.ts \
  tests/unit/electron/agentMcpProxy.test.ts
```

Standard gates:

```bash
pnpm lint && pnpm typecheck
pnpm run check:resources:matrix
scripts/verify-packaged-native-tools.sh mac arm64
pnpm run release:verify
```

## Known Limitations

- The external local HTTP MCP server has no token/auth layer.
- Web runtime has no MCP server; it only has no-op typed APIs.
- OCR and convert-to-PDF are recommendations, not MCP-callable actions yet.
- PDF readiness starts as `unknown` until `evb_inspect_document_text` builds or reads the index.
- Port collisions are logged as server errors; there is no automatic fallback port.
- The stdio proxy duplicates descriptor metadata.
- The MCP server does not stream partial results; it returns normal JSON-RPC responses.

## Good Next Iterations

- Add token-based local authorization or a per-session secret if we want stronger loopback safety.
- Share MCP tool/resource/prompt descriptors between HTTP server and stdio proxy.
- Add MCP actions for OCR all pages and convert to PDF once the user-confirmation model is designed.
- Add a status indicator outside Settings if users need to know MCP is active during normal document work.
- Expand resource support for bookmarks, annotations, and selected text.
- Add better port-conflict UX and a self-healing re-registration flow when the port changes.
