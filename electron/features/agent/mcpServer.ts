import {
    BrowserWindow,
    app,
} from 'electron';
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'http';
import type { AddressInfo } from 'net';
import type {
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    TAgentCommand,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import {
    getAllRegisteredAppWindows,
    getRegisteredMainWindow,
    getWindowByIdFromRegistry,
} from '@electron/window/registry';
import {
    requestAgentCommand,
    requestAgentWorkspaceSnapshot,
} from '@electron/features/agent/workspaceBridge';
import {
    inspectAgentDocumentText,
    readAgentDocumentPages,
    searchAgentDocument,
    type IAgentDocumentPageReadOptions,
    type IAgentDocumentSearchOptions,
    type IAgentDocumentTextOperationInput,
} from '@electron/features/agent/documentText';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('agent-mcp');
const DEFAULT_MCP_HOST = '127.0.0.1';
const DEFAULT_PROD_MCP_PORT = 38671;
const DEFAULT_DEV_MCP_PORT = 38672;
const MCP_PROTOCOL_VERSION = '2025-11-25';
const MAX_JSON_RPC_BODY_BYTES = 1024 * 1024;

type TJsonRpcId = string | number | null;
type TJsonRpcResponse = {
    jsonrpc: '2.0';
    id: TJsonRpcId;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
};

interface IJsonRpcRequest {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
}

interface IMcpToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

interface IMcpResourceDefinition {
    name: string;
    title: string;
    uri: string;
    description: string;
    mimeType: string;
}

interface IMcpResourceTemplateDefinition {
    name: string;
    title: string;
    uriTemplate: string;
    description: string;
    mimeType: string;
}

interface IMcpPromptDefinition {
    name: string;
    title: string;
    description: string;
    arguments?: Array<{
        name: string;
        title: string;
        description: string;
        required?: boolean;
    }>;
}

export interface ILocalMcpServerIdentity {
    name: string;
    title: string;
    appName: string;
    version: string;
    isPackaged: boolean;
    userDataPath: string | null;
    host: string;
    port: number;
}

export interface ILocalMcpServerDescriptor {
    name: string;
    title: string;
    host: string;
    port: number;
    url: string;
}

interface IProcessMcpRequestOptions {
    identity: ILocalMcpServerIdentity;
    getWorkspaceSnapshot(windowId?: number): Promise<IAgentWorkspaceSnapshot>;
    runCommand(command: TAgentCommand, windowId?: number): Promise<Record<string, unknown>>;
    inspectDocumentText?(
        input: IAgentDocumentTextOperationInput<Record<never, never>>,
        windowId?: number,
    ): Promise<Record<string, unknown>>;
    searchDocument?(
        input: IAgentDocumentTextOperationInput<IAgentDocumentSearchOptions>,
        windowId?: number,
    ): Promise<Record<string, unknown>>;
    readDocumentPages?(
        input: IAgentDocumentTextOperationInput<IAgentDocumentPageReadOptions>,
        windowId?: number,
    ): Promise<Record<string, unknown>>;
}

let localMcpServer: Server | null = null;

const WINDOW_ID_SCHEMA = {
    type: 'number',
    description: 'Optional Electron window id. Defaults to the focused window or main window.',
};
const TAB_ID_SCHEMA = {
    type: 'string',
    description: 'Optional tab id. Defaults to the active tab.',
};
const READ_ONLY_CLOSED_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
const UI_NAVIGATION_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
const OBJECT_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: true,
};

