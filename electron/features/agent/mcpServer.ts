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
    IAgentCapabilityDescriptor,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    TAgentCommand,
    TAgentCapabilityDomain,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import {
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

interface IMcpToolTextContent {
    type: 'text';
    text: string;
}

interface IMcpToolImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}

type TMcpToolContent = IMcpToolTextContent | IMcpToolImageContent;

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

interface IHttpHandlerOptions {bearerToken?: string | null;}

let localMcpServer: Server | null = null;
let embeddedMcpServer: Server | null = null;
let embeddedMcpServerDescriptor: ILocalMcpServerDescriptor | null = null;

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
    description: 'Stable EVB capability id, for example document.search, document.capture_page_image, annotation.open_note, page_labels.apply_range, bookmarks.add, ocr.start, or ocr.open_popup.',
};
const RESOURCE_URI_SCHEMA = {
    type: 'string',
    description: 'EVB resource URI such as evb://document/{tabId}/annotations, /bookmarks, /page-labels, or /toc.',
};

const MCP_TOOLS = [
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
        description: 'Fast read of the current EVB Viewer workspace: workspace mode, panes, tabs, active tab, recent files shown on the empty start page, page numbers, document kinds, and preparation recommendations. Use this first to discover what is open in EVB Viewer / evb-viewer.',
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
        description: 'Use this when the user asks what file, PDF, tab, or document is open in EVB Viewer, evb-viewer, or the viewer app. Empty tabs are reported as empty workspace state, not documents. Recent files are listed separately and are not open document contents.',
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
    {
        name: 'evb_number_pages_from_printed_pages',
        title: 'Number PDF pages from printed page numbers',
        description: 'Workflow for reconstructing page labels from printed paper-page numbers using OCR as a starting point and visual verification when uncertain.',
    },
    {
        name: 'evb_rebuild_verified_bookmarks',
        title: 'Rebuild verified PDF bookmarks',
        description: 'Workflow for reconstructing bookmarks from the existing TOC/bookmarks and verifying every target before writing.',
    },
] as const satisfies readonly IMcpPromptDefinition[];

type TCapabilityAvailabilityKind =
    | 'always'
    | 'document'
    | 'pdf'
    | 'pdf-path'
    | 'renderer-document'
    | 'renderer-pdf';
interface IAgentCapabilityTemplate extends Omit<IAgentCapabilityDescriptor, 'availability'> {availabilityKind: TCapabilityAvailabilityKind;}

