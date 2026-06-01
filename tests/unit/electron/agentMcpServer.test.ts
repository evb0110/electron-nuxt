import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAgentWorkspaceSnapshot,
    TAgentCommand,
} from '@contracts/agent';
import {
    createLocalMcpServerIdentity,
    processMcpRequest,
    resolveDefaultLocalMcpPort,
} from '@electron/features/agent/mcpServer';
import type {
    IAgentDocumentPageReadOptions,
    IAgentDocumentSearchOptions,
    IAgentDocumentTextOperationInput,
} from '@electron/features/agent/documentText';

vi.mock('electron', () => ({
    app: {
        getName: () => 'EVB Viewer Dev',
        getPath: (name: string) => `/tmp/${name}`,
        getVersion: () => 'test',
        isPackaged: false,
    },
    BrowserWindow: { getFocusedWindow: () => null },
}));

vi.mock('@electron/window/registry', () => ({
    getAllRegisteredAppWindows: () => [],
    getRegisteredMainWindow: () => null,
    getWindowByIdFromRegistry: () => null,
}));

vi.mock('@electron/features/agent/workspaceBridge', () => ({
    requestAgentCommand: vi.fn(),
    requestAgentWorkspaceSnapshot: vi.fn(),
}));

vi.mock('@electron/utils/logger', () => ({ createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}) }));

const workspaceSnapshot: IAgentWorkspaceSnapshot = {
    capturedAt: '2026-06-01T00:00:00.000Z',
    activePaneId: 'pane-1',
    activeTabId: 'tab-1',
    panes: [{
        paneId: 'pane-1',
        tabIds: ['tab-1'],
        activeTabId: 'tab-1',
    }],
    tabs: [{
        tabId: 'tab-1',
        paneId: 'pane-1',
        fileName: 'Grammar.pdf',
        originalPath: '/tmp/Grammar.pdf',
        isDirty: false,
        kind: 'pdf',
        workspaceAttached: true,
        hasPdf: true,
        isDjvu: false,
        isOpeningDocument: false,
        hasOpenError: false,
        currentPage: 5,
        totalPages: 25,
        readiness: {
            status: 'unknown',
            reasons: ['Page-level OCR coverage is not exposed to agents yet.'],
            ocr: {
                status: 'unknown',
                pageCount: 25,
            },
            recommendations: [{
                id: 'ocr_all_pages',
                title: 'OCR all pages',
                reason: 'If any pages lack a searchable text layer, OCRing all pages gives the agent consistent text access.',
                toolName: 'evb.ocr_all_pages',
            }],
        },
    }],
    layout: {
        type: 'leaf',
        paneId: 'pane-1',
    },
};

function createOptions() {
    return {
        identity: {
            name: 'evb_viewer_dev',
            title: 'EVB Viewer Dev',
            appName: 'EVB Viewer Dev',
            version: '1.2.3',
            isPackaged: false,
            userDataPath: '/tmp/userData',
            host: '127.0.0.1',
            port: 38672,
        },
        getWorkspaceSnapshot: vi.fn(async (_windowId?: number) => workspaceSnapshot),
        runCommand: vi.fn(async (_command: TAgentCommand, _windowId?: number) => ({ ok: true })),
        inspectDocumentText: vi.fn(async ({tab}: IAgentDocumentTextOperationInput<Record<never, never>>) => ({
            tabId: tab.tabId,
            textStatus: {
                status: 'complete',
                pageCount: 25,
                textPageCount: 25,
                missingTextPages: [],
                missingTextPageSample: [],
                coverage: 1,
            },
            recommendations: [],
        })),
        searchDocument: vi.fn(async ({
            tab,
            options,
        }: IAgentDocumentTextOperationInput<IAgentDocumentSearchOptions>) => ({
            tabId: tab.tabId,
            query: options.query,
            results: [{
                pageNumber: 12,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 10,
                endOffset: 16,
                excerpt: {
                    prefix: false,
                    suffix: false,
                    before: 'before ',
                    match: options.query,
                    after: ' after',
                },
            }],
            returnedResults: 1,
            totalAvailableResults: 1,
            truncated: false,
        })),
        readDocumentPages: vi.fn(async ({
            tab,
            options,
        }: IAgentDocumentTextOperationInput<IAgentDocumentPageReadOptions>) => ({
            tabId: tab.tabId,
            pageCount: 25,
            pages: options.pages.map(page => ({
                page,
                hasText: true,
                textLength: 12,
                truncated: false,
                text: `Page ${page} text`,
            })),
        })),
    };
}