const MCP_TOOLS = [
    {
        name: 'evb_workspace_snapshot',
        title: 'EVB Viewer workspace snapshot',
        description: 'Fast read of the current EVB Viewer workspace: panes, tabs, active tab, layout tree, page numbers, document kinds, and preparation recommendations. Use this first to discover what is open in EVB Viewer / evb-viewer.',
        inputSchema: {
            type: 'object',
            properties: {windowId: WINDOW_ID_SCHEMA},
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_viewer_open_documents',
        title: 'EVB Viewer open documents',
        description: 'Use this when the user asks what file, PDF, tab, or document is open in EVB Viewer, evb-viewer, or the viewer app. This is the fastest answer for "what document is open?" and should be preferred over inspecting processes, windows, files, or debug ports.',
        inputSchema: {
            type: 'object',
            properties: {windowId: WINDOW_ID_SCHEMA},
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_document_readiness',
        title: 'EVB Viewer document readiness',
        description: 'Fast read of document preparation hints for the active tab, a specific tab, or all tabs. For exact PDF text/OCR coverage, call evb_inspect_document_text.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: {
                    type: 'string',
                    description: 'Optional tab id. Defaults to all tabs with the active tab highlighted.',
                },
            },
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_inspect_document_text',
        title: 'EVB Viewer inspect PDF text coverage',
        description: 'Build or reuse EVB Viewer\'s PDF search index and report searchable text coverage by page. Use this when deciding whether OCR is needed or when search/read tools return empty text.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: TAB_ID_SCHEMA,
            },
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_search_document',
        title: 'EVB Viewer search open PDF',
        description: 'Search searchable text in an open PDF using EVB Viewer\'s cached search index. Use when the user asks to find, locate, search, or navigate to a topic in EVB Viewer / evb-viewer. Returns page numbers and bounded excerpts, so use this before rendering pages or reading the file directly.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: TAB_ID_SCHEMA,
                query: {
                    type: 'string',
                    description: 'Text or regex query to search for in the PDF.',
                },
                maxResults: {
                    type: 'number',
                    description: 'Maximum results to return. Defaults to 25 and is capped at 100.',
                },
                matchCase: {
                    type: 'boolean',
                    description: 'Whether case must match exactly.',
                },
                wholeWord: {
                    type: 'boolean',
                    description: 'Whether matches must be whole words.',
                },
                useRegex: {
                    type: 'boolean',
                    description: 'Treat query as a regular expression.',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_viewer_search_open_document',
        title: 'EVB Viewer search open document',
        description: 'Use this when the user asks to find a word, topic, table, paradigm, or section in the document currently open in EVB Viewer / evb-viewer. It searches the active PDF with EVB Viewer\'s index and returns page candidates for navigation.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: TAB_ID_SCHEMA,
                query: {
                    type: 'string',
                    description: 'Text or regex query to search for in the currently open EVB Viewer PDF.',
                },
                maxResults: {
                    type: 'number',
                    description: 'Maximum results to return. Defaults to 25 and is capped at 100.',
                },
                matchCase: {
                    type: 'boolean',
                    description: 'Whether case must match exactly.',
                },
                wholeWord: {
                    type: 'boolean',
                    description: 'Whether matches must be whole words.',
                },
                useRegex: {
                    type: 'boolean',
                    description: 'Treat query as a regular expression.',
                },
            },
            required: ['query'],
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_read_document_pages',
        title: 'EVB Viewer read PDF page text',
        description: 'Read extracted text for specific one-based PDF pages from EVB Viewer\'s search index. Use after evb_search_document to inspect candidate pages before navigating.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: TAB_ID_SCHEMA,
                pages: {
                    type: 'array',
                    items: {type: 'number'},
                    description: 'One-based page numbers to read. If omitted, reads the current page.',
                },
                startPage: {
                    type: 'number',
                    description: 'Optional first page in a one-based inclusive range.',
                },
                endPage: {
                    type: 'number',
                    description: 'Optional last page in a one-based inclusive range.',
                },
                maxCharsPerPage: {
                    type: 'number',
                    description: 'Maximum characters to return per page. Defaults to 6000 and is capped at 30000.',
                },
            },
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_activate_tab',
        title: 'EVB Viewer activate tab',
        description: 'Activate an open EVB Viewer tab by id. Use tab ids from evb_workspace_snapshot.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: {
                    type: 'string',
                    description: 'The tab id to activate.',
                },
            },
            required: ['tabId'],
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: UI_NAVIGATION_ANNOTATIONS,
    },
    {
        name: 'evb_go_to_page',
        title: 'EVB Viewer go to page',
        description: 'Activate a tab if needed and navigate its PDF viewer to a one-based page number. Use after search/read tools identify the target page.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: TAB_ID_SCHEMA,
                page: {
                    type: 'number',
                    description: 'One-based page number to navigate to.',
                },
            },
            required: ['page'],
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: UI_NAVIGATION_ANNOTATIONS,
    },
] as const satisfies readonly IMcpToolDefinition[];