const EMPTY_INPUT_SCHEMA = {
    type: 'object',
    properties: {},
    additionalProperties: false,
};
const TAB_INPUT_SCHEMA = {
    type: 'object',
    properties: {tabId: TAB_ID_SCHEMA},
    additionalProperties: false,
};
const PAGE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        tabId: TAB_ID_SCHEMA,
        page: {
            type: 'number',
            description: 'One-based page number.',
        },
    },
    required: ['page'],
    additionalProperties: false,
};
const SEARCH_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        tabId: TAB_ID_SCHEMA,
        query: {
            type: 'string',
            description: 'Text or regex query to search for in the PDF.',
        },
        maxResults: {
            type: 'number',
            description: 'Maximum results to return. Defaults to 25 and is capped at 100.',
        },
        matchCase: {type: 'boolean'},
        wholeWord: {type: 'boolean'},
        useRegex: {type: 'boolean'},
    },
    required: ['query'],
    additionalProperties: false,
};
const READ_PAGES_INPUT_SCHEMA = {
    type: 'object',
    properties: {
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
};
const CAPTURE_PAGE_IMAGE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        tabId: TAB_ID_SCHEMA,
        page: {
            type: 'number',
            description: 'One-based PDF page to capture. Defaults to the current page.',
        },
        pageNumber: {
            type: 'number',
            description: 'Alias for page.',
        },
        region: {
            type: 'string',
            enum: [
                'full',
                'top',
                'bottom',
                'left',
                'right',
                'center',
            ],
            description: 'Preset page region to capture when normalized crop coordinates are not supplied. Defaults to full.',
        },
        x: {
            type: 'number',
            description: 'Optional normalized left coordinate from 0 to 1.',
        },
        y: {
            type: 'number',
            description: 'Optional normalized top coordinate from 0 to 1.',
        },
        width: {
            type: 'number',
            description: 'Optional normalized crop width from 0 to 1.',
        },
        height: {
            type: 'number',
            description: 'Optional normalized crop height from 0 to 1.',
        },
    },
    additionalProperties: false,
};
const OPEN_SIDEBAR_TAB_INPUT_SCHEMA = {
    type: 'object',
    properties: {tab: {
        type: 'string',
        enum: [
            'annotations',
            'bookmarks',
            'thumbnails',
            'search',
        ],
    }},
    required: ['tab'],
    additionalProperties: false,
};
const ANNOTATION_REF_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        stableKey: {
            type: 'string',
            description: 'Stable annotation key from evb://document/{tabId}/annotations or /notes.',
        },
        annotationId: {type: 'string'},
        id: {type: 'string'},
    },
    additionalProperties: false,
};
const ANNOTATION_UPDATE_NOTE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        stableKey: {
            type: 'string',
            description: 'Stable annotation key from evb://document/{tabId}/annotations or /notes.',
        },
        annotationId: {type: 'string'},
        id: {type: 'string'},
        text: {
            type: 'string',
            description: 'New note text. Use an empty string to clear the note.',
        },
    },
    required: ['text'],
    additionalProperties: false,
};
const ANNOTATION_COLOR_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        stableKey: {
            type: 'string',
            description: 'Stable annotation key from evb://document/{tabId}/annotations or /notes.',
        },
        annotationId: {type: 'string'},
        id: {type: 'string'},
        color: {
            type: 'string',
            description: 'CSS color to apply to a text markup annotation, for example #ffd54f.',
        },
    },
    required: ['color'],
    additionalProperties: false,
};
const ANNOTATION_TOOL_INPUT_SCHEMA = {
    type: 'object',
    properties: {tool: {
        type: 'string',
        enum: [
            'none',
            'select',
            'highlight',
            'underline',
            'strikethrough',
            'squiggly',
            'text',
            'draw',
            'rectangle',
            'circle',
            'line',
            'arrow',
            'stamp',
        ],
    }},
    required: ['tool'],
    additionalProperties: false,
};
const ANNOTATION_TEXT_MARKUP_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        page: {
            type: 'number',
            description: 'One-based PDF page number containing the text. Defaults to the current page.',
        },
        pageNumber: {
            type: 'number',
            description: 'Alias for page.',
        },
        text: {
            type: 'string',
            description: 'Exact visible page text to mark. Use document.search/read_pages first when uncertain.',
        },
        query: {
            type: 'string',
            description: 'Alias for text.',
        },
        occurrence: {
            type: 'number',
            description: 'One-based occurrence of text on the page. Defaults to 1.',
        },
        markup: {
            type: 'string',
            enum: [
                'highlight',
                'underline',
                'strikethrough',
                'squiggly',
            ],
            description: 'Text markup to create. Defaults to highlight.',
        },
        tool: {
            type: 'string',
            enum: [
                'highlight',
                'underline',
                'strikethrough',
                'squiggly',
            ],
            description: 'Alias for markup.',
        },
        matchCase: {
            type: 'boolean',
            description: 'Whether text matching must preserve case exactly.',
        },
        caseSensitive: {
            type: 'boolean',
            description: 'Alias for matchCase.',
        },
        wholeWord: {
            type: 'boolean',
            description: 'Only match text on word boundaries.',
        },
        withNote: {
            type: 'boolean',
            description: 'Open a note on the created text markup, matching the user comment-selection workflow.',
        },
        openNote: {
            type: 'boolean',
            description: 'Alias for withNote.',
        },
    },
    required: ['text'],
    additionalProperties: false,
};
const ANNOTATION_POINT_NOTE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        page: {
            type: 'number',
            description: 'One-based PDF page number. Defaults to the current page.',
        },
        pageNumber: {
            type: 'number',
            description: 'Alias for page.',
        },
        pageX: {
            type: 'number',
            description: 'Normalized horizontal page coordinate from 0 to 1.',
        },
        pageY: {
            type: 'number',
            description: 'Normalized vertical page coordinate from 0 to 1.',
        },
        x: {
            type: 'number',
            description: 'Alias for pageX.',
        },
        y: {
            type: 'number',
            description: 'Alias for pageY.',
        },
        preferTextAnchor: {
            type: 'boolean',
            description: 'Prefer anchoring the note to nearby text when possible. Defaults to true.',
        },
    },
    additionalProperties: false,
};
const ANNOTATION_SHAPE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        page: {
            type: 'number',
            description: 'One-based PDF page number. Defaults to the current page.',
        },
        pageNumber: {
            type: 'number',
            description: 'Alias for page.',
        },
        shape: {
            type: 'string',
            enum: [
                'draw',
                'rectangle',
                'circle',
                'line',
                'arrow',
            ],
            description: 'Shape type to create.',
        },
        tool: {
            type: 'string',
            enum: [
                'draw',
                'rectangle',
                'circle',
                'line',
                'arrow',
            ],
            description: 'Alias for shape.',
        },
        x: {
            type: 'number',
            description: 'Normalized start/left page coordinate from 0 to 1.',
        },
        y: {
            type: 'number',
            description: 'Normalized start/top page coordinate from 0 to 1.',
        },
        width: {
            type: 'number',
            description: 'Normalized width for rectangle/circle, or fallback line delta.',
        },
        height: {
            type: 'number',
            description: 'Normalized height for rectangle/circle, or fallback line delta.',
        },
        x2: {
            type: 'number',
            description: 'Normalized end/right page coordinate for line/arrow or box corner.',
        },
        y2: {
            type: 'number',
            description: 'Normalized end/bottom page coordinate for line/arrow or box corner.',
        },
        points: {
            type: 'array',
            items: {type: 'object'},
            description: 'Freehand draw points as normalized {x,y} objects.',
        },
        strokes: {
            type: 'array',
            items: {
                type: 'array',
                items: {type: 'object'},
            },
            description: 'Freehand draw strokes as arrays of normalized {x,y} objects.',
        },
        color: {
            type: 'string',
            description: 'CSS stroke color override. Defaults to current viewer annotation settings.',
        },
        fillColor: {
            type: [
                'string',
                'null',
            ],
            description: 'CSS fill color override; null or transparent means no fill.',
        },
        opacity: {
            type: 'number',
            description: 'Opacity from 0 to 1.',
        },
        strokeWidth: {
            type: 'number',
            description: 'Stroke width in viewer annotation units.',
        },
    },
    required: ['shape'],
    additionalProperties: false,
};
const PAGE_LABEL_RANGE_SCHEMA = {
    type: 'object',
    properties: {
        startPage: {
            type: 'number',
            description: 'One-based page where this numbering range starts.',
        },
        style: {
            type: [
                'string',
                'null',
            ],
            enum: [
                'D',
                'R',
                'r',
                'A',
                'a',
                'decimal',
                'roman-upper',
                'roman-lower',
                'letters-upper',
                'letters-lower',
                'literal',
                null,
            ],
            description: 'Numbering style: decimal, roman, letters, or null/literal for prefix-only labels.',
        },
        prefix: {
            type: 'string',
            description: 'Prefix prepended to generated numbers, or the literal label when style is null.',
        },
        startNumber: {
            type: 'number',
            description: 'First generated number for startPage. Defaults to 1.',
        },
    },
    required: ['startPage'],
    additionalProperties: false,
};
const PAGE_LABEL_SEGMENT_SCHEMA = {
    type: 'object',
    properties: {
        ...PAGE_LABEL_RANGE_SCHEMA.properties,
        endPage: {
            type: 'number',
            description: 'One-based inclusive end page for this segment.',
        },
        toPage: {
            type: 'number',
            description: 'Alias for endPage.',
        },
        label: {
            type: 'string',
            description: 'Literal label for this segment when style/prefix are omitted.',
        },
    },
    required: ['startPage'],
    additionalProperties: false,
};
const PAGE_LABEL_SET_RANGES_INPUT_SCHEMA = {
    type: 'object',
    properties: {ranges: {
        type: 'array',
        items: PAGE_LABEL_RANGE_SCHEMA,
        description: 'Complete replacement set of page-label ranges.',
    }},
    required: ['ranges'],
    additionalProperties: false,
};
const PAGE_LABEL_APPLY_RANGE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        startPage: {type: 'number'},
        endPage: {type: 'number'},
        page: {
            type: 'number',
            description: 'Alias for a single-page startPage.',
        },
        pageNumber: {
            type: 'number',
            description: 'Alias for page.',
        },
        style: PAGE_LABEL_RANGE_SCHEMA.properties.style,
        prefix: PAGE_LABEL_RANGE_SCHEMA.properties.prefix,
        startNumber: PAGE_LABEL_RANGE_SCHEMA.properties.startNumber,
    },
    additionalProperties: false,
};
const PAGE_LABEL_SET_LABELS_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        labels: {
            type: 'array',
            items: {type: 'string'},
            description: 'Explicit labels starting at physical page 1; omitted pages keep their current labels.',
        },
        updates: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    page: {type: 'number'},
                    pageNumber: {type: 'number'},
                    label: {type: 'string'},
                },
                additionalProperties: false,
            },
            description: 'Batch of explicit per-page label updates.',
        },
        page: {type: 'number'},
        pageNumber: {type: 'number'},
        label: {type: 'string'},
    },
    additionalProperties: false,
};
const PAGE_LABEL_PLAN_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        ranges: {
            type: 'array',
            items: PAGE_LABEL_RANGE_SCHEMA,
            description: 'Complete replacement PDF page-label ranges. Use for regular range plans.',
        },
        segments: {
            type: 'array',
            items: PAGE_LABEL_SEGMENT_SCHEMA,
            description: 'Inclusive page spans with generated labels; easier for agents than raw PDF ranges because each segment may include endPage.',
        },
        labels: PAGE_LABEL_SET_LABELS_INPUT_SCHEMA.properties.labels,
        updates: PAGE_LABEL_SET_LABELS_INPUT_SCHEMA.properties.updates,
        page: PAGE_LABEL_SET_LABELS_INPUT_SCHEMA.properties.page,
        pageNumber: PAGE_LABEL_SET_LABELS_INPUT_SCHEMA.properties.pageNumber,
        label: PAGE_LABEL_SET_LABELS_INPUT_SCHEMA.properties.label,
        startPage: {
            type: 'number',
            description: 'Starting page when labels is a partial explicit-label array.',
        },
        base: {
            type: 'string',
            enum: [
                'current',
                'default',
                'physical',
            ],
            description: 'Base labels for segments or explicit updates. Defaults to current labels; default/physical starts from physical decimal pages.',
        },
    },
    additionalProperties: false,
};
const BOOKMARK_PATH_SCHEMA = {
    type: 'array',
    items: {type: 'number'},
    description: 'Zero-based path in the bookmark tree, for example [0,2] for the third child of the first root bookmark.',
};
const BOOKMARK_ENTRY_SCHEMA = {
    type: 'object',
    properties: {
        title: {type: 'string'},
        page: {
            type: 'number',
            description: 'One-based destination page.',
        },
        pageNumber: {
            type: 'number',
            description: 'Alias for page.',
        },
        pageIndex: {
            type: 'number',
            description: 'Zero-based destination page index.',
        },
        namedDest: {type: 'string'},
        dest: {
            type: 'string',
            description: 'Alias for namedDest.',
        },
        bold: {type: 'boolean'},
        italic: {type: 'boolean'},
        color: {
            type: [
                'string',
                'null',
            ],
            description: 'Hex color such as #336699, or null to clear.',
        },
        items: {
            type: 'array',
            items: {type: 'object'},
            description: 'Nested child bookmarks using the same entry shape.',
        },
        children: {
            type: 'array',
            items: {type: 'object'},
            description: 'Alias for items.',
        },
        parentPath: BOOKMARK_PATH_SCHEMA,
        index: {
            type: 'number',
            description: 'Zero-based insert index within the parent. Defaults to append.',
        },
    },
    additionalProperties: false,
};
const BOOKMARK_FLAT_ENTRY_SCHEMA = {
    type: 'object',
    properties: {
        ...BOOKMARK_ENTRY_SCHEMA.properties,
        level: {
            type: 'number',
            description: 'One-based outline level for flat TOC input; level 1 is a root bookmark.',
        },
        depth: {
            type: 'number',
            description: 'Zero-based outline depth for flat TOC input; depth 0 is a root bookmark.',
        },
    },
    additionalProperties: false,
};
const BOOKMARK_TREE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        bookmarks: {
            type: 'array',
            items: BOOKMARK_ENTRY_SCHEMA,
            description: 'Complete replacement bookmark tree.',
        },
        items: {
            type: 'array',
            items: BOOKMARK_ENTRY_SCHEMA,
            description: 'Alias for bookmarks.',
        },
        tree: {
            type: 'array',
            items: BOOKMARK_ENTRY_SCHEMA,
            description: 'Alias for bookmarks.',
        },
        entries: {
            type: 'array',
            items: BOOKMARK_FLAT_ENTRY_SCHEMA,
            description: 'Flat TOC entries with level/depth values. The renderer converts them into nested bookmarks.',
        },
        flat: {
            type: 'array',
            items: BOOKMARK_FLAT_ENTRY_SCHEMA,
            description: 'Alias for entries.',
        },
        outline: {
            type: 'array',
            items: BOOKMARK_FLAT_ENTRY_SCHEMA,
            description: 'Alias for entries.',
        },
    },
    additionalProperties: false,
};
const BOOKMARK_PLAN_INPUT_SCHEMA = BOOKMARK_TREE_INPUT_SCHEMA;
const BOOKMARK_ADD_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        ...BOOKMARK_ENTRY_SCHEMA.properties,
        bookmark: BOOKMARK_ENTRY_SCHEMA,
    },
    additionalProperties: false,
};
const BOOKMARK_ADD_BATCH_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        parentPath: BOOKMARK_PATH_SCHEMA,
        bookmarks: {
            type: 'array',
            items: BOOKMARK_ENTRY_SCHEMA,
        },
        items: {
            type: 'array',
            items: BOOKMARK_ENTRY_SCHEMA,
        },
    },
    additionalProperties: false,
};
const BOOKMARK_UPDATE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        path: BOOKMARK_PATH_SCHEMA,
        ...BOOKMARK_ENTRY_SCHEMA.properties,
        bookmark: BOOKMARK_ENTRY_SCHEMA,
    },
    required: ['path'],
    additionalProperties: false,
};
const BOOKMARK_DELETE_INPUT_SCHEMA = {
    type: 'object',
    properties: {path: BOOKMARK_PATH_SCHEMA},
    required: ['path'],
    additionalProperties: false,
};
const VIEW_MODE_INPUT_SCHEMA = {
    type: 'object',
    properties: {mode: {
        type: 'string',
        enum: [
            'single',
            'facing',
            'facing-first-single',
        ],
    }},
    required: ['mode'],
    additionalProperties: false,
};
const INSERT_PAGES_INPUT_SCHEMA = {
    type: 'object',
    properties: {afterPage: {
        type: 'number',
        description: 'One-based page after which selected files should be inserted. Defaults to the end of the document.',
    }},
    additionalProperties: false,
};
const OCR_RUN_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        pageRange: {
            type: 'string',
            enum: [
                'all',
                'current',
                'custom',
            ],
            description: 'Pages to OCR. Defaults to the OCR popup current setting.',
        },
        customRange: {
            type: 'string',
            description: 'Custom page range such as 1-3,7. Used when pageRange is custom.',
        },
        languages: {
            type: 'array',
            items: {type: 'string'},
            description: 'OCR language codes such as eng, deu, tur. Defaults to the OCR popup current setting.',
        },
    },
    additionalProperties: false,
};
const ALLOW_INTERNAL_AND_EXTERNAL = {
    internal: 'allow',
    external: 'allow',
} as const;
const CONFIRM_EXTERNAL = {
    internal: 'allow',
    external: 'confirm',
} as const;
const CONFIRM_ALL_WRITES = {
    internal: 'confirm',
    external: 'confirm',
} as const;

