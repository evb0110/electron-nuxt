import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import type {
    IAgentWorkspaceSnapshot,
    TAgentCommand,
} from '@contracts/agent';
import { ASSISTANT_MCP_TOKEN_ENV } from '@electron/features/agent/codexAssistantConfig';
import {
    createLocalMcpServerIdentity,
    getLocalMcpCodexRegistrationTransport,
    getLocalMcpSetupSnippets,
    processMcpRequest,
    resolveDefaultLocalMcpPort,
    shutdownLocalMcpServer,
    startLocalMcpServer,
} from '@electron/features/agent/mcpServer';
import type {
    IAgentDocumentPageReadOptions,
    IAgentDocumentSearchOptions,
    IAgentDocumentTextOperationInput,
} from '@electron/features/agent/documentText';

vi.mock('electron', () => ({
    app: {
        getName: () => 'EVB Viewer Dev',
        getAppPath: () => '/tmp/app-root',
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

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}) }));

interface IListToolsResult { tools?: IListToolsResultTool[]; }
interface IListToolsResultTool {
    annotations?: Record<string, unknown>;
    name: string;
}

const workspaceSnapshot: IAgentWorkspaceSnapshot = {
    capturedAt: '2026-06-01T00:00:00.000Z',
    activePaneId: 'pane-1',
    activeTabId: 'tab-1',
    summary: {
        mode: 'open-document',
        activeDocument: {
            tabId: 'tab-1',
            paneId: 'pane-1',
            fileName: 'Grammar.pdf',
            originalPath: '/tmp/Grammar.pdf',
            kind: 'pdf',
        },
        documentCount: 1,
        recentFileCount: 1,
        recentFilesResolved: true,
    },
    panes: [{
        paneId: 'pane-1',
        tabIds: [
            'tab-1',
            'tab-empty',
        ],
        activeTabId: 'tab-1',
    }],
    tabs: [
        {
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
        },
        {
            tabId: 'tab-empty',
            paneId: 'pane-1',
            fileName: null,
            originalPath: null,
            isDirty: false,
            kind: 'empty',
            workspaceAttached: true,
            hasPdf: false,
            isDjvu: false,
            isOpeningDocument: false,
            hasOpenError: false,
            currentPage: null,
            totalPages: null,
            readiness: {
                status: 'empty',
                reasons: ['No document is open in this tab.'],
                recommendations: [],
            },
        },
    ],
    recentFiles: [{
        fileName: 'Recent Grammar.pdf',
        originalPath: '/tmp/Recent Grammar.pdf',
        kind: 'pdf',
        openedAt: '2026-05-31T00:00:00.000Z',
    }],
    layout: {
        type: 'leaf',
        paneId: 'pane-1',
    },
};

async function findFreePort() {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    await new Promise<void>(resolve => server.close(() => resolve()));
    return typeof address === 'object' && address !== null ? address.port : 38672;
}

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
        runCommand: vi.fn(async (
            _command: TAgentCommand,
            _windowId?: number,
        ): Promise<Record<string, unknown>> => ({ ok: true })),
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

function expectStructuredCloneable(value: unknown) {
    expect(() => structuredClone(value)).not.toThrow();
}