const MCP_RESOURCE_TEMPLATES = [
    {
        name: 'evb_document_page_text',
        title: 'EVB PDF page text',
        uriTemplate: 'evb://document/{tabId}/page/{page}',
        description: 'Read extracted searchable text for one PDF page in an open EVB Viewer tab.',
        mimeType: 'text/plain',
    },
    {
        name: 'evb_document_text_status',
        title: 'EVB PDF text status',
        uriTemplate: 'evb://document/{tabId}/text-status',
        description: 'Read searchable text coverage and OCR recommendations for an open PDF tab.',
        mimeType: 'application/json',
    },
] as const satisfies readonly IMcpResourceTemplateDefinition[];

const MCP_PROMPTS = [
    {
        name: 'evb_find_in_current_pdf',
        title: 'Find a topic in the current EVB PDF',
        description: 'Workflow for locating a topic or paradigm in the active EVB Viewer PDF and navigating the viewer to the right page.',
        arguments: [{
            name: 'topic',
            title: 'Topic',
            description: 'The topic, term, table, paradigm, or phrase to locate.',
            required: true,
        }],
    },
    {
        name: 'evb_check_document_prep',
        title: 'Check whether the current EVB document needs OCR',
        description: 'Workflow for determining whether an open PDF has enough searchable text for agent analysis.',
    },
] as const satisfies readonly IMcpPromptDefinition[];

function getJsonRpcId(value: unknown): TJsonRpcId {
    if (typeof value === 'string' || typeof value === 'number' || value === null) {
        return value;
    }
    return null;
}

function createResultResponse(id: TJsonRpcId, result: unknown): TJsonRpcResponse {
    return {
        jsonrpc: '2.0',
        id,
        result,
    };
}

function createErrorResponse(
    id: TJsonRpcId,
    code: number,
    message: string,
    data?: unknown,
): TJsonRpcResponse {
    return {
        jsonrpc: '2.0',
        id,
        error: {
            code,
            message,
            ...(data === undefined ? {} : { data }),
        },
    };
}

function createToolResult(data: unknown) {
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(data, null, 2),
        }],
        structuredContent: data,
    };
}

function createInitializeMetadata(identity: ILocalMcpServerIdentity) {
    return {evb: {
        appName: identity.appName,
        isPackaged: identity.isPackaged,
        userDataPath: identity.userDataPath,
        mcp: {
            host: identity.host,
            port: identity.port,
        },
    }};
}

function createHealthResponse(identity: ILocalMcpServerIdentity) {
    return {
        ok: true,
        ...identity,
        tools: MCP_TOOLS.map(tool => tool.name),
        resources: [
            'evb://workspace/current',
            ...MCP_RESOURCE_TEMPLATES.map(template => template.uriTemplate),
        ],
        prompts: MCP_PROMPTS.map(prompt => prompt.name),
    };
}

function createInitializeInstructions() {
    return [
        'EVB Viewer exposes the live PDF workspace. If the user mentions EVB Viewer, evb-viewer, the viewer app, the open document, or the current PDF, use these MCP tools before inspecting processes, files, windows, or debug ports.',
        'For questions like "what document is open in evb-viewer?", call evb_viewer_open_documents. Use evb_workspace_snapshot when you need the full pane/tab/layout tree.',
        'For questions like "find X in this PDF" or "navigate to X", call evb_viewer_search_open_document or evb_search_document first. They use EVB Viewer search indexes and return page numbers plus excerpts.',
        'After search, call evb_read_document_pages for candidate pages if you need surrounding text, then evb_go_to_page to navigate the visible viewer.',
        'If a PDF page has no text or search misses likely visual/OCR content, call evb_inspect_document_text and recommend OCR all pages when coverage is partial or none.',
        'For DjVu or image documents, tell the user to convert to PDF before deep text analysis.',
    ].join('\n');
}

function getRequiredCapability<TCapability>(
    capability: TCapability | undefined,
    name: string,
) {
    if (!capability) {
        throw new Error(`${name} is not available in this EVB Viewer MCP session.`);
    }
    return capability;
}

function getParamsObject(params: unknown) {
    return isRecord(params) ? params : {};
}

function getOptionalWindowId(params: unknown) {
    const paramsObject = getParamsObject(params);
    return typeof paramsObject.windowId === 'number' && Number.isFinite(paramsObject.windowId)
        ? paramsObject.windowId
        : undefined;
}

function getOptionalTabId(params: unknown) {
    const paramsObject = getParamsObject(params);
    return typeof paramsObject.tabId === 'string' && paramsObject.tabId.trim().length > 0
        ? paramsObject.tabId.trim()
        : undefined;
}