const AGENT_CAPABILITY_TEMPLATES = [
    {
        id: 'workspace.snapshot',
        domain: 'workspace',
        title: 'Read workspace snapshot',
        summary: 'Read panes, tabs, active document, recent-file metadata, page numbers, and readiness hints.',
        risk: 'read',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'always',
        resourceTemplates: ['evb://workspace/current'],
    },
    {
        id: 'document.open_documents',
        domain: 'document',
        title: 'List open documents',
        summary: 'Read open EVB Viewer documents with active tab, page, dirty state, kind, and readiness.',
        risk: 'read',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'always',
    },
    {
        id: 'document.readiness',
        domain: 'document',
        title: 'Read document readiness',
        summary: 'Read document preparation hints for all tabs or a specific tab.',
        risk: 'read',
        inputSchema: TAB_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'always',
    },
    {
        id: 'document.inspect_text',
        domain: 'document',
        title: 'Inspect PDF text coverage',
        summary: 'Build or reuse EVB Viewer search index and report searchable text/OCR coverage by page.',
        risk: 'read',
        inputSchema: TAB_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'pdf-path',
        resourceTemplates: [
            'evb://document/{tabId}/text-status',
            'evb://document/{tabId}/ocr-status',
        ],
    },
    {
        id: 'document.search',
        domain: 'document',
        title: 'Search open PDF',
        summary: 'Search the open PDF using EVB Viewer cached search indexes and return page candidates with excerpts.',
        risk: 'read',
        inputSchema: SEARCH_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'pdf-path',
    },
    {
        id: 'document.read_pages',
        domain: 'document',
        title: 'Read PDF page text',
        summary: 'Read extracted searchable text for one or more one-based PDF pages.',
        risk: 'read',
        inputSchema: READ_PAGES_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'pdf-path',
        resourceTemplates: ['evb://document/{tabId}/page/{page}'],
    },
    {
        id: 'document.capture_page_image',
        domain: 'document',
        title: 'Capture rendered PDF page image',
        summary: 'Navigate/render a PDF page and return a PNG image of the full page or a normalized crop for visual verification when OCR/search/TOC evidence is uncertain.',
        risk: 'navigate',
        inputSchema: CAPTURE_PAGE_IMAGE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'toc.read',
        domain: 'toc',
        title: 'Read TOC/bookmarks',
        summary: 'Read the active document table of contents/bookmarks when present.',
        risk: 'read',
        inputSchema: TAB_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
        resourceTemplates: ['evb://document/{tabId}/toc'],
    },
    {
        id: 'page_labels.read',
        domain: 'page_labels',
        title: 'Read page labels',
        summary: 'Read current PDF page numbering ranges, materialized labels, compact segments, samples, and validation hints.',
        risk: 'read',
        inputSchema: TAB_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
        resourceTemplates: ['evb://document/{tabId}/page-labels'],
    },
    {
        id: 'page_labels.preview',
        domain: 'page_labels',
        title: 'Preview page label plan',
        summary: 'Normalize proposed page-label ranges, inclusive segments, or explicit labels and return segments, samples, issues, and a changed-page diff without mutating the document.',
        risk: 'read',
        inputSchema: PAGE_LABEL_PLAN_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'page_labels.apply_plan',
        domain: 'page_labels',
        title: 'Apply page label plan',
        summary: 'Apply a verified page-label plan from ranges, inclusive segments, or explicit labels, returning the normalized snapshot and diff while recording an undoable metadata edit.',
        risk: 'write',
        inputSchema: PAGE_LABEL_PLAN_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'page_labels.set_ranges',
        domain: 'page_labels',
        title: 'Replace page label ranges',
        summary: 'Replace all PDF page numbering ranges in one batch.',
        risk: 'write',
        inputSchema: PAGE_LABEL_SET_RANGES_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'page_labels.apply_range',
        domain: 'page_labels',
        title: 'Apply page numbering range',
        summary: 'Apply decimal, roman, alphabetic, or literal numbering to one page range while preserving labels outside it.',
        risk: 'write',
        inputSchema: PAGE_LABEL_APPLY_RANGE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'page_labels.set_labels',
        domain: 'page_labels',
        title: 'Set explicit page labels',
        summary: 'Set one or many explicit physical-page labels and derive compact numbering ranges from them.',
        risk: 'write',
        inputSchema: PAGE_LABEL_SET_LABELS_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'page_labels.clear',
        domain: 'page_labels',
        title: 'Reset page labels',
        summary: 'Reset page numbering to default physical decimal pages starting at 1.',
        risk: 'write',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'bookmarks.read',
        domain: 'bookmarks',
        title: 'Read bookmarks',
        summary: 'Read editable PDF bookmarks as a nested tree plus flat path-indexed entries, summary counts, and validation hints.',
        risk: 'read',
        inputSchema: TAB_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
        resourceTemplates: ['evb://document/{tabId}/bookmarks'],
    },
    {
        id: 'bookmarks.preview_tree',
        domain: 'bookmarks',
        title: 'Preview bookmark tree',
        summary: 'Normalize a proposed nested bookmark tree with items/children or flat TOC entries with level/depth values and return the nested tree, flat view, issues, and path-level diff without mutating the document.',
        risk: 'read',
        inputSchema: BOOKMARK_PLAN_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'bookmarks.apply_plan',
        domain: 'bookmarks',
        title: 'Apply bookmark plan',
        summary: 'Apply a verified nested bookmark tree with items/children or flat TOC-entry plan as an undoable metadata edit, returning the normalized tree, flat view, issues, and diff.',
        risk: 'write',
        inputSchema: BOOKMARK_PLAN_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'bookmarks.set_tree',
        domain: 'bookmarks',
        title: 'Replace bookmark tree',
        summary: 'Replace the full multi-level bookmark tree in one batch. Also accepts flat entries with level/depth values.',
        risk: 'write',
        inputSchema: BOOKMARK_TREE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'bookmarks.add',
        domain: 'bookmarks',
        title: 'Add bookmark',
        summary: 'Add one bookmark at a root or child path, with optional style and nested children.',
        risk: 'write',
        inputSchema: BOOKMARK_ADD_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'bookmarks.add_batch',
        domain: 'bookmarks',
        title: 'Add bookmarks in batch',
        summary: 'Add multiple bookmarks, each optionally targeting a different parent path and insert index.',
        risk: 'write',
        inputSchema: BOOKMARK_ADD_BATCH_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'bookmarks.update',
        domain: 'bookmarks',
        title: 'Update bookmark',
        summary: 'Update one bookmark by zero-based tree path, including title, destination, style, color, or children.',
        risk: 'write',
        inputSchema: BOOKMARK_UPDATE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'bookmarks.delete',
        domain: 'bookmarks',
        title: 'Delete bookmark',
        summary: 'Delete one bookmark subtree by zero-based tree path.',
        risk: 'destructive',
        inputSchema: BOOKMARK_DELETE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_ALL_WRITES,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'annotation.list',
        domain: 'annotation',
        title: 'Read annotations',
        summary: 'Read annotation summaries with stable keys, pages, subtype, color, and note flags.',
        risk: 'read',
        inputSchema: TAB_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
        resourceTemplates: ['evb://document/{tabId}/annotations'],
    },
    {
        id: 'annotation.list_notes',
        domain: 'annotation',
        title: 'Read notes',
        summary: 'Read note-bearing annotations and currently open note-window state.',
        risk: 'read',
        inputSchema: TAB_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
        resourceTemplates: ['evb://document/{tabId}/notes'],
    },
    {
        id: 'annotation.open_note',
        domain: 'annotation',
        title: 'Open annotation note',
        summary: 'Open the note popup/window for an annotation using a stable key from the annotations or notes resource.',
        risk: 'navigate',
        inputSchema: ANNOTATION_REF_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'annotation.focus',
        domain: 'annotation',
        title: 'Focus annotation',
        summary: 'Focus an annotation in the visible viewer using a stable key from the annotations resource.',
        risk: 'navigate',
        inputSchema: ANNOTATION_REF_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'annotation.update_note',
        domain: 'annotation',
        title: 'Update annotation note',
        summary: 'Replace the note text for an annotation using a stable key, annotation id, or id.',
        risk: 'write',
        inputSchema: ANNOTATION_UPDATE_NOTE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'annotation.update_text_markup_color',
        domain: 'annotation',
        title: 'Update text markup color',
        summary: 'Apply a CSS color to an existing highlight, underline, strikethrough, or squiggly annotation.',
        risk: 'write',
        inputSchema: ANNOTATION_COLOR_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'annotation.create_note',
        domain: 'annotation',
        title: 'Start note creation',
        summary: 'Start EVB Viewer quick-note behavior for the current selection or page placement.',
        risk: 'write',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'annotation.create_note_at_point',
        domain: 'annotation',
        title: 'Create point note',
        summary: 'Create a page note at normalized PDF page coordinates, matching user quick-note placement.',
        risk: 'write',
        inputSchema: ANNOTATION_POINT_NOTE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'annotation.create_text_markup',
        domain: 'annotation',
        title: 'Create text markup',
        summary: 'Create highlight, underline, strikethrough, or squiggly markup on matching visible PDF text by page and occurrence.',
        risk: 'write',
        inputSchema: ANNOTATION_TEXT_MARKUP_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'annotation.create_shape',
        domain: 'annotation',
        title: 'Create shape annotation',
        summary: 'Create rectangle, circle, line, arrow, or freehand draw annotations from normalized page geometry.',
        risk: 'write',
        inputSchema: ANNOTATION_SHAPE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'annotation.select_tool',
        domain: 'annotation',
        title: 'Select annotation tool',
        summary: 'Select an annotation tool such as highlight, underline, text, draw, rectangle, circle, line, or arrow.',
        risk: 'write',
        inputSchema: ANNOTATION_TOOL_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'annotation.delete',
        domain: 'annotation',
        title: 'Delete annotation',
        summary: 'Delete an annotation/comment by stable key, annotation id, or id.',
        risk: 'destructive',
        inputSchema: ANNOTATION_REF_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_ALL_WRITES,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'ocr.open_popup',
        domain: 'ocr',
        title: 'Open OCR popup',
        summary: 'Open EVB Viewer OCR controls so OCR can be started with visible page/language options.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'ocr.status',
        domain: 'ocr',
        title: 'Read OCR popup status',
        summary: 'Read visible OCR popup state, selected page range/languages, progress, errors, and running status.',
        risk: 'read',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'ocr.start',
        domain: 'ocr',
        title: 'Start OCR',
        summary: 'Start OCR for the target PDF using the current OCR settings or supplied page range and language codes.',
        risk: 'longRunning',
        inputSchema: OCR_RUN_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'ocr.cancel',
        domain: 'ocr',
        title: 'Cancel OCR',
        summary: 'Cancel the currently running OCR job for the target document when one is active.',
        risk: 'write',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'ui.open_sidebar_tab',
        domain: 'ui',
        title: 'Open sidebar tab',
        summary: 'Open a visible sidebar tab: annotations, bookmarks, thumbnails, or search.',
        risk: 'navigate',
        inputSchema: OPEN_SIDEBAR_TAB_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'ui.toggle_sidebar',
        domain: 'ui',
        title: 'Toggle sidebar',
        summary: 'Toggle the visible document sidebar.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'ui.close_popups',
        domain: 'ui',
        title: 'Close popups',
        summary: 'Close open EVB Viewer dropdowns and annotation property popups.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'view.activate_tab',
        domain: 'view',
        title: 'Activate tab',
        summary: 'Activate an open EVB Viewer tab by id.',
        risk: 'navigate',
        inputSchema: TAB_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'document',
    },
    {
        id: 'view.go_to_page',
        domain: 'view',
        title: 'Go to page',
        summary: 'Activate a tab if needed and navigate its PDF viewer to a one-based page number.',
        risk: 'navigate',
        inputSchema: PAGE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'view.zoom_in',
        domain: 'view',
        title: 'Zoom in',
        summary: 'Increase visible zoom for the target document.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'view.zoom_out',
        domain: 'view',
        title: 'Zoom out',
        summary: 'Decrease visible zoom for the target document.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'view.fit_width',
        domain: 'view',
        title: 'Fit width',
        summary: 'Set the visible PDF fit mode to width.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'view.fit_height',
        domain: 'view',
        title: 'Fit height',
        summary: 'Set the visible PDF fit mode to height.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'view.actual_size',
        domain: 'view',
        title: 'Actual size',
        summary: 'Set the visible PDF zoom to 100%.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'view.toggle_continuous_scroll',
        domain: 'view',
        title: 'Toggle continuous scroll',
        summary: 'Toggle continuous scrolling for the target document.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'view.set_mode',
        domain: 'view',
        title: 'Set page view mode',
        summary: 'Set page view mode to single, facing, or facing-first-single.',
        risk: 'navigate',
        inputSchema: VIEW_MODE_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: ALLOW_INTERNAL_AND_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'file.save',
        domain: 'file',
        title: 'Save',
        summary: 'Save the current document when EVB Viewer reports it can be saved.',
        risk: 'write',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'file.save_as',
        domain: 'file',
        title: 'Save as',
        summary: 'Open Save As for the current document.',
        risk: 'write',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'file.print',
        domain: 'file',
        title: 'Print',
        summary: 'Open print for the current document.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'file.print_current_page',
        domain: 'file',
        title: 'Print current page',
        summary: 'Open print for the current page.',
        risk: 'navigate',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'export.docx',
        domain: 'export',
        title: 'Export DOCX',
        summary: 'Start DOCX export for the current document.',
        risk: 'longRunning',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'export.images',
        domain: 'export',
        title: 'Export images',
        summary: 'Open image export for the current document.',
        risk: 'longRunning',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'export.multi_page_tiff',
        domain: 'export',
        title: 'Export multi-page TIFF',
        summary: 'Open multi-page TIFF export for the current document.',
        risk: 'longRunning',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-document',
    },
    {
        id: 'page_ops.delete_selected',
        domain: 'pageOps',
        title: 'Delete selected pages',
        summary: 'Delete pages currently selected in the thumbnails sidebar.',
        risk: 'destructive',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_ALL_WRITES,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'page_ops.extract_selected',
        domain: 'pageOps',
        title: 'Extract selected pages',
        summary: 'Extract pages currently selected in the thumbnails sidebar.',
        risk: 'write',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'page_ops.rotate_cw_selected',
        domain: 'pageOps',
        title: 'Rotate selected pages clockwise',
        summary: 'Rotate currently selected thumbnail pages clockwise.',
        risk: 'write',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'page_ops.rotate_ccw_selected',
        domain: 'pageOps',
        title: 'Rotate selected pages counterclockwise',
        summary: 'Rotate currently selected thumbnail pages counterclockwise.',
        risk: 'write',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'page_ops.insert_pages',
        domain: 'pageOps',
        title: 'Insert pages',
        summary: 'Open page insertion for the current document.',
        risk: 'write',
        inputSchema: INSERT_PAGES_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'renderer-pdf',
    },
    {
        id: 'page_ops.convert_to_pdf',
        domain: 'pageOps',
        title: 'Convert to PDF',
        summary: 'Open conversion flow for DjVu/image documents or the file open flow for PDF conversion.',
        risk: 'longRunning',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'document',
    },
] as const satisfies readonly IAgentCapabilityTemplate[];

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

