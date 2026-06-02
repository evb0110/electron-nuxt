#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';

const MCP_PROTOCOL_VERSION = '2025-11-25';
const DEFAULT_EVB_MCP_HOST = '127.0.0.1';
const DEFAULT_EVB_MCP_PORT = '38672';
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_INTERNAL_ERROR = -32603;
const EVB_MCP_URL = resolveTargetUrl();
const PACKAGE_METADATA = readPackageMetadata();

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
const CAPABILITY_DOMAIN_SCHEMA = {
    type: 'string',
    enum: [
        'workspace',
        'document',
        'annotation',
        'toc',
        'page_labels',
        'bookmarks',
        'ocr',
        'ui',
        'view',
        'file',
        'export',
        'pageOps',
    ],
    description: 'Optional capability domain filter.',
};
const CAPABILITY_ID_SCHEMA = {
    type: 'string',
    description: 'Stable EVB capability id, for example document.search, annotation.open_note, page_labels.apply_range, bookmarks.add, ocr.start, or ocr.open_popup.',
};
const RESOURCE_URI_SCHEMA = {
    type: 'string',
    description: 'EVB resource URI such as evb://document/{tabId}/annotations, /bookmarks, /page-labels, or /toc.',
};

const EVB_MCP_TOOLS = [
    {
        name: 'evb_list_capabilities',
        title: 'EVB Viewer list capabilities',
        description: 'List semantic EVB Viewer capabilities for the current workspace or a specific tab. Use this to discover annotation, note, bookmark, page-label, OCR, UI, file, export, page, search, and navigation actions without bloating the top-level MCP tool list.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: TAB_ID_SCHEMA,
                domain: CAPABILITY_DOMAIN_SCHEMA,
            },
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_describe_capability',
        title: 'EVB Viewer describe capability',
        description: 'Describe one EVB Viewer capability, including its input schema, side-effect risk, availability, policy, and related resource templates. Call evb_list_capabilities first when the id is unknown.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: TAB_ID_SCHEMA,
                id: CAPABILITY_ID_SCHEMA,
            },
            required: ['id'],
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_read_resource',
        title: 'EVB Viewer read resource',
        description: 'Read an EVB resource URI as JSON or text. Useful resources include workspace/current, document page text, text status, annotations, notes, TOC/bookmarks, and page labels.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                uri: RESOURCE_URI_SCHEMA,
            },
            required: ['uri'],
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_run_action',
        title: 'EVB Viewer run action',
        description: 'Run a semantic EVB Viewer action by capability id. Use evb_describe_capability to inspect the expected input. For write, destructive, or long-running actions, prefer dryRun first when available.',
        inputSchema: {
            type: 'object',
            properties: {
                windowId: WINDOW_ID_SCHEMA,
                tabId: TAB_ID_SCHEMA,
                id: CAPABILITY_ID_SCHEMA,
                input: {
                    type: 'object',
                    description: 'Capability-specific input object.',
                    additionalProperties: true,
                },
                dryRun: {
                    type: 'boolean',
                    description: 'Validate and preview without mutating visible app state when supported.',
                },
            },
            required: ['id'],
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: UI_NAVIGATION_ANNOTATIONS,
    },
    {
        name: 'evb_job_status',
        title: 'EVB Viewer job status',
        description: 'Read status for a long-running EVB action job if an action returned a job id. OCR progress is exposed through capability ocr.status; current EVB MCP jobs are otherwise not tracked here.',
        inputSchema: {
            type: 'object',
            properties: {jobId: {
                type: 'string',
                description: 'Optional job id returned by evb_run_action.',
            }},
            additionalProperties: false,
        },
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        annotations: READ_ONLY_CLOSED_ANNOTATIONS,
    },
    {
        name: 'evb_workspace_snapshot',
        title: 'EVB Viewer workspace snapshot',
        description: 'Fast read of the current EVB Viewer workspace: panes, tabs, active tab, layout tree, page numbers, document kinds, and preparation recommendations. Use this first to discover what is open in EVB Viewer / evb-viewer.',
        inputSchema: {
            type: 'object',
            properties: { windowId: WINDOW_ID_SCHEMA },
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
            properties: { windowId: WINDOW_ID_SCHEMA },
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
                    items: { type: 'number' },
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
];

const EVB_MCP_RESOURCE_TEMPLATES = [
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
    {
        name: 'evb_document_ocr_status',
        title: 'EVB PDF OCR status',
        uriTemplate: 'evb://document/{tabId}/ocr-status',
        description: 'Read OCR/searchable-text status for an open PDF tab. Alias of text status for agents thinking in OCR terms.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_annotations',
        title: 'EVB PDF annotations',
        uriTemplate: 'evb://document/{tabId}/annotations',
        description: 'Read annotation summaries, stable keys, pages, subtype, colors, and note flags for an open EVB Viewer document.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_notes',
        title: 'EVB PDF notes',
        uriTemplate: 'evb://document/{tabId}/notes',
        description: 'Read note-bearing annotation summaries plus open note-window state for an open EVB Viewer document.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_toc',
        title: 'EVB PDF table of contents',
        uriTemplate: 'evb://document/{tabId}/toc',
        description: 'Read the document TOC/bookmarks when present, including titles and one-based page numbers.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_bookmarks',
        title: 'EVB PDF bookmarks',
        uriTemplate: 'evb://document/{tabId}/bookmarks',
        description: 'Read editable PDF bookmarks as a nested tree with zero-based paths and one-based page numbers.',
        mimeType: 'application/json',
    },
    {
        name: 'evb_document_page_labels',
        title: 'EVB PDF page labels',
        uriTemplate: 'evb://document/{tabId}/page-labels',
        description: 'Read PDF page numbering ranges and materialized page labels for an open EVB Viewer document.',
        mimeType: 'application/json',
    },
];

const EVB_MCP_PROMPTS = [
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
];

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
    inputBuffer = Buffer.concat([
        inputBuffer,
        chunk,
    ]);
    void processInputBuffer();
});
process.stdin.on('error', (error) => {
    writeDiagnostic(`stdin error: ${getErrorMessage(error)}`);
});
process.stdin.on('end', () => {
    process.exit(0);
});