function getRequiredTabId(params: unknown) {
    const tabId = getOptionalTabId(params);
    if (!tabId) {
        throw new Error('tabId is required.');
    }
    return tabId;
}

function getRequiredPage(params: unknown) {
    const paramsObject = getParamsObject(params);
    const page = paramsObject.page;
    if (typeof page !== 'number' || !Number.isFinite(page)) {
        throw new Error('page must be a finite number.');
    }
    return Math.max(1, Math.trunc(page));
}

function getRequiredQuery(params: unknown) {
    const paramsObject = getParamsObject(params);
    const query = typeof paramsObject.query === 'string' ? paramsObject.query.trim() : '';
    if (!query) {
        throw new Error('query is required.');
    }
    return query;
}

function getOptionalBoolean(params: unknown, key: string) {
    const value = getParamsObject(params)[key];
    return typeof value === 'boolean' ? value : undefined;
}

function getOptionalFiniteNumber(params: unknown, key: string) {
    const value = getParamsObject(params)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizePageNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(1, Math.trunc(value))
        : null;
}

function getReadPages(params: unknown, fallbackPage: number | null) {
    const paramsObject = getParamsObject(params);
    const pages = new Set<number>();
    if (Array.isArray(paramsObject.pages)) {
        for (const page of paramsObject.pages) {
            const normalizedPage = normalizePageNumber(page);
            if (normalizedPage !== null) {
                pages.add(normalizedPage);
            }
        }
    }

    const startPage = normalizePageNumber(paramsObject.startPage);
    const endPage = normalizePageNumber(paramsObject.endPage);
    if (startPage !== null || endPage !== null) {
        const start = startPage ?? endPage ?? 1;
        const end = endPage ?? startPage ?? start;
        const lower = Math.min(start, end);
        const upper = Math.max(start, end);
        for (let page = lower; page <= upper; page += 1) {
            pages.add(page);
        }
    }

    if (pages.size === 0 && fallbackPage !== null) {
        pages.add(fallbackPage);
    }

    return Array.from(pages).sort((left, right) => left - right);
}

function getDocumentSearchOptions(params: unknown): IAgentDocumentSearchOptions {
    const maxResults = getOptionalFiniteNumber(params, 'maxResults');
    const matchCase = getOptionalBoolean(params, 'matchCase');
    const wholeWord = getOptionalBoolean(params, 'wholeWord');
    const useRegex = getOptionalBoolean(params, 'useRegex');
    return {
        query: getRequiredQuery(params),
        ...(maxResults === undefined ? {} : {maxResults}),
        ...(matchCase === undefined ? {} : {matchCase}),
        ...(wholeWord === undefined ? {} : {wholeWord}),
        ...(useRegex === undefined ? {} : {useRegex}),
    };
}

function getDocumentPageReadOptions(
    params: unknown,
    tab: IAgentTabSnapshot,
): IAgentDocumentPageReadOptions {
    const maxCharsPerPage = getOptionalFiniteNumber(params, 'maxCharsPerPage');
    return {
        pages: getReadPages(params, tab.currentPage),
        ...(maxCharsPerPage === undefined ? {} : {maxCharsPerPage}),
    };
}

function getDefaultAgentWindow() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && getWindowByIdFromRegistry(focusedWindow.id)) {
        return focusedWindow;
    }
    return getRegisteredMainWindow();
}

function resolveAgentWindow(windowId?: number) {
    return windowId === undefined
        ? getDefaultAgentWindow()
        : getWindowByIdFromRegistry(windowId);
}

function selectDocumentsFromSnapshot(snapshot: IAgentWorkspaceSnapshot, tabId?: string) {
    const tabs = tabId
        ? snapshot.tabs.filter(tab => tab.tabId === tabId)
        : snapshot.tabs;
    return {
        activePaneId: snapshot.activePaneId,
        activeTabId: snapshot.activeTabId,
        tabs,
    };
}

function createOpenDocumentsResponse(snapshot: IAgentWorkspaceSnapshot) {
    const documents = snapshot.tabs
        .filter(tab => tab.workspaceAttached)
        .map(tab => ({
            tabId: tab.tabId,
            paneId: tab.paneId,
            isActive: tab.tabId === snapshot.activeTabId,
            fileName: tab.fileName,
            originalPath: tab.originalPath,
            kind: tab.kind,
            currentPage: tab.currentPage,
            totalPages: tab.totalPages,
            isDirty: tab.isDirty,
            readiness: tab.readiness,
        }));

    return {
        activePaneId: snapshot.activePaneId,
        activeTabId: snapshot.activeTabId,
        activeDocument: documents.find(document => document.isActive) ?? null,
        documents,
        panes: snapshot.panes.map(pane => ({
            paneId: pane.paneId,
            activeTabId: pane.activeTabId,
            tabIds: pane.tabIds,
        })),
    };
}