function getMcpImagePayload(data: unknown) {
    if (!isRecord(data) || !isRecord(data.image)) {
        return null;
    }

    const { image } = data;
    return typeof image.data === 'string'
        && image.data.trim().length > 0
        && typeof image.mimeType === 'string'
        && image.mimeType.trim().startsWith('image/')
        ? {
            data: image.data.trim(),
            mimeType: image.mimeType.trim(),
        }
        : null;
}

function createToolStructuredContent(data: unknown) {
    if (!isRecord(data) || !isRecord(data.image)) {
        return data;
    }

    const imageMetadata = Object.fromEntries(
        Object.entries(data.image).filter(([key]) => key !== 'data'),
    );
    return {
        ...data,
        image: imageMetadata,
    };
}

function createToolResult(data: unknown) {
    const structuredContent = createToolStructuredContent(data);
    const content: TMcpToolContent[] = [{
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
    }];
    const image = getMcpImagePayload(data);
    if (image) {
        content.push({
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
        });
    }

    return {
        content,
        structuredContent,
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
        'EVB Viewer exposes the live viewer workspace. A document may or may not be open. If the user mentions EVB Viewer, evb-viewer, the viewer app, the workspace, the open document, or the current PDF, use these MCP tools before inspecting processes, files, windows, debug ports, or the repository.',
        'Prefer the compact capability workflow for broad app control: call evb_workspace_snapshot, then evb_list_capabilities, evb_describe_capability when needed, evb_read_resource for notes/annotations/bookmarks/page-labels/page text, and evb_run_action for visible app actions.',
        'For questions like "what document is open in evb-viewer?", call evb_viewer_open_documents. Use evb_workspace_snapshot when you need the full pane/tab/layout tree or need to determine whether any document is open.',
        'When the workspace is empty, evb_workspace_snapshot and evb_viewer_open_documents may still include recent files shown by EVB Viewer. Treat those as file-list metadata only; do not claim to know their contents unless a document is opened and read through EVB tools.',
        'For questions like "find X in this PDF" or "navigate to X", use capability document.search or the compatibility tools evb_viewer_search_open_document / evb_search_document. They use EVB Viewer search indexes and return page numbers plus excerpts.',
        'After search, read candidate pages with capability document.read_pages, evb_read_resource, or evb_read_document_pages, then navigate with capability view.go_to_page or evb_go_to_page only after choosing the best page.',
        'When reconstructing page labels, start from OCR/searchable text and current page labels, then verify visible printed page numbers across front matter, transition pages, appendices, and body pages. Use document.capture_page_image for uncertain pages or crops and inspect the returned image. Prefer page_labels.preview with inclusive segments or explicit labels before committing with page_labels.apply_plan; use low-level page_labels.set_ranges/apply_range/set_labels only for small edits.',
        'When reconstructing bookmarks, start from the PDF TOC/bookmarks when present, then verify each title/page target against OCR/searchable text and visual screenshots for doubtful entries. Prefer bookmarks.preview_tree with flat entries carrying level/depth values before committing with bookmarks.apply_plan; use low-level bookmarks.set_tree/add/add_batch/update/delete only for small edits.',
        'For page-label and bookmark workflows, mutate only through EVB Viewer capabilities so edits enter the metadata undo stack. After all writes are verified, save the file with file.save and report any save failure.',
        'For annotations, notes, bookmarks, and page labels, read evb://document/{tabId}/annotations, /notes, /bookmarks, /toc, and /page-labels through evb_read_resource or MCP resources/read. To create annotation content directly, use annotation.create_text_markup, annotation.create_note_at_point, and annotation.create_shape; use annotation.update_note and annotation.update_text_markup_color for existing annotations. For document metadata, use page_labels.preview/apply_plan and bookmarks.preview_tree/apply_plan for rebuilds; use page_labels.set_ranges/apply_range/set_labels and bookmarks.set_tree/add/add_batch/update/delete for individual or batch edits. Use document.capture_page_image when OCR, page labels, TOC, or search evidence is ambiguous.',
        'For OCR, use capability ocr.status to inspect visible OCR state, ocr.open_popup to show controls, and ocr.start only when the user has explicitly asked to run OCR or has approved the capability policy.',
        'For write, destructive, or long-running actions, inspect the capability policy and prefer dryRun before mutating visible app state.',
        'If a PDF page has no text or search misses likely visual/OCR content, call evb_inspect_document_text and recommend OCR all pages when coverage is partial or none.',
        'For DjVu or image documents, tell the user to convert to PDF before deep text analysis.',
    ].join('\n');
}