describe('processMcpRequest', () => {
    afterEach(async () => {
        await shutdownLocalMcpServer();
        await rm('/tmp/userData/agent-mcp-token.txt', {force: true}).catch(() => {});
        vi.unstubAllEnvs();
    });

    it('uses different default MCP ports for packaged and dev apps', () => {
        expect(resolveDefaultLocalMcpPort(true)).toBe(38671);
        expect(resolveDefaultLocalMcpPort(false)).toBe(38672);
    });

    it('publishes generated local MCP tokens through the configured Codex env var', async () => {
        vi.stubEnv('EVB_MCP_PORT', String(await findFreePort()));
        vi.stubEnv(ASSISTANT_MCP_TOKEN_ENV, '');

        await startLocalMcpServer();

        expect(process.env[ASSISTANT_MCP_TOKEN_ENV]).toMatch(/^[\da-f]{64}$/u);
    });

    it('reuses the persisted local MCP token across server restarts', async () => {
        vi.stubEnv('EVB_MCP_PORT', String(await findFreePort()));
        vi.stubEnv(ASSISTANT_MCP_TOKEN_ENV, '');

        await startLocalMcpServer();
        const firstToken = process.env[ASSISTANT_MCP_TOKEN_ENV];

        await shutdownLocalMcpServer();
        expect(process.env[ASSISTANT_MCP_TOKEN_ENV]).toBeUndefined();

        await startLocalMcpServer();

        expect(process.env[ASSISTANT_MCP_TOKEN_ENV]).toBe(firstToken);
    });

    it('builds authenticated external MCP setup snippets through the stdio proxy transport', async () => {
        vi.stubEnv(ASSISTANT_MCP_TOKEN_ENV, '');

        const {
            descriptor,
            launchConfig,
            token,
        } = await getLocalMcpCodexRegistrationTransport();
        const snippets = await getLocalMcpSetupSnippets();
        const cursorConfig = JSON.parse(snippets.cursor) as {mcpServers: Record<string, {
            command: string;
            args: string[];
            env: Record<string, string>;
        }>;};

        expect(launchConfig.command).toBe(process.execPath);
        expect(launchConfig.args).toEqual(['/tmp/app-root/scripts/evb-mcp-proxy.mjs']);
        expect(launchConfig.env).toMatchObject({
            ELECTRON_RUN_AS_NODE: '1',
            EVB_MCP_URL: descriptor.url,
            EVB_MCP_TOKEN: token,
        });
        expect(snippets.codex).toContain('codex mcp add');
        expect(snippets.codex).toContain('EVB_MCP_TOKEN=');
        expect(snippets.claude).toContain('claude mcp add');
        expect(cursorConfig.mcpServers[descriptor.name]).toEqual({
            command: process.execPath,
            args: ['/tmp/app-root/scripts/evb-mcp-proxy.mjs'],
            env: {
                ELECTRON_RUN_AS_NODE: '1',
                EVB_MCP_URL: descriptor.url,
                EVB_MCP_TOKEN: token,
            },
        });
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
        expect(JSON.stringify(initialized?.result)).toContain('evb_run_action');
        expect(JSON.stringify(initialized?.result)).toContain('evb_read_action');
        expect(JSON.stringify(initialized?.result)).toContain('document.search');
        expect(JSON.stringify(tools?.result)).toContain('evb_workspace_snapshot');
        expect(JSON.stringify(tools?.result)).toContain('evb_viewer_open_documents');
        expect(JSON.stringify(tools?.result)).toContain('evb_viewer_search_open_document');
        expect(JSON.stringify(tools?.result)).toContain('evb_search_document');
        expect(JSON.stringify(tools?.result)).toContain('readOnlyHint');
        expect(JSON.stringify(tools?.result)).toContain('evb_go_to_page');
        expect(JSON.stringify(initialized?.result)).toContain('document.capture_page_image');

        const initializedJson = JSON.stringify(initialized?.result);
        expect(initializedJson).toContain('Internal write capabilities with policy.internal = allow');
        expect(initializedJson).not.toContain('document.capture_page_image, page_labels.preview');

        const runActionTool = (tools?.result as IListToolsResult).tools?.find(tool => tool.name === 'evb_run_action');
        expect(runActionTool?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        });
        const readActionTool = (tools?.result as IListToolsResult).tools?.find(tool => tool.name === 'evb_read_action');
        expect(readActionTool?.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        });
    });

    it('keeps external action metadata destructive and explicit about confirmation blocks', async () => {
        const options = {
            ...createOptions(),
            callerKind: 'external' as const,
        };

        const initialized = await processMcpRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {protocolVersion: '2025-11-25'},
        }, options);
        const tools = await processMcpRequest({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
        }, options);

        expect(JSON.stringify(initialized?.result)).toContain('policy.external is confirm are blocked');
        const runActionTool = (tools?.result as IListToolsResult).tools?.find(tool => tool.name === 'evb_run_action');
        expect(runActionTool?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
        });
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
            workspaceMode: 'open-document',
            documentCount: 1,
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
            recentFileCount: 1,
            recentFiles: [{
                fileName: 'Recent Grammar.pdf',
                originalPath: '/tmp/Recent Grammar.pdf',
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

    it('exposes text-markup annotation creation as a discoverable capability', async () => {
        const options = createOptions();
        const shapeTools = [
            'draw',
            'rectangle',
            'circle',
            'line',
            'arrow',
        ];

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'annotation-capabilities',
            method: 'tools/call',
            params: {
                name: 'evb_list_capabilities',
                arguments: {
                    domain: 'annotation',
                    detail: 'full',
                },
            },
        }, options);

        expect(response?.result).toMatchObject({structuredContent: {
            domain: 'annotation',
            capabilities: expect.arrayContaining([
                expect.objectContaining({
                    id: 'annotation.create_text_markup',
                    risk: 'write',
                    inputSchema: expect.objectContaining({
                        required: ['text'],
                        properties: expect.objectContaining({
                            text: expect.objectContaining({type: 'string'}),
                            page: expect.objectContaining({type: 'number'}),
                            markup: expect.objectContaining({enum: [
                                'highlight',
                                'underline',
                                'strikethrough',
                                'squiggly',
                            ]}),
                        }),
                    }),
                }),
                expect.objectContaining({
                    id: 'annotation.create_note_at_point',
                    inputSchema: expect.objectContaining({properties: expect.objectContaining({
                        pageX: expect.objectContaining({type: 'number'}),
                        pageY: expect.objectContaining({type: 'number'}),
                    })}),
                }),
                expect.objectContaining({
                    id: 'annotation.create_shape',
                    inputSchema: expect.objectContaining({
                        properties: expect.objectContaining({shape: expect.objectContaining({enum: shapeTools})}),
                        required: ['shape'],
                    }),
                }),
                expect.objectContaining({
                    id: 'annotation.update_note',
                    inputSchema: expect.objectContaining({required: ['text']}),
                }),
                expect.objectContaining({
                    id: 'annotation.update_text_markup_color',
                    inputSchema: expect.objectContaining({required: ['color']}),
                }),
            ]),
        }});
    });

    it('lists capabilities compactly by default and keeps schemas behind full detail or describe', async () => {
        const options = createOptions();

        const compactResponse = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'compact-file-capabilities',
            method: 'tools/call',
            params: {
                name: 'evb_list_capabilities',
                arguments: {domain: 'file'},
            },
        }, options);
        const fullResponse = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'full-file-capabilities',
            method: 'tools/call',
            params: {
                name: 'evb_list_capabilities',
                arguments: {
                    domain: 'file',
                    detail: 'full',
                },
            },
        }, options);
        const describeResponse = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'describe-repair-save',
            method: 'tools/call',
            params: {
                name: 'evb_describe_capability',
                arguments: {id: 'file.repair_save'},
            },
        }, options);

        expect(compactResponse?.result).toMatchObject({structuredContent: {
            detail: 'compact',
            capabilities: expect.arrayContaining([
                expect.objectContaining({
                    id: 'file.repair_save',
                    risk: 'longRunning',
                    hasInputSchema: true,
                    hasOutputSchema: true,
                }),
                expect.objectContaining({
                    id: 'file.optimize_for_interaction',
                    risk: 'longRunning',
                }),
            ]),
        }});
        expect(JSON.stringify(compactResponse?.result)).not.toContain('inputSchema');
        expect(fullResponse?.result).toMatchObject({structuredContent: {
            detail: 'full',
            capabilities: expect.arrayContaining([expect.objectContaining({
                id: 'file.repair_save',
                inputSchema: expect.objectContaining({additionalProperties: false}),
            })]),
        }});
        expect(describeResponse?.result).toMatchObject({structuredContent: {capability: expect.objectContaining({
            id: 'file.repair_save',
            inputSchema: expect.objectContaining({additionalProperties: false}),
        })}});
    });

    it('exposes repair, optimize, crop, remove-crop, and history as semantic capabilities', async () => {
        const options = createOptions();

        const [
            fileResponse,
            pageOpsResponse,
            historyResponse,
        ] = await Promise.all([
            processMcpRequest({
                jsonrpc: '2.0',
                id: 'file-capabilities',
                method: 'tools/call',
                params: {
                    name: 'evb_list_capabilities',
                    arguments: {
                        domain: 'file',
                        detail: 'full',
                    },
                },
            }, options),
            processMcpRequest({
                jsonrpc: '2.0',
                id: 'page-op-capabilities',
                method: 'tools/call',
                params: {
                    name: 'evb_list_capabilities',
                    arguments: {
                        domain: 'page_ops',
                        detail: 'full',
                    },
                },
            }, options),
            processMcpRequest({
                jsonrpc: '2.0',
                id: 'history-capabilities',
                method: 'tools/call',
                params: {
                    name: 'evb_list_capabilities',
                    arguments: {
                        domain: 'history',
                        detail: 'full',
                    },
                },
            }, options),
        ]);

        expect(fileResponse?.result).toMatchObject({structuredContent: {capabilities: expect.arrayContaining([
            expect.objectContaining({
                id: 'file.repair_save',
                risk: 'longRunning',
            }),
            expect.objectContaining({
                id: 'file.optimize_for_interaction',
                risk: 'longRunning',
            }),
        ])}});
        expect(pageOpsResponse?.result).toMatchObject({structuredContent: {capabilities: expect.arrayContaining([
            expect.objectContaining({
                id: 'page_ops.crop',
                inputSchema: expect.objectContaining({required: [
                    'pages',
                    'margins',
                ]}),
            }),
            expect.objectContaining({
                id: 'page_ops.remove_crop',
                inputSchema: expect.objectContaining({required: ['pages']}),
            }),
        ])}});
        expect(historyResponse?.result).toMatchObject({structuredContent: {
            capabilityCount: 2,
            capabilities: expect.arrayContaining([
                expect.objectContaining({id: 'history.undo'}),
                expect.objectContaining({id: 'history.redo'}),
            ]),
        }});
    });

    it('normalizes compatibility aliases without advertising them as public capabilities', async () => {
        const options = createOptions();

        const compactResponse = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'all-capabilities',
            method: 'tools/call',
            params: {
                name: 'evb_list_capabilities',
                arguments: {},
            },
        }, options);
        const describeAliasResponse = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'describe-page-numbering',
            method: 'tools/call',
            params: {
                name: 'evb_describe_capability',
                arguments: {id: 'page_numbering.preview'},
            },
        }, options);
        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'run-annotation-alias',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    id: 'annotation.set_tool',
                    input: {tool: 'highlight'},
                },
            },
        }, options);

        expect(JSON.stringify(compactResponse?.result)).not.toContain('page_numbering.preview');
        expect(JSON.stringify(compactResponse?.result)).not.toContain('annotation.set_tool');
        expect(describeAliasResponse?.result).toMatchObject({structuredContent: {
            requestedId: 'page_numbering.preview',
            capability: expect.objectContaining({id: 'page_labels.preview'}),
        }});
        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                id: 'annotation.select_tool',
                input: {tool: 'highlight'},
            },
        }, undefined);
    });

    it('dispatches text-markup annotation creation through run action', async () => {
        const options = createOptions();

        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'create-markup',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'annotation.create_text_markup',
                    input: {
                        page: 12,
                        text: 'broken plural',
                        markup: 'underline',
                        occurrence: 2,
                    },
                },
            },
        }, options);

        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'annotation.create_text_markup',
                input: {
                    page: 12,
                    text: 'broken plural',
                    markup: 'underline',
                    occurrence: 2,
                },
            },
        }, undefined);
    });

    it('blocks external run action calls that require confirmation', async () => {
        const options = {
            ...createOptions(),
            callerKind: 'external' as const,
        };

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'create-markup',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'annotation.create_text_markup',
                    input: {
                        page: 12,
                        text: 'broken plural',
                        markup: 'underline',
                    },
                },
            },
        }, options);

        expect(response?.error).toMatchObject({
            code: -32603,
            message: 'Capability annotation.create_text_markup requires explicit user confirmation for external MCP callers.',
        });
        expect(options.runCommand).not.toHaveBeenCalled();
    });

    it('allows external read-only run action calls', async () => {
        const options = {
            ...createOptions(),
            callerKind: 'external' as const,
        };

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'open-documents',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {id: 'document.open_documents'},
            },
        }, options);

        expect(response?.error).toBeUndefined();
        expect(response?.result).toMatchObject({structuredContent: {
            hasOpenDocument: true,
            documentCount: 1,
        }});
    });

    it('dispatches bookmark previews through the read-only action tool', async () => {
        const options = {
            ...createOptions(),
            callerKind: 'external' as const,
        };
        const bookmarkPlanInput = {entries: [{
            level: 1,
            title: 'Chapter 1',
            page: 5,
        }]};

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'preview-bookmarks',
            method: 'tools/call',
            params: {
                name: 'evb_read_action',
                arguments: {
                    windowId: 42,
                    tabId: 'tab-1',
                    id: 'bookmarks.preview_tree',
                    input: bookmarkPlanInput,
                },
            },
        }, options);

        expect(response?.error).toBeUndefined();
        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'bookmarks.preview_tree',
                input: bookmarkPlanInput,
            },
        }, 42);
    });

    it('rejects non-read capabilities on the read-only action tool', async () => {
        const options = createOptions();

        const writeResponse = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'apply-bookmarks-through-read-tool',
            method: 'tools/call',
            params: {
                name: 'evb_read_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'bookmarks.apply_plan',
                    input: {entries: []},
                },
            },
        }, options);
        const destructiveResponse = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'delete-bookmarks-through-read-tool',
            method: 'tools/call',
            params: {
                name: 'evb_read_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'bookmarks.delete',
                    input: {path: [0]},
                },
            },
        }, options);

        expect(writeResponse?.error).toMatchObject({
            code: -32603,
            message: 'Capability bookmarks.apply_plan is write; use evb_run_action for non-read capabilities.',
        });
        expect(destructiveResponse?.error).toMatchObject({
            code: -32603,
            message: 'Capability bookmarks.delete is destructive; use evb_run_action for non-read capabilities.',
        });
        expect(options.runCommand).not.toHaveBeenCalled();
    });

    it('keeps external bookmark writes blocked without confirmation', async () => {
        const options = {
            ...createOptions(),
            callerKind: 'external' as const,
        };

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'external-apply-bookmarks',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'bookmarks.apply_plan',
                    input: {entries: []},
                },
            },
        }, options);

        expect(response?.error).toMatchObject({
            code: -32603,
            message: 'Capability bookmarks.apply_plan requires explicit user confirmation for external MCP callers.',
        });
        expect(options.runCommand).not.toHaveBeenCalled();
    });

    it('allows internal bookmark writes to reach renderer dispatch', async () => {
        const options = createOptions();
        const bookmarkPlanInput = {entries: [{
            level: 1,
            title: 'Chapter 1',
            page: 5,
        }]};

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'internal-apply-bookmarks',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    windowId: 42,
                    tabId: 'tab-1',
                    id: 'bookmarks.apply_plan',
                    input: bookmarkPlanInput,
                },
            },
        }, options);

        expect(response?.error).toBeUndefined();
        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'bookmarks.apply_plan',
                input: bookmarkPlanInput,
            },
        }, 42);
    });

    it('exposes page-label and bookmark editing capabilities', async () => {
        const options = createOptions();

        const [
            pageLabelsResponse,
            bookmarksResponse,
        ] = await Promise.all([
            processMcpRequest({
                jsonrpc: '2.0',
                id: 'page-label-capabilities',
                method: 'tools/call',
                params: {
                    name: 'evb_list_capabilities',
                    arguments: {
                        domain: 'page_labels',
                        detail: 'full',
                    },
                },
            }, options),
            processMcpRequest({
                jsonrpc: '2.0',
                id: 'bookmark-capabilities',
                method: 'tools/call',
                params: {
                    name: 'evb_list_capabilities',
                    arguments: {
                        domain: 'bookmarks',
                        detail: 'full',
                    },
                },
            }, options),
        ]);

        expect(pageLabelsResponse?.result).toMatchObject({structuredContent: {
            domain: 'page_labels',
            capabilities: expect.arrayContaining([
                expect.objectContaining({
                    id: 'page_labels.set_ranges',
                    inputSchema: expect.objectContaining({required: ['ranges']}),
                }),
                expect.objectContaining({
                    id: 'page_labels.preview',
                    inputSchema: expect.objectContaining({properties: expect.objectContaining({segments: expect.objectContaining({type: 'array'})})}),
                }),
                expect.objectContaining({id: 'page_labels.apply_plan'}),
                expect.objectContaining({id: 'page_labels.apply_range'}),
                expect.objectContaining({id: 'page_labels.set_labels'}),
            ]),
        }});
        expect(bookmarksResponse?.result).toMatchObject({structuredContent: {
            domain: 'bookmarks',
            capabilities: expect.arrayContaining([
                expect.objectContaining({
                    id: 'bookmarks.preview_tree',
                    inputSchema: expect.objectContaining({properties: expect.objectContaining({entries: expect.objectContaining({type: 'array'})})}),
                }),
                expect.objectContaining({id: 'bookmarks.apply_plan'}),
                expect.objectContaining({id: 'bookmarks.set_tree'}),
                expect.objectContaining({id: 'bookmarks.add'}),
                expect.objectContaining({id: 'bookmarks.add_batch'}),
                expect.objectContaining({
                    id: 'bookmarks.update',
                    inputSchema: expect.objectContaining({required: ['path']}),
                }),
                expect.objectContaining({
                    id: 'bookmarks.delete',
                    inputSchema: expect.objectContaining({required: ['path']}),
                }),
            ]),
        }});
    });

    it('exposes visual page capture as a document verification capability', async () => {
        const options = createOptions();

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'document-capabilities',
            method: 'tools/call',
            params: {
                name: 'evb_list_capabilities',
                arguments: {
                    domain: 'document',
                    detail: 'full',
                },
            },
        }, options);

        expectStructuredCloneable(response);
        expect(response?.result).toMatchObject({structuredContent: {
            domain: 'document',
            capabilities: expect.arrayContaining([expect.objectContaining({
                id: 'document.capture_page_image',
                risk: 'navigate',
                inputSchema: expect.objectContaining({properties: expect.objectContaining({
                    page: expect.objectContaining({type: 'number'}),
                    region: expect.objectContaining({enum: expect.arrayContaining([
                        'full',
                        'top',
                        'bottom',
                    ])}),
                })}),
            })]),
        }});
    });

    it('returns MCP image content for rendered page capture results', async () => {
        const options = createOptions();
        options.runCommand.mockResolvedValueOnce({
            ok: true,
            actionId: 'document.capture_page_image',
            pageNumber: 4,
            image: {
                mimeType: 'image/png',
                sizeBytes: 3,
                data: 'aW1n',
            },
        });

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'capture-page',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'document.capture_page_image',
                    input: {
                        page: 4,
                        region: 'top',
                    },
                },
            },
        }, options);

        expectStructuredCloneable(response);
        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'document.capture_page_image',
                input: {
                    page: 4,
                    region: 'top',
                },
            },
        }, undefined);
        expect(response?.result).toMatchObject({
            structuredContent: {image: {
                mimeType: 'image/png',
                sizeBytes: 3,
            }},
            content: expect.arrayContaining([expect.objectContaining({
                type: 'image',
                mimeType: 'image/png',
                data: 'aW1n',
            })]),
        });
        const result = response?.result as {
            content?: Array<{
                type: string;
                text?: string;
            }>;
            structuredContent?: unknown;
        };
        expect(JSON.stringify(result.structuredContent)).not.toContain('"data":"aW1n"');
        expect(result.content?.find(item => item.type === 'text')?.text).not.toContain('"data"');
    });

    it('dispatches page-label and bookmark mutations through run action', async () => {
        const options = createOptions();
        const pageLabelPlanInput = {segments: [{
            startPage: 1,
            endPage: 4,
            style: 'roman-lower',
        }]};
        const bookmarkBatchInput = {bookmarks: [{
            title: 'Chapter 1',
            page: 5,
            items: [{
                title: 'Section 1.1',
                page: 6,
            }],
        }]};
        const bookmarkPlanInput = {entries: [
            {
                level: 1,
                title: 'Chapter 1',
                page: 5,
            },
            {
                level: 2,
                title: 'Section 1.1',
                page: 6,
            },
        ]};

        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'preview-page-labels',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'page_labels.preview',
                    input: pageLabelPlanInput,
                },
            },
        }, options);
        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'apply-page-label-plan',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'page_labels.apply_plan',
                    input: pageLabelPlanInput,
                },
            },
        }, options);
        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'set-page-labels',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'page_labels.apply_range',
                    input: {
                        startPage: 1,
                        endPage: 4,
                        style: 'r',
                        prefix: '',
                        startNumber: 1,
                    },
                },
            },
        }, options);
        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'preview-bookmarks',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'bookmarks.preview_tree',
                    input: bookmarkPlanInput,
                },
            },
        }, options);
        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'apply-bookmark-plan',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'bookmarks.apply_plan',
                    input: bookmarkPlanInput,
                },
            },
        }, options);
        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'add-bookmarks',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    tabId: 'tab-1',
                    id: 'bookmarks.add_batch',
                    input: bookmarkBatchInput,
                },
            },
        }, options);

        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'page_labels.preview',
                input: pageLabelPlanInput,
            },
        }, undefined);
        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'page_labels.apply_plan',
                input: pageLabelPlanInput,
            },
        }, undefined);
        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'page_labels.apply_range',
                input: {
                    startPage: 1,
                    endPage: 4,
                    style: 'r',
                    prefix: '',
                    startNumber: 1,
                },
            },
        }, undefined);
        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'bookmarks.preview_tree',
                input: bookmarkPlanInput,
            },
        }, undefined);
        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'bookmarks.apply_plan',
                input: bookmarkPlanInput,
            },
        }, undefined);
        expect(options.runCommand).toHaveBeenCalledWith({
            name: 'run_action',
            arguments: {
                tabId: 'tab-1',
                id: 'bookmarks.add_batch',
                input: bookmarkBatchInput,
            },
        }, undefined);
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

    it('clamps document page reads to the target tab page count before expansion', async () => {
        const options = createOptions();

        await processMcpRequest({
            jsonrpc: '2.0',
            id: 'read-clamped-pages',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    id: 'document.read_pages',
                    input: {
                        startPage: 1,
                        endPage: 1000,
                    },
                },
            },
        }, options);

        expect(options.readDocumentPages).toHaveBeenCalledWith({
            tab: workspaceSnapshot.tabs[0],
            options: {pages: Array.from({length: 25}, (_value, index) => index + 1)},
        }, undefined);
    });

    it('rejects document page reads that exceed the MCP page budget', async () => {
        const options = createOptions();
        options.getWorkspaceSnapshot.mockResolvedValueOnce({
            ...workspaceSnapshot,
            tabs: [{
                ...workspaceSnapshot.tabs[0]!,
                totalPages: 1000,
            }],
        });

        const response = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'read-too-many-pages',
            method: 'tools/call',
            params: {
                name: 'evb_run_action',
                arguments: {
                    id: 'document.read_pages',
                    input: {
                        startPage: 1,
                        endPage: 1000,
                    },
                },
            },
        }, options);

        expect(response?.error).toMatchObject({
            code: -32603,
            message: 'Too many pages requested; maximum is 50.',
        });
        expect(options.readDocumentPages).not.toHaveBeenCalled();
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
        const pageNumberingPrompt = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'page-numbering-prompt',
            method: 'prompts/get',
            params: {name: 'evb_number_pages_from_printed_pages'},
        }, options);
        const bookmarkPrompt = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'bookmark-prompt',
            method: 'prompts/get',
            params: {name: 'evb_rebuild_verified_bookmarks'},
        }, options);
        const largeDocumentPrompt = await processMcpRequest({
            jsonrpc: '2.0',
            id: 'large-document-prompt',
            method: 'prompts/get',
            params: {name: 'evb_large_document_strategy'},
        }, options);

        expect(JSON.stringify(resources?.result)).toContain('evb://workspace/current');
        expect(JSON.stringify(resources?.result)).toContain('evb://document/tab-1/bookmarks');
        expect(JSON.stringify(resources?.result)).toContain('evb://document/tab-1/page-labels');
        expect(pageText?.result).toMatchObject({contents: [{
            uri: 'evb://document/tab-1/page/7',
            mimeType: 'text/plain',
            text: 'Page 7 text',
        }]});
        expect(JSON.stringify(prompt?.result)).toContain('seventh stem tables');
        expect(JSON.stringify(prompt?.result)).toContain('document.search');
        expect(JSON.stringify(pageNumberingPrompt?.result)).toContain('page_labels.preview');
        expect(JSON.stringify(pageNumberingPrompt?.result)).toContain('page_labels.apply_plan');
        expect(JSON.stringify(pageNumberingPrompt?.result)).toContain('document.capture_page_image');
        expect(JSON.stringify(pageNumberingPrompt?.result)).toContain('file.save');
        expect(JSON.stringify(bookmarkPrompt?.result)).toContain('bookmarks.preview_tree');
        expect(JSON.stringify(bookmarkPrompt?.result)).toContain('bookmarks.apply_plan');
        expect(JSON.stringify(bookmarkPrompt?.result)).toContain('file.save');
        expect(JSON.stringify(largeDocumentPrompt?.result)).toContain('bounded probes');
        expect(JSON.stringify(largeDocumentPrompt?.result)).toContain('document.read_pages');
        expect(JSON.stringify(largeDocumentPrompt?.result)).toContain('requested-pages');
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