function getTargetTab(snapshot: IAgentWorkspaceSnapshot, tabId?: string) {
    const resolvedTabId = tabId ?? snapshot.activeTabId;
    if (!resolvedTabId) {
        throw new Error('No active tab is available.');
    }

    const tab = snapshot.tabs.find(candidate => candidate.tabId === resolvedTabId);
    if (!tab) {
        throw new Error(`Tab ${resolvedTabId} is not open.`);
    }
    return tab;
}

async function getTargetTabFromParams(
    params: unknown,
    options: IProcessMcpRequestOptions,
) {
    const windowId = getOptionalWindowId(params);
    const snapshot = await options.getWorkspaceSnapshot(windowId);
    return {
        windowId,
        snapshot,
        tab: getTargetTab(snapshot, getOptionalTabId(params)),
    };
}

async function callTool(name: string, params: unknown, options: IProcessMcpRequestOptions) {
    const windowId = getOptionalWindowId(params);
    if (name === 'evb_workspace_snapshot') {
        return createToolResult(await options.getWorkspaceSnapshot(windowId));
    }

    if (name === 'evb_viewer_open_documents') {
        return createToolResult(createOpenDocumentsResponse(await options.getWorkspaceSnapshot(windowId)));
    }

    if (name === 'evb_document_readiness') {
        const snapshot = await options.getWorkspaceSnapshot(windowId);
        return createToolResult(selectDocumentsFromSnapshot(snapshot, getOptionalTabId(params)));
    }

    if (name === 'evb_inspect_document_text') {
        const {tab} = await getTargetTabFromParams(params, options);
        const inspectDocumentText = getRequiredCapability(options.inspectDocumentText, 'evb_inspect_document_text');
        return createToolResult(await inspectDocumentText({
            tab,
            options: {},
        }, windowId));
    }

    if (name === 'evb_search_document' || name === 'evb_viewer_search_open_document') {
        const {tab} = await getTargetTabFromParams(params, options);
        const searchDocument = getRequiredCapability(options.searchDocument, name);
        return createToolResult(await searchDocument({
            tab,
            options: getDocumentSearchOptions(params),
        }, windowId));
    }

    if (name === 'evb_read_document_pages') {
        const {tab} = await getTargetTabFromParams(params, options);
        const readDocumentPages = getRequiredCapability(options.readDocumentPages, 'evb_read_document_pages');
        return createToolResult(await readDocumentPages({
            tab,
            options: getDocumentPageReadOptions(params, tab),
        }, windowId));
    }

    if (name === 'evb_activate_tab') {
        return createToolResult(await options.runCommand({
            name: 'activate_tab',
            arguments: { tabId: getRequiredTabId(params) },
        }, windowId));
    }

    if (name === 'evb_go_to_page') {
        const tabId = getOptionalTabId(params);
        const command: TAgentCommand = {
            name: 'go_to_page',
            arguments: {
                page: getRequiredPage(params),
                ...(tabId ? { tabId } : {}),
            },
        };
        return createToolResult(await options.runCommand(command, windowId));
    }

    throw new Error(`Unknown tool: ${name}`);
}

function getClientProtocolVersion(params: unknown) {
    if (!isRecord(params) || typeof params.protocolVersion !== 'string') {
        return MCP_PROTOCOL_VERSION;
    }
    return params.protocolVersion.trim() || MCP_PROTOCOL_VERSION;
}

const WORKSPACE_RESOURCE_URI = 'evb://workspace/current';

function createWorkspaceResource(): IMcpResourceDefinition {
    return {
        name: 'evb_workspace_current',
        title: 'EVB Viewer current workspace',
        uri: WORKSPACE_RESOURCE_URI,
        description: 'Live JSON snapshot of EVB Viewer panes, tabs, active document, page numbers, and readiness hints.',
        mimeType: 'application/json',
    };
}