function getOptionalCapabilityDomain(params: unknown): TAgentCapabilityDomain | undefined {
    const value = getParamsObject(params).domain;
    return typeof value === 'string' && AGENT_CAPABILITY_TEMPLATES.some(template => template.domain === value)
        ? value as TAgentCapabilityDomain
        : undefined;
}

function getRequiredCapabilityId(params: unknown) {
    const value = getParamsObject(params).id;
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Capability id is required.');
    }
    return value.trim();
}

function getOptionalActionInput(params: unknown) {
    const input = getParamsObject(params).input;
    return isRecord(input) ? input : undefined;
}

function getCapabilityTemplate(id: string) {
    return AGENT_CAPABILITY_TEMPLATES.find(template => template.id === id) ?? null;
}

function findCapabilityTargetTab(snapshot: IAgentWorkspaceSnapshot, tabId?: string) {
    const targetTabId = tabId ?? snapshot.activeTabId;
    if (!targetTabId) {
        return null;
    }
    return snapshot.tabs.find(tab => tab.tabId === targetTabId) ?? null;
}

function createCapabilityAvailability(
    template: IAgentCapabilityTemplate,
    tab: IAgentTabSnapshot | null,
) {
    if (template.availabilityKind === 'always') {
        return {available: true};
    }

    if (!tab) {
        return {
            available: false,
            reason: 'No target tab is available.',
        };
    }

    if (template.availabilityKind === 'document' && !isAgentDocumentTab(tab)) {
        return {
            available: false,
            reason: `Tab ${tab.tabId} does not have an open document.`,
        };
    }

    if ((template.availabilityKind === 'pdf' || template.availabilityKind === 'pdf-path') && tab.kind !== 'pdf') {
        return {
            available: false,
            reason: `Tab ${tab.tabId} is a ${tab.kind} document; convert/open it as PDF first.`,
        };
    }

    if (template.availabilityKind === 'pdf-path' && !tab.originalPath) {
        return {
            available: false,
            reason: `Tab ${tab.tabId} does not expose a readable PDF path yet.`,
        };
    }

    if (template.availabilityKind === 'renderer-document' || template.availabilityKind === 'renderer-pdf') {
        if (!isAgentDocumentTab(tab)) {
            return {
                available: false,
                reason: `Tab ${tab.tabId} does not have an open document.`,
            };
        }
        if (!tab.workspaceAttached) {
            return {
                available: false,
                reason: `Workspace for tab ${tab.tabId} is not attached yet.`,
            };
        }
    }

    if (template.availabilityKind === 'renderer-pdf' && tab.kind !== 'pdf') {
        return {
            available: false,
            reason: `Tab ${tab.tabId} is a ${tab.kind} document; convert/open it as PDF first.`,
        };
    }

    return {available: true};
}

