import type { IAgentCapabilityDescriptor } from '@contracts/agent';

export interface IMcpToolDefinition {
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


export interface IMcpResourceDefinition {
    name: string;
    title: string;
    uri: string;
    description: string;
    mimeType: string;
}

export interface IMcpResourceTemplateDefinition {
    name: string;
    title: string;
    uriTemplate: string;
    description: string;
    mimeType: string;
}

export interface IMcpPromptDefinition {
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
        'page_ops',
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

export const MCP_TOOLS = [
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

export const MCP_RESOURCE_TEMPLATES = [
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

export const MCP_PROMPTS = [
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

export type TCapabilityAvailabilityKind =
    | 'always'
    | 'document'
    | 'pdf'
    | 'pdf-path'
    | 'renderer-document'
    | 'renderer-pdf';
export interface IAgentCapabilityTemplate extends Omit<IAgentCapabilityDescriptor, 'availability'> {availabilityKind: TCapabilityAvailabilityKind;}

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

export const AGENT_CAPABILITY_TEMPLATES = [
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
        domain: 'page_ops',
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
        domain: 'page_ops',
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
        domain: 'page_ops',
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
        domain: 'page_ops',
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
        domain: 'page_ops',
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
        domain: 'page_ops',
        title: 'Convert to PDF',
        summary: 'Open conversion flow for DjVu/image documents or the file open flow for PDF conversion.',
        risk: 'longRunning',
        inputSchema: EMPTY_INPUT_SCHEMA,
        outputSchema: OBJECT_OUTPUT_SCHEMA,
        policy: CONFIRM_EXTERNAL,
        availabilityKind: 'document',
    },
] as const satisfies readonly IAgentCapabilityTemplate[];