function createDocumentStatusResource(tab: IAgentTabSnapshot): IMcpResourceDefinition {
    return {
        name: `evb_document_${tab.tabId.replaceAll(/[^a-zA-Z0-9_]/gu, '_')}_text_status`,
        title: `${tab.fileName ?? tab.tabId} text status`,
        uri: `evb://document/${encodeURIComponent(tab.tabId)}/text-status`,
        description: 'Searchable text coverage and OCR recommendations for this open EVB Viewer tab.',
        mimeType: 'application/json',
    };
}

async function listMcpResources(options: IProcessMcpRequestOptions) {
    const snapshot = await options.getWorkspaceSnapshot();
    return {resources: [
        createWorkspaceResource(),
        ...snapshot.tabs
            .filter(tab => tab.kind === 'pdf' && tab.workspaceAttached)
            .map(createDocumentStatusResource),
    ]};
}

function parseResourceUri(uri: unknown) {
    if (typeof uri !== 'string' || uri.trim().length === 0) {
        throw new Error('resources/read requires params.uri.');
    }

    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        throw new Error(`Invalid EVB resource URI: ${uri}`);
    }

    if (parsed.protocol !== 'evb:') {
        throw new Error(`Unsupported resource URI protocol: ${parsed.protocol}`);
    }

    const parts = parsed.pathname
        .split('/')
        .filter(Boolean)
        .map(part => decodeURIComponent(part));
    return {
        uri,
        host: parsed.hostname,
        parts,
    };
}

function createTextResourceContent(uri: string, text: string, mimeType: string) {
    return {
        uri,
        mimeType,
        text,
    };
}

async function readMcpResource(
    params: unknown,
    options: IProcessMcpRequestOptions,
) {
    const parsed = parseResourceUri(getParamsObject(params).uri);
    if (parsed.host === 'workspace' && parsed.parts[0] === 'current') {
        const snapshot = await options.getWorkspaceSnapshot();
        return {contents: [createTextResourceContent(
            parsed.uri,
            JSON.stringify(snapshot, null, 2),
            'application/json',
        )]};
    }

    if (parsed.host !== 'document') {
        throw new Error(`Unknown EVB resource host: ${parsed.host}`);
    }

    const [
        tabId,
        resourceKind,
        pageToken,
    ] = parsed.parts;
    if (!tabId || !resourceKind) {
        throw new Error(`Invalid EVB document resource URI: ${parsed.uri}`);
    }

    const snapshot = await options.getWorkspaceSnapshot();
    const tab = getTargetTab(snapshot, tabId);
    if (resourceKind === 'text-status') {
        const inspectDocumentText = getRequiredCapability(options.inspectDocumentText, 'resources/read text-status');
        const result = await inspectDocumentText({
            tab,
            options: {},
        });
        return {contents: [createTextResourceContent(
            parsed.uri,
            JSON.stringify(result, null, 2),
            'application/json',
        )]};
    }

    if (resourceKind === 'page') {
        const page = normalizePageNumber(Number(pageToken));
        if (page === null) {
            throw new Error(`Invalid EVB document page resource URI: ${parsed.uri}`);
        }
        const readDocumentPages = getRequiredCapability(options.readDocumentPages, 'resources/read page');
        const result = await readDocumentPages({
            tab,
            options: {pages: [page]},
        });
        const pageResult = Array.isArray(result.pages)
            ? result.pages.find(candidate => isRecord(candidate) && candidate.page === page)
            : null;
        const text = isRecord(pageResult) && typeof pageResult.text === 'string'
            ? pageResult.text
            : '';
        return {contents: [createTextResourceContent(parsed.uri, text, 'text/plain')]};
    }

    throw new Error(`Unknown EVB document resource kind: ${resourceKind}`);
}

function getPromptName(params: unknown) {
    const name = getParamsObject(params).name;
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('prompts/get requires params.name.');
    }
    return name.trim();
}

function getPromptArgument(params: unknown, key: string) {
    const args = getParamsObject(params).arguments;
    if (!isRecord(args)) {
        return '';
    }
    const value = args[key];
    return typeof value === 'string' ? value.trim() : '';
}