function createCapabilityDescriptor(
    template: IAgentCapabilityTemplate,
    tab: IAgentTabSnapshot | null,
): IAgentCapabilityDescriptor {
    return {
        id: template.id,
        domain: template.domain,
        title: template.title,
        summary: template.summary,
        risk: template.risk,
        inputSchema: template.inputSchema,
        ...(template.outputSchema === undefined ? {} : {outputSchema: template.outputSchema}),
        policy: template.policy,
        ...(template.resourceTemplates === undefined ? {} : {resourceTemplates: template.resourceTemplates}),
        availability: createCapabilityAvailability(template, tab),
    };
}

async function listAgentCapabilities(params: unknown, options: IProcessMcpRequestOptions) {
    const windowId = getOptionalWindowId(params);
    const snapshot = await options.getWorkspaceSnapshot(windowId);
    const targetTab = findCapabilityTargetTab(snapshot, getOptionalTabId(params));
    const domain = getOptionalCapabilityDomain(params);
    const capabilities = AGENT_CAPABILITY_TEMPLATES
        .filter(template => domain === undefined || template.domain === domain)
        .map(template => createCapabilityDescriptor(template, targetTab));
    return {
        activeTabId: snapshot.activeTabId,
        targetTabId: targetTab?.tabId ?? null,
        domain: domain ?? null,
        capabilityCount: capabilities.length,
        capabilities,
    };
}

