const TAB_ID_SCHEMA = {
    type: 'string',
    description: 'Optional tab id. Defaults to the active tab.',
};

export const OBJECT_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: true,
};

export const EMPTY_INPUT_SCHEMA = {
    type: 'object',
    properties: {},
    additionalProperties: false,
};
export const TAB_INPUT_SCHEMA = {
    type: 'object',
    properties: {tabId: TAB_ID_SCHEMA},
    additionalProperties: false,
};
export const PAGE_INPUT_SCHEMA = {
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
const PAGE_NUMBER_ARRAY_SCHEMA = {
    type: 'array',
    items: {type: 'number'},
    minItems: 1,
    description: 'One-based PDF page numbers.',
};
const CROP_MARGIN_SCHEMA = {
    type: 'number',
    minimum: 0,
    description: 'Crop margin in PDF points.',
};
export const CROP_PAGES_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        tabId: TAB_ID_SCHEMA,
        pages: PAGE_NUMBER_ARRAY_SCHEMA,
        margins: {
            type: 'object',
            properties: {
                top: CROP_MARGIN_SCHEMA,
                right: CROP_MARGIN_SCHEMA,
                bottom: CROP_MARGIN_SCHEMA,
                left: CROP_MARGIN_SCHEMA,
            },
            required: [
                'top',
                'right',
                'bottom',
                'left',
            ],
            additionalProperties: false,
            description: 'Crop margins in PDF points, matching EVB Viewer crop dialog semantics.',
        },
    },
    required: [
        'pages',
        'margins',
    ],
    additionalProperties: false,
};
export const REMOVE_CROP_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        tabId: TAB_ID_SCHEMA,
        pages: PAGE_NUMBER_ARRAY_SCHEMA,
    },
    required: ['pages'],
    additionalProperties: false,
};
export const SEARCH_INPUT_SCHEMA = {
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
export const READ_PAGES_INPUT_SCHEMA = {
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
export const CAPTURE_PAGE_IMAGE_INPUT_SCHEMA = {
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
export const OPEN_SIDEBAR_TAB_INPUT_SCHEMA = {
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
export const ANNOTATION_REF_INPUT_SCHEMA = {
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
export const ANNOTATION_UPDATE_NOTE_INPUT_SCHEMA = {
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
export const ANNOTATION_COLOR_INPUT_SCHEMA = {
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
export const ANNOTATION_TOOL_INPUT_SCHEMA = {
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
export const ANNOTATION_TEXT_MARKUP_INPUT_SCHEMA = {
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
export const ANNOTATION_POINT_NOTE_INPUT_SCHEMA = {
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
export const ANNOTATION_SHAPE_INPUT_SCHEMA = {
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
export const PAGE_LABEL_SET_RANGES_INPUT_SCHEMA = {
    type: 'object',
    properties: {ranges: {
        type: 'array',
        items: PAGE_LABEL_RANGE_SCHEMA,
        description: 'Complete replacement set of page-label ranges.',
    }},
    required: ['ranges'],
    additionalProperties: false,
};
export const PAGE_LABEL_APPLY_RANGE_INPUT_SCHEMA = {
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
export const PAGE_LABEL_SET_LABELS_INPUT_SCHEMA = {
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
export const PAGE_LABEL_PLAN_INPUT_SCHEMA = {
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
export const BOOKMARK_TREE_INPUT_SCHEMA = {
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
export const BOOKMARK_PLAN_INPUT_SCHEMA = BOOKMARK_TREE_INPUT_SCHEMA;
export const BOOKMARK_ADD_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        ...BOOKMARK_ENTRY_SCHEMA.properties,
        bookmark: BOOKMARK_ENTRY_SCHEMA,
    },
    additionalProperties: false,
};
export const BOOKMARK_ADD_BATCH_INPUT_SCHEMA = {
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
export const BOOKMARK_UPDATE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        path: BOOKMARK_PATH_SCHEMA,
        ...BOOKMARK_ENTRY_SCHEMA.properties,
        bookmark: BOOKMARK_ENTRY_SCHEMA,
    },
    required: ['path'],
    additionalProperties: false,
};
export const BOOKMARK_DELETE_INPUT_SCHEMA = {
    type: 'object',
    properties: {path: BOOKMARK_PATH_SCHEMA},
    required: ['path'],
    additionalProperties: false,
};
export const BOOKMARK_DELETE_BATCH_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        paths: {
            type: 'array',
            minItems: 1,
            items: {
                ...BOOKMARK_PATH_SCHEMA,
                minItems: 1,
            },
            description: 'Zero-based bookmark paths to delete in one metadata edit.',
        },
        items: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                properties: {path: {
                    ...BOOKMARK_PATH_SCHEMA,
                    minItems: 1,
                }},
                required: ['path'],
                additionalProperties: false,
            },
            description: 'Alias for paths using objects returned by bookmarks.read flat entries.',
        },
        bookmarks: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                properties: {path: {
                    ...BOOKMARK_PATH_SCHEMA,
                    minItems: 1,
                }},
                required: ['path'],
                additionalProperties: false,
            },
            description: 'Alias for items.',
        },
        path: {
            ...BOOKMARK_PATH_SCHEMA,
            minItems: 1,
        },
    },
    anyOf: [
        {required: ['paths']},
        {required: ['items']},
        {required: ['bookmarks']},
        {required: ['path']},
    ],
    additionalProperties: false,
};
export const VIEW_MODE_INPUT_SCHEMA = {
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
export const INSERT_PAGES_INPUT_SCHEMA = {
    type: 'object',
    properties: {afterPage: {
        type: 'number',
        description: 'One-based page after which selected files should be inserted. Defaults to the end of the document.',
    }},
    additionalProperties: false,
};
export const OCR_RUN_INPUT_SCHEMA = {
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
        qualityProfile: {
            type: 'string',
            enum: [
                'balanced',
                'accurate',
                'poor-scan',
            ],
            description: 'OCR quality profile. Defaults to the OCR popup current setting.',
        },
        preprocessingMode: {
            type: 'string',
            enum: [
                'off',
                'clean',
            ],
            description: 'Optional image preprocessing mode before OCR. Defaults to the OCR popup current setting.',
        },
        pageSegmentationMode: {
            type: 'integer',
            minimum: 0,
            maximum: 13,
            description: 'Optional Tesseract page segmentation mode from 0 to 13.',
        },
    },
    additionalProperties: false,
};
export const ALLOW_INTERNAL_AND_EXTERNAL = {
    internal: 'allow',
    external: 'allow',
} as const;
export const CONFIRM_EXTERNAL = {
    internal: 'allow',
    external: 'confirm',
} as const;
export const CONFIRM_ALL_WRITES = {
    internal: 'confirm',
    external: 'confirm',
} as const;