describe('processMcpRequest', () => {
    it('uses different default MCP ports for packaged and dev apps', () => {
        expect(resolveDefaultLocalMcpPort(true)).toBe(38671);
        expect(resolveDefaultLocalMcpPort(false)).toBe(38672);
    });

    it('builds dev MCP identity from the Electron app', () => {
        expect(createLocalMcpServerIdentity(38672)).toMatchObject({
            name: 'evb_viewer_dev',
            title: 'EVB Viewer Dev',
            appName: 'EVB Viewer Dev',
            version: 'test',
            isPackaged: false,
            userDataPath: '/tmp/userData',
            host: '127.0.0.1',
            port: 38672,
        });
    });

    it('responds to MCP initialize and lists EVB tools', async () => {
        const options = createOptions();

        const initialized = await processMcpRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-11-25' },
        }, options);
        const tools = await processMcpRequest({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
        }, options);

        expect(initialized?.result).toMatchObject({
            protocolVersion: '2025-11-25',
            capabilities: {
                tools: {listChanged: false},
                resources: {
                    subscribe: false,
                    listChanged: false,
                },
                prompts: {listChanged: false},
            },
            serverInfo: {
                name: 'evb_viewer_dev',
                title: 'EVB Viewer Dev',
                version: '1.2.3',
            },
            _meta: {evb: {
                appName: 'EVB Viewer Dev',
                isPackaged: false,
                userDataPath: '/tmp/userData',
                mcp: {
                    host: '127.0.0.1',
                    port: 38672,
                },
            }},
        });
        expect(JSON.stringify(initialized?.result)).toContain('evb_search_document');
        expect(JSON.stringify(tools?.result)).toContain('evb_workspace_snapshot');
        expect(JSON.stringify(tools?.result)).toContain('evb_viewer_open_documents');
        expect(JSON.stringify(tools?.result)).toContain('evb_viewer_search_open_document');
        expect(JSON.stringify(tools?.result)).toContain('evb_search_document');
        expect(JSON.stringify(tools?.result)).toContain('readOnlyHint');
        expect(JSON.stringify(tools?.result)).toContain('evb_go_to_page');
    });

    it('returns open documents through the discoverable EVB Viewer tool', async () => {
        const options = createOptions();

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'open-documents',
            method: 'tools/call',
            params: {
                name: 'evb_viewer_open_documents',
                arguments: {},
            },
        }, options);

        expect(options.getWorkspaceSnapshot).toHaveBeenCalledOnce();
        expect(response?.result).toMatchObject({structuredContent: {
            activeTabId: 'tab-1',
            activeDocument: {
                tabId: 'tab-1',
                fileName: 'Grammar.pdf',
                originalPath: '/tmp/Grammar.pdf',
                currentPage: 5,
                totalPages: 25,
            },
            documents: [{
                tabId: 'tab-1',
                isActive: true,
            }],
        }});
    });

    it('returns document readiness through a tool call', async () => {
        const options = createOptions();

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'readiness',
            method: 'tools/call',
            params: {
                name: 'evb_document_readiness',
                arguments: { tabId: 'tab-1' },
            },
        }, options);

        expect(options.getWorkspaceSnapshot).toHaveBeenCalledOnce();
        expect(response?.result).toMatchObject({structuredContent: {
            activeTabId: 'tab-1',
            tabs: [{
                tabId: 'tab-1',
                readiness: {recommendations: [{id: 'ocr_all_pages'}]},
            }],
        }});
    });

    it('searches the active PDF through the document text handler', async () => {
        const options = createOptions();

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'search',
            method: 'tools/call',
            params: {
                name: 'evb_viewer_search_open_document',
                arguments: {
                    query: 'stem',
                    maxResults: 5,
                    wholeWord: true,
                },
            },
        }, options);

        expect(options.searchDocument).toHaveBeenCalledWith({
            tab: workspaceSnapshot.tabs[0],
            options: {
                query: 'stem',
                maxResults: 5,
                wholeWord: true,
            },
        }, undefined);
        expect(response?.result).toMatchObject({structuredContent: {
            tabId: 'tab-1',
            query: 'stem',
            results: [{pageNumber: 12}],
        }});
    });

    it('exposes workspace resources, page text resources, and prompts', async () => {
        const options = createOptions();

        const resources = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'resources',
            method: 'resources/list',
        }, options);
        const pageText = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'page',
            method: 'resources/read',
            params: {uri: 'evb://document/tab-1/page/7'},
        }, options);
        const prompt = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'prompt',
            method: 'prompts/get',
            params: {
                name: 'evb_find_in_current_pdf',
                arguments: {topic: 'seventh stem tables'},
            },
        }, options);

        expect(JSON.stringify(resources?.result)).toContain('evb://workspace/current');
        expect(pageText?.result).toMatchObject({contents: [{
            uri: 'evb://document/tab-1/page/7',
            mimeType: 'text/plain',
            text: 'Page 7 text',
        }]});
        expect(JSON.stringify(prompt?.result)).toContain('seventh stem tables');
        expect(JSON.stringify(prompt?.result)).toContain('evb_search_document');
    });

    it('dispatches go-to-page commands with normalized page numbers', async () => {
        const options = createOptions();

        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'go-to-page',
            method: 'tools/call',
            params: {
                name: 'evb_go_to_page',
                arguments: {
                    tabId: 'tab-1',
                    page: 8.9,
                },
            },
        }, options);

        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'go_to_page',
            arguments: {
                tabId: 'tab-1',
                page: 8,
            },
        }, undefined);
    });
});