async function describeAgentCapability(params: unknown, options: IProcessMcpRequestOptions) {
    const id = getRequiredCapabilityId(params);
    const template = getCapabilityTemplate(id);
    if (!template) {
        throw new Error(`Unknown EVB capability: ${id}`);
    }

    const windowId = getOptionalWindowId(params);
    const snapshot = await options.getWorkspaceSnapshot(windowId);
    const targetTab = findCapabilityTargetTab(snapshot, getOptionalTabId(params));
    return {
        activeTabId: snapshot.activeTabId,
        targetTabId: targetTab?.tabId ?? null,
        capability: createCapabilityDescriptor(template, targetTab),
    };
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

function getRequiredResourceUri(params: unknown) {
    const uri = getParamsObject(params).uri;
    if (typeof uri !== 'string' || uri.trim().length === 0) {
        throw new Error('uri is required.');
    }
    return uri.trim();
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

function isAgentDocumentTab(tab: IAgentTabSnapshot) {
    return tab.kind !== 'empty' && Boolean(
        tab.fileName
        || tab.originalPath
        || tab.hasPdf
        || tab.isDjvu,
    );
}

function createOpenDocumentsResponse(snapshot: IAgentWorkspaceSnapshot) {
    const documents = snapshot.tabs
        .filter(isAgentDocumentTab)
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
        workspaceMode: snapshot.summary.mode,
        hasOpenDocument: documents.length > 0,
        documentCount: documents.length,
        activePaneId: snapshot.activePaneId,
        activeTabId: snapshot.activeTabId,
        activeDocument: documents.find(document => document.isActive) ?? null,
        documents,
        recentFilesResolved: snapshot.summary.recentFilesResolved,
        recentFileCount: snapshot.recentFiles.length,
        recentFiles: snapshot.recentFiles,
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

function createActionParams(params: unknown) {
    const input = getOptionalActionInput(params) ?? {};
    const tabId = getOptionalTabId(params);
    return {
        ...input,
        ...(tabId ? {tabId} : {}),
    };
}

async function runAgentActionTool(params: unknown, options: IProcessMcpRequestOptions) {
    const id = getRequiredCapabilityId(params);
    const template = getCapabilityTemplate(id);
    if (!template) {
        throw new Error(`Unknown EVB capability: ${id}`);
    }

    const windowId = getOptionalWindowId(params);
    const actionParams = createActionParams(params);
    if (id === 'workspace.snapshot') {
        return options.getWorkspaceSnapshot(windowId);
    }

    if (id === 'document.open_documents') {
        return createOpenDocumentsResponse(await options.getWorkspaceSnapshot(windowId));
    }

    if (id === 'document.readiness') {
        const snapshot = await options.getWorkspaceSnapshot(windowId);
        return selectDocumentsFromSnapshot(snapshot, getOptionalTabId(actionParams));
    }

    if (id === 'document.inspect_text') {
        const {tab} = await getTargetTabFromParams(actionParams, options);
        const inspectDocumentText = getRequiredCapability(options.inspectDocumentText, id);
        return inspectDocumentText({
            tab,
            options: {},
        }, windowId);
    }

    if (id === 'document.search') {
        const {tab} = await getTargetTabFromParams(actionParams, options);
        const searchDocument = getRequiredCapability(options.searchDocument, id);
        return searchDocument({
            tab,
            options: getDocumentSearchOptions(actionParams),
        }, windowId);
    }

    if (id === 'document.read_pages') {
        const {tab} = await getTargetTabFromParams(actionParams, options);
        const readDocumentPages = getRequiredCapability(options.readDocumentPages, id);
        return readDocumentPages({
            tab,
            options: getDocumentPageReadOptions(actionParams, tab),
        }, windowId);
    }

    if (
        id === 'toc.read'
        || id === 'bookmarks.read'
        || id === 'page_labels.read'
        || id === 'annotation.list'
        || id === 'annotation.list_notes'
    ) {
        const snapshot = await options.getWorkspaceSnapshot(windowId);
        const tab = getTargetTab(snapshot, getOptionalTabId(actionParams));
        let resourceKind = 'notes';
        if (id === 'toc.read') {
            resourceKind = 'toc';
        } else if (id === 'bookmarks.read') {
            resourceKind = 'bookmarks';
        } else if (id === 'page_labels.read') {
            resourceKind = 'page-labels';
        } else if (id === 'annotation.list') {
            resourceKind = 'annotations';
        }
        const resource = await readMcpResource({
            windowId,
            uri: `evb://document/${encodeURIComponent(tab.tabId)}/${resourceKind}`,
        }, options);
        const content = Array.isArray(resource.contents) ? resource.contents[0] : null;
        return isRecord(content) && typeof content.text === 'string'
            ? JSON.parse(content.text)
            : resource;
    }

    if (id === 'view.activate_tab') {
        return options.runCommand({
            name: 'activate_tab',
            arguments: {tabId: getRequiredTabId(actionParams)},
        }, windowId);
    }

    if (id === 'view.go_to_page') {
        const tabId = getOptionalTabId(actionParams);
        const command: TAgentCommand = {
            name: 'go_to_page',
            arguments: {
                page: getRequiredPage(actionParams),
                ...(tabId ? {tabId} : {}),
            },
        };
        return options.runCommand(command, windowId);
    }

    const tabId = getOptionalTabId(params);
    const input = getOptionalActionInput(params);
    const dryRun = getOptionalBoolean(params, 'dryRun');
    const actionCommand: TAgentCommand = {
        name: 'run_action',
        arguments: {
            id,
            ...(tabId ? {tabId} : {}),
            ...(input ? {input} : {}),
            ...(dryRun === undefined ? {} : {dryRun}),
        },
    };
    return options.runCommand(actionCommand, windowId);
}

function getJobStatus(params: unknown) {
    const jobId = getParamsObject(params).jobId;
    return {
        ok: true,
        jobId: typeof jobId === 'string' && jobId.trim().length > 0 ? jobId.trim() : null,
        status: 'not-found',
        tracked: false,
        message: 'No tracked EVB MCP job was found. OCR progress is available through evb_run_action with id ocr.status; other EVB MCP actions complete inline or expose progress in the EVB Viewer UI.',
    };
}

async function callTool(name: string, params: unknown, options: IProcessMcpRequestOptions) {
    const windowId = getOptionalWindowId(params);
    if (name === 'evb_list_capabilities') {
        return createToolResult(await listAgentCapabilities(params, options));
    }

    if (name === 'evb_describe_capability') {
        return createToolResult(await describeAgentCapability(params, options));
    }

    if (name === 'evb_read_resource') {
        return createToolResult(await readMcpResource({
            windowId,
            uri: getRequiredResourceUri(params),
        }, options));
    }

    if (name === 'evb_run_action') {
        return createToolResult(await runAgentActionTool(params, options));
    }

    if (name === 'evb_job_status') {
        return createToolResult(getJobStatus(params));
    }

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
        description: 'Live JSON snapshot of EVB Viewer panes, tabs, active document when present, page numbers, and readiness hints.',
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

function createDocumentJsonResource(
    tab: IAgentTabSnapshot,
    kind: 'ocr-status' | 'annotations' | 'notes' | 'toc' | 'bookmarks' | 'page-labels',
    titleSuffix: string,
    description: string,
): IMcpResourceDefinition {
    return {
        name: `evb_document_${tab.tabId.replaceAll(/[^a-zA-Z0-9_]/gu, '_')}_${kind.replaceAll('-', '_')}`,
        title: `${tab.fileName ?? tab.tabId} ${titleSuffix}`,
        uri: `evb://document/${encodeURIComponent(tab.tabId)}/${kind}`,
        description,
        mimeType: 'application/json',
    };
}

function createDocumentResources(tab: IAgentTabSnapshot) {
    return [
        createDocumentStatusResource(tab),
        createDocumentJsonResource(
            tab,
            'ocr-status',
            'OCR status',
            'OCR/searchable text coverage and recommendations for this open EVB Viewer tab.',
        ),
        createDocumentJsonResource(
            tab,
            'annotations',
            'annotations',
            'Annotation summaries with stable keys, pages, subtype, colors, and note flags.',
        ),
        createDocumentJsonResource(
            tab,
            'notes',
            'notes',
            'Note-bearing annotations and open note-window state for this EVB Viewer tab.',
        ),
        createDocumentJsonResource(
            tab,
            'toc',
            'TOC',
            'Document TOC/bookmarks with titles and one-based page numbers when present.',
        ),
        createDocumentJsonResource(
            tab,
            'bookmarks',
            'bookmarks',
            'Editable nested bookmark tree with zero-based paths and one-based page numbers.',
        ),
        createDocumentJsonResource(
            tab,
            'page-labels',
            'page labels',
            'Page numbering ranges and materialized page labels for this EVB Viewer tab.',
        ),
    ];
}

async function listMcpResources(options: IProcessMcpRequestOptions) {
    const snapshot = await options.getWorkspaceSnapshot();
    return {resources: [
        createWorkspaceResource(),
        ...snapshot.tabs
            .filter(tab => tab.kind === 'pdf' && isAgentDocumentTab(tab))
            .flatMap(createDocumentResources),
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
    const windowId = getOptionalWindowId(params);
    const parsed = parseResourceUri(getParamsObject(params).uri);
    if (parsed.host === 'workspace' && parsed.parts[0] === 'current') {
        const snapshot = await options.getWorkspaceSnapshot(windowId);
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

    const snapshot = await options.getWorkspaceSnapshot(windowId);
    const tab = getTargetTab(snapshot, tabId);
    if (resourceKind === 'text-status' || resourceKind === 'ocr-status') {
        const inspectDocumentText = getRequiredCapability(options.inspectDocumentText, 'resources/read text-status');
        const result = await inspectDocumentText({
            tab,
            options: {},
        }, windowId);
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
        }, windowId);
        const pageResult = Array.isArray(result.pages)
            ? result.pages.find(candidate => isRecord(candidate) && candidate.page === page)
            : null;
        const text = isRecord(pageResult) && typeof pageResult.text === 'string'
            ? pageResult.text
            : '';
        return {contents: [createTextResourceContent(parsed.uri, text, 'text/plain')]};
    }

    if (
        resourceKind === 'annotations'
        || resourceKind === 'notes'
        || resourceKind === 'toc'
        || resourceKind === 'bookmarks'
        || resourceKind === 'page-labels'
        || resourceKind === 'page-numbering'
    ) {
        const result = await options.runCommand({
            name: 'read_resource',
            arguments: {
                tabId: tab.tabId,
                uri: parsed.uri,
            },
        }, windowId);
        return {contents: [createTextResourceContent(
            parsed.uri,
            JSON.stringify(result, null, 2),
            'application/json',
        )]};
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

    if (name === 'evb_number_pages_from_printed_pages') {
        return [
            'Reconstruct the PDF page labels from the printed page numbers.',
            'Start by reading evb://document/{tabId}/page-labels and inspecting text coverage with document.inspect_text. Use OCR/searchable page text as evidence, but do not trust it blindly.',
            'Sample the beginning, front-matter/body transition, appendix or plate sections, and the end. Look for printed numerals such as iv, A, A-1, 1, or restarted numbering; search/read nearby pages to infer ranges.',
            'For every uncertain boundary or suspicious OCR result, call document.capture_page_image with full/top/bottom or normalized crops and visually inspect the returned image before deciding.',
            'Call page_labels.preview with ranges, inclusive segments, or explicit labels. Inspect the normalized segments, samples, issues, and changed-page diff. Only then commit with page_labels.apply_plan so the app records an undoable metadata step. Re-read page labels after the write, spot-check representative pages, then save with file.save.',
        ].join('\n');
    }

    if (name === 'evb_rebuild_verified_bookmarks') {
        return [
            'Rebuild or correct PDF bookmarks from verified section starts.',
            'Start by reading evb://document/{tabId}/toc and /bookmarks. Treat the existing PDF TOC/bookmarks as hints, not proof.',
            'Use document.search and document.read_pages to locate each section title from the TOC, printed contents pages, or the user-specified outline.',
            'For doubtful title/page matches, wrong-looking offsets, duplicated headings, or OCR gaps, call document.capture_page_image on candidate pages or crops and inspect the visible page before writing.',
            'Call bookmarks.preview_tree with a nested tree or flat entries that carry level/depth values. Inspect the normalized tree, flat path list, issues, and diff. Only then commit with bookmarks.apply_plan so the app records an undoable metadata step. Re-read bookmarks, verify a sample of root and nested targets after the write, then save with file.save.',
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

function isAuthorizedMcpRequest(request: IncomingMessage, bearerToken: string | null | undefined) {
    if (!bearerToken) {
        return true;
    }

    const header = request.headers.authorization;
    return typeof header === 'string' && header === `Bearer ${bearerToken}`;
}

function createHttpHandler(
    options: IProcessMcpRequestOptions,
    httpOptions: IHttpHandlerOptions = {},
) {
    return async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method === 'GET' && request.url === '/health') {
            if (!isAuthorizedMcpRequest(request, httpOptions.bearerToken)) {
                writeJson(response, 401, { error: 'Unauthorized.' });
                return;
            }
            writeJson(response, 200, createHealthResponse(options.identity));
            return;
        }

        if (request.method !== 'POST') {
            writeJson(response, 405, { error: 'Only POST JSON-RPC requests are supported.' });
            return;
        }

        if (!isAuthorizedMcpRequest(request, httpOptions.bearerToken)) {
            writeJson(response, 401, { error: 'Unauthorized.' });
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

function createDefaultMcpRequestOptions(identity: ILocalMcpServerIdentity): IProcessMcpRequestOptions {
    return {
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
}

export function startLocalMcpServer() {
    if (localMcpServer) {
        return;
    }

    const port = resolveConfiguredLocalMcpPort();
    const identity = createLocalMcpServerIdentity(port);
    const options = createDefaultMcpRequestOptions(identity);

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

export function isEmbeddedMcpServerRunning() {
    return embeddedMcpServer !== null;
}

export function getEmbeddedMcpServerDescriptor() {
    return embeddedMcpServerDescriptor;
}

export function startEmbeddedMcpServer(bearerToken: string): Promise<ILocalMcpServerDescriptor> {
    if (embeddedMcpServer && embeddedMcpServerDescriptor) {
        return Promise.resolve(embeddedMcpServerDescriptor);
    }

    return new Promise((resolve, reject) => {
        const identity = createLocalMcpServerIdentity(0);
        identity.name = `${identity.name}_embedded`;
        identity.title = `${identity.title} Assistant`;
        const options = createDefaultMcpRequestOptions(identity);
        const server = createServer(createHttpHandler(options, { bearerToken }));
        let settled = false;

        server.on('error', (error) => {
            logger.error(`Embedded MCP server failed: ${getErrorMessage(error)}`);
            if (!settled) {
                settled = true;
                embeddedMcpServer = null;
                embeddedMcpServerDescriptor = null;
                reject(error);
            }
        });
        server.listen(0, DEFAULT_MCP_HOST, () => {
            const address = server.address() as AddressInfo | null;
            const port = address?.port;
            if (!port) {
                embeddedMcpServer = null;
                embeddedMcpServerDescriptor = null;
                settled = true;
                server.close();
                reject(new Error('Embedded MCP server did not receive a port.'));
                return;
            }

            identity.port = port;
            embeddedMcpServerDescriptor = {
                name: identity.name,
                title: identity.title,
                host: identity.host,
                port,
                url: `http://${identity.host}:${port}`,
            };
            embeddedMcpServer = server;
            settled = true;
            logger.info(`Embedded MCP server ${identity.name} listening on ${embeddedMcpServerDescriptor.url}`);
            resolve(embeddedMcpServerDescriptor);
        });
    });
}

export function shutdownEmbeddedMcpServer() {
    const server = embeddedMcpServer;
    if (!server) {
        embeddedMcpServerDescriptor = null;
        return Promise.resolve();
    }

    embeddedMcpServer = null;
    embeddedMcpServerDescriptor = null;
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}