function createPromptText(name: string, params: unknown) {
    if (name === 'evb_find_in_current_pdf') {
        const topic = getPromptArgument(params, 'topic') || '<topic>';
        return [
            `Find "${topic}" in the active EVB Viewer PDF.`,
            'Use evb_viewer_open_documents or evb_workspace_snapshot to identify the active tab.',
            'Use evb_viewer_search_open_document or evb_search_document with a small set of likely query variants; inspect candidate pages with evb_read_document_pages.',
            'Navigate with evb_go_to_page only after choosing the best page. If text coverage is missing, call evb_inspect_document_text and recommend OCR all pages.',
        ].join('\n');
    }

    if (name === 'evb_check_document_prep') {
        return [
            'Check whether the active EVB Viewer document is agent-ready.',
            'Use evb_viewer_open_documents, evb_workspace_snapshot, and evb_document_readiness first.',
            'For PDFs, call evb_inspect_document_text to compute searchable text coverage.',
            'If coverage is partial or none, explain that OCR all pages is recommended. If the document is DjVu or image, recommend converting to PDF first.',
        ].join('\n');
    }

    throw new Error(`Unknown prompt: ${name}`);
}

function getMcpPrompt(params: unknown) {
    const name = getPromptName(params);
    const prompt = MCP_PROMPTS.find(candidate => candidate.name === name);
    if (!prompt) {
        throw new Error(`Unknown prompt: ${name}`);
    }

    return {
        description: prompt.description,
        messages: [{
            role: 'user',
            content: {
                type: 'text',
                text: createPromptText(name, params),
            },
        }],
    };
}

export async function processMcpRequest(
    rawRequest: unknown,
    options: IProcessMcpRequestOptions,
): Promise<TJsonRpcResponse | null> {
    if (!isRecord(rawRequest)) {
        return createErrorResponse(null, -32600, 'Invalid JSON-RPC request.');
    }

    const request = rawRequest as IJsonRpcRequest;
    const id = getJsonRpcId(request.id);
    const isNotification = request.id === undefined;
    const method = typeof request.method === 'string' ? request.method : '';

    if (!method) {
        return createErrorResponse(id, -32600, 'JSON-RPC method is required.');
    }

    if (method === 'notifications/initialized') {
        return null;
    }

    try {
        if (method === 'initialize') {
            return createResultResponse(id, {
                protocolVersion: getClientProtocolVersion(request.params),
                capabilities: {
                    tools: {listChanged: false},
                    resources: {
                        subscribe: false,
                        listChanged: false,
                    },
                    prompts: {listChanged: false},
                },
                serverInfo: {
                    name: options.identity.name,
                    title: options.identity.title,
                    version: options.identity.version,
                },
                instructions: createInitializeInstructions(),
                _meta: createInitializeMetadata(options.identity),
            });
        }

        if (method === 'tools/list') {
            return createResultResponse(id, { tools: MCP_TOOLS });
        }

        if (method === 'tools/call') {
            const params = getParamsObject(request.params);
            const toolName = typeof params.name === 'string' ? params.name : '';
            if (!toolName) {
                return createErrorResponse(id, -32602, 'tools/call requires params.name.');
            }

            const result = await callTool(toolName, params.arguments, options);
            return createResultResponse(id, result);
        }

        if (method === 'resources/list') {
            return createResultResponse(id, await listMcpResources(options));
        }

        if (method === 'resources/templates/list') {
            return createResultResponse(id, {resourceTemplates: MCP_RESOURCE_TEMPLATES});
        }

        if (method === 'resources/read') {
            return createResultResponse(id, await readMcpResource(request.params, options));
        }

        if (method === 'prompts/list') {
            return createResultResponse(id, {prompts: MCP_PROMPTS});
        }

        if (method === 'prompts/get') {
            return createResultResponse(id, getMcpPrompt(request.params));
        }

        if (isNotification) {
            return null;
        }

        return createErrorResponse(id, -32601, `Method not found: ${method}`);
    } catch (error) {
        return createErrorResponse(id, -32603, getErrorMessage(error));
    }
}

function readRequestBody(request: IncomingMessage) {
    return new Promise<string>((resolve, reject) => {
        let body = '';

        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > MAX_JSON_RPC_BODY_BYTES) {
                reject(new Error('JSON-RPC request body is too large.'));
                request.destroy();
            }
        });
        request.on('end', () => resolve(body));
        request.on('error', reject);
    });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(payload));
}

function writeNoContent(response: ServerResponse) {
    response.writeHead(202, {'Cache-Control': 'no-store'});
    response.end();
}