function resolveTargetUrl() {
    const urlArgIndex = process.argv.indexOf('--url');
    if (urlArgIndex >= 0 && process.argv[urlArgIndex + 1]) {
        return process.argv[urlArgIndex + 1];
    }
    if (process.env.EVB_MCP_URL) {
        return process.env.EVB_MCP_URL;
    }
    const host = process.env.EVB_MCP_HOST || DEFAULT_EVB_MCP_HOST;
    const port = process.env.EVB_MCP_PORT || DEFAULT_EVB_MCP_PORT;
    return `http://${host}:${port}`;
}

function readPackageMetadata() {
    try {
        const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return {
            name: typeof packageJson.name === 'string' ? packageJson.name.replaceAll(/[^a-zA-Z0-9_]/gu, '_') : 'evb_viewer',
            version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
        };
    } catch {
        return {
            name: 'evb_viewer',
            version: '0.0.0',
        };
    }
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getJsonRpcId(value) {
    return typeof value === 'string' || typeof value === 'number' || value === null
        ? value
        : null;
}

function getRequestId(request) {
    return isRecord(request) ? getJsonRpcId(request.id) : null;
}

function createResultResponse(id, result) {
    return {
        jsonrpc: '2.0',
        id,
        result,
    };
}

function createErrorResponse(id, code, message, data) {
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

function createToolResult(data, options = {}) {
    return {
        content: [{
            type: 'text',
            text: JSON.stringify(data, null, 2),
        }],
        structuredContent: data,
        ...(options.isError ? { isError: true } : {}),
    };
}

function getClientProtocolVersion(params) {
    if (!isRecord(params) || typeof params.protocolVersion !== 'string') {
        return MCP_PROTOCOL_VERSION;
    }
    return params.protocolVersion.trim() || MCP_PROTOCOL_VERSION;
}

function createInitializeInstructions() {
    return [
        'EVB Viewer exposes the live PDF workspace. If the user mentions EVB Viewer, evb-viewer, the viewer app, the open document, or the current PDF, use these MCP tools before inspecting processes, files, windows, or debug ports.',
        'Prefer the compact capability workflow for broad app control: call evb_workspace_snapshot, then evb_list_capabilities, evb_describe_capability when needed, evb_read_resource for notes/annotations/bookmarks/page-labels/page text, and evb_run_action for visible app actions.',
        'For questions like "what document is open in evb-viewer?", call evb_viewer_open_documents. Use evb_workspace_snapshot when you need the full pane/tab/layout tree.',
        'For questions like "find X in this PDF" or "navigate to X", use capability document.search or the compatibility tools evb_viewer_search_open_document / evb_search_document. They use EVB Viewer search indexes and return page numbers plus excerpts.',
        'After search, read candidate pages with capability document.read_pages, evb_read_resource, or evb_read_document_pages, then navigate with capability view.go_to_page or evb_go_to_page only after choosing the best page.',
        'For annotations, notes, bookmarks, and page labels, read evb://document/{tabId}/annotations, /notes, /bookmarks, /toc, and /page-labels through evb_read_resource or MCP resources/read. To create annotation content directly, use annotation.create_text_markup, annotation.create_note_at_point, and annotation.create_shape; use annotation.update_note and annotation.update_text_markup_color for existing annotations. For document metadata, use page_labels.set_ranges/apply_range/set_labels and bookmarks.set_tree/add/add_batch/update/delete for individual or batch edits.',
        'For OCR, use capability ocr.status to inspect visible OCR state, ocr.open_popup to show controls, and ocr.start only when the user has explicitly asked to run OCR or has approved the capability policy.',
        'For write, destructive, or long-running actions, inspect the capability policy and prefer dryRun before mutating visible app state.',
        'If a PDF page has no text or search misses likely visual/OCR content, call evb_inspect_document_text and recommend OCR all pages when coverage is partial or none.',
        'For DjVu or image documents, tell the user to convert to PDF before deep text analysis.',
    ].join('\n');
}

function createInitializeMetadata() {
    return { evb: {
        appName: 'EVB Viewer Dev',
        isProxy: true,
        targetUrl: EVB_MCP_URL,
    } };
}

function createInitializeResult(params) {
    return {
        protocolVersion: getClientProtocolVersion(params),
        capabilities: {
            tools: { listChanged: false },
            resources: {
                subscribe: false,
                listChanged: false,
            },
            prompts: { listChanged: false },
        },
        serverInfo: {
            name: 'evb_viewer_dev',
            title: 'EVB Viewer Dev',
            version: PACKAGE_METADATA.version,
        },
        instructions: createInitializeInstructions(),
        _meta: createInitializeMetadata(),
    };
}

function getParamsObject(params) {
    return isRecord(params) ? params : {};
}

function getPromptName(params) {
    const name = getParamsObject(params).name;
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('prompts/get requires params.name.');
    }
    return name.trim();
}

function getPromptArgument(params, key) {
    const args = getParamsObject(params).arguments;
    if (!isRecord(args)) {
        return '';
    }
    const value = args[key];
    return typeof value === 'string' ? value.trim() : '';
}

function createPromptText(name, params) {
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

function getPrompt(params) {
    const name = getPromptName(params);
    const prompt = EVB_MCP_PROMPTS.find(candidate => candidate.name === name);
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

function createUnavailableToolResult(method, error) {
    return createToolResult({
        ok: false,
        error: 'EVB Viewer dev MCP endpoint is not reachable.',
        method,
        targetUrl: EVB_MCP_URL,
        details: getErrorMessage(error),
        suggestedAction: 'Start EVB Viewer Dev, enable Codex MCP in Settings, then retry the EVB Viewer MCP tool.',
    }, { isError: true });
}

async function forwardRequest(request) {
    const response = await fetch(EVB_MCP_URL, {
        method: 'POST',
        headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(120000),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }
    if (!text.trim()) {
        return null;
    }
    return JSON.parse(text);
}

async function processMcpRequest(rawRequest) {
    if (Array.isArray(rawRequest)) {
        const responses = (await Promise.all(rawRequest.map(processMcpRequest)))
            .filter(response => response !== null);
        return responses.length === 0 ? null : responses;
    }

    if (!isRecord(rawRequest)) {
        return createErrorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC request.');
    }

    const id = getRequestId(rawRequest);
    const isNotification = rawRequest.id === undefined;
    const method = typeof rawRequest.method === 'string' ? rawRequest.method : '';

    if (!method) {
        return createErrorResponse(id, JSON_RPC_INVALID_REQUEST, 'JSON-RPC method is required.');
    }

    if (method === 'notifications/initialized') {
        return null;
    }

    try {
        if (method === 'initialize') {
            return createResultResponse(id, createInitializeResult(rawRequest.params));
        }

        if (method === 'ping') {
            return createResultResponse(id, {});
        }

        if (method === 'tools/list') {
            return createResultResponse(id, { tools: EVB_MCP_TOOLS });
        }

        if (method === 'resources/templates/list') {
            return createResultResponse(id, { resourceTemplates: EVB_MCP_RESOURCE_TEMPLATES });
        }

        if (method === 'prompts/list') {
            return createResultResponse(id, { prompts: EVB_MCP_PROMPTS });
        }

        if (method === 'prompts/get') {
            return createResultResponse(id, getPrompt(rawRequest.params));
        }

        const forwardedResponse = await forwardRequest(rawRequest);
        return forwardedResponse;
    } catch (error) {
        if (method === 'tools/call') {
            return createResultResponse(id, createUnavailableToolResult(method, error));
        }

        if (isNotification) {
            return null;
        }

        return createErrorResponse(id, JSON_RPC_INTERNAL_ERROR, getErrorMessage(error), {targetUrl: EVB_MCP_URL});
    }
}

async function processInputBuffer() {
    while (true) {
        const parsed = readNextMessage();
        if (!parsed) {
            return;
        }

        try {
            const rawRequest = JSON.parse(parsed);
            const response = await processMcpRequest(rawRequest);
            if (response !== null) {
                writeMessage(response);
            }
        } catch (error) {
            writeMessage(createErrorResponse(null, JSON_RPC_PARSE_ERROR, getErrorMessage(error)));
        }
    }
}

function readNextMessage() {
    if (inputBuffer.length === 0) {
        return null;
    }

    if (startsWithContentLengthHeader(inputBuffer)) {
        return readNextHeaderFramedMessage();
    }

    const lineEnd = inputBuffer.indexOf('\n');
    if (lineEnd < 0) {
        return null;
    }

    const line = inputBuffer.subarray(0, lineEnd).toString('utf8').replace(/\r$/u, '');
    inputBuffer = inputBuffer.subarray(lineEnd + 1);

    if (!line.trim()) {
        return readNextMessage();
    }

    return line;
}

function readNextHeaderFramedMessage() {
    const headerEnd = findHeaderEnd(inputBuffer);
    if (!headerEnd) {
        return null;
    }
    const headerText = inputBuffer.subarray(0, headerEnd.index).toString('utf8');
    const contentLengthMatch = /^Content-Length:\s*(\d+)$/imu.exec(headerText);
    if (!contentLengthMatch) {
        throw new Error('MCP stdio message is missing Content-Length header.');
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd.index + headerEnd.length;
    const bodyEnd = bodyStart + contentLength;
    if (inputBuffer.length < bodyEnd) {
        return null;
    }

    const body = inputBuffer.subarray(bodyStart, bodyEnd).toString('utf8');
    inputBuffer = inputBuffer.subarray(bodyEnd);
    return body;
}

function findHeaderEnd(buffer) {
    const crlfIndex = buffer.indexOf('\r\n\r\n');
    if (crlfIndex >= 0) {
        return {
            index: crlfIndex,
            length: 4,
        };
    }

    const lfIndex = buffer.indexOf('\n\n');
    if (lfIndex >= 0) {
        return {
            index: lfIndex,
            length: 2,
        };
    }

    return null;
}

function writeMessage(message) {
    const payload = JSON.stringify(message);
    process.stdout.write(`${payload}\n`);
}

function startsWithContentLengthHeader(buffer) {
    return buffer.subarray(0, Math.min(buffer.length, 16)).toString('ascii').toLowerCase().startsWith('content-length:');
}

function writeDiagnostic(message) {
    process.stderr.write(`[evb-mcp-proxy] ${message}\n`);
}

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