function createHttpHandler(options: IProcessMcpRequestOptions) {
    return async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method === 'GET' && request.url === '/health') {
            writeJson(response, 200, createHealthResponse(options.identity));
            return;
        }

        if (request.method !== 'POST') {
            writeJson(response, 405, { error: 'Only POST JSON-RPC requests are supported.' });
            return;
        }

        try {
            const body = await readRequestBody(request);
            const parsed: unknown = JSON.parse(body);
            if (Array.isArray(parsed)) {
                const responses = (await Promise.all(
                    parsed.map(item => processMcpRequest(item, options)),
                )).filter((item): item is TJsonRpcResponse => item !== null);

                if (responses.length === 0) {
                    writeNoContent(response);
                    return;
                }
                writeJson(response, 200, responses);
                return;
            }

            const result = await processMcpRequest(parsed, options);
            if (!result) {
                writeNoContent(response);
                return;
            }
            writeJson(response, 200, result);
        } catch (error) {
            writeJson(response, 400, createErrorResponse(null, -32700, getErrorMessage(error)));
        }
    };
}

function parsePort(value: string | undefined, fallbackPort: number) {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        return fallbackPort;
    }
    return parsed;
}

export function resolveDefaultLocalMcpPort(isPackaged: boolean) {
    return isPackaged ? DEFAULT_PROD_MCP_PORT : DEFAULT_DEV_MCP_PORT;
}

function getAppUserDataPath() {
    try {
        return app.getPath('userData');
    } catch {
        return null;
    }
}

export function createLocalMcpServerIdentity(port: number, host = DEFAULT_MCP_HOST): ILocalMcpServerIdentity {
    const isPackaged = app.isPackaged;
    const appName = app.getName();
    return {
        name: isPackaged ? 'evb_viewer' : 'evb_viewer_dev',
        title: appName,
        appName,
        version: app.getVersion(),
        isPackaged,
        userDataPath: getAppUserDataPath(),
        host,
        port,
    };
}

function resolveConfiguredLocalMcpPort() {
    return parsePort(process.env.EVB_MCP_PORT, resolveDefaultLocalMcpPort(app.isPackaged));
}

export function getLocalMcpServerDescriptor(): ILocalMcpServerDescriptor {
    const port = resolveConfiguredLocalMcpPort();
    const identity = createLocalMcpServerIdentity(port);
    return {
        name: identity.name,
        title: identity.title,
        host: identity.host,
        port: identity.port,
        url: `http://${identity.host}:${identity.port}`,
    };
}

export function isLocalMcpServerRunning() {
    return localMcpServer !== null;
}

export function startLocalMcpServer() {
    if (localMcpServer) {
        return;
    }

    const port = resolveConfiguredLocalMcpPort();
    const identity = createLocalMcpServerIdentity(port);
    const options: IProcessMcpRequestOptions = {
        identity,
        getWorkspaceSnapshot: async (windowId) => {
            const window = resolveAgentWindow(windowId);
            return requestAgentWorkspaceSnapshot(window);
        },
        runCommand: async (command, windowId) => {
            const window = resolveAgentWindow(windowId);
            return requestAgentCommand(window, command);
        },
        inspectDocumentText: async (input, windowId) => {
            const window = resolveAgentWindow(windowId);
            if (!window) {
                throw new Error('No live renderer window is available for document text inspection.');
            }
            return inspectAgentDocumentText(window, input);
        },
        searchDocument: async (input, windowId) => {
            const window = resolveAgentWindow(windowId);
            if (!window) {
                throw new Error('No live renderer window is available for document search.');
            }
            return searchAgentDocument(window, input);
        },
        readDocumentPages: async (input, windowId) => {
            const window = resolveAgentWindow(windowId);
            if (!window) {
                throw new Error('No live renderer window is available for document page text reading.');
            }
            return readAgentDocumentPages(window, input);
        },
    };

    const server = createServer(createHttpHandler(options));
    server.on('error', (error) => {
        logger.error(`Local MCP server failed: ${getErrorMessage(error)}`);
    });
    server.listen(port, DEFAULT_MCP_HOST, () => {
        const address = server.address() as AddressInfo | null;
        logger.info(`Local MCP server ${identity.name} listening on http://${DEFAULT_MCP_HOST}:${address?.port ?? port}`);
    });
    localMcpServer = server;
}

export function shutdownLocalMcpServer() {
    const server = localMcpServer;
    if (!server) {
        return Promise.resolve();
    }

    localMcpServer = null;
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}

export function listRegisteredAgentWindowsForMcp() {
    return getAllRegisteredAppWindows().map(window => ({
        windowId: window.id,
        title: window.getTitle(),
    }));
}
