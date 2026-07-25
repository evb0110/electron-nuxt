import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    PDFDocument,
    PDFHexString,
    PDFName,
} from 'pdf-lib';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { formatPdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import { buildPdfAnnotationCommentSummary } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/buildPdfAnnotationCommentSummary';
import { buildPopupIndex } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/buildPopupIndex';
import { collectPagePdfSnapshotEntries } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPagePdfSnapshotEntries';
import { collectPdfAnnotationNamesByPage } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPdfAnnotationNamesByPage';
import { computeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import { loadPdfPageAnnotations } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/loadPdfPageAnnotations';
import { pickLatestAnnotationTimestamp } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/pickLatestAnnotationTimestamp';
import { resolveCombinedAnnotationText } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveCombinedAnnotationText';
import { resolveEditorMarkerRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveEditorMarkerRect';
import { resolveMarkupSubtypeOverrideRegistration } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveMarkupSubtypeOverrideRegistration';
import { safeReadEditorData } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/safeReadEditorData';
import { tryExtractPdfLinkAnnotation } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/tryExtractPdfLinkAnnotation';

vi.mock('pdfjs-dist', () => ({AnnotationEditorType: {
    DISABLE: -1,
    NONE: 0,
    FREETEXT: 1,
    HIGHLIGHT: 2,
    STAMP: 3,
    INK: 4,
    POPUP: 5,
}}));

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
    AnnotationEditorType: {
        DISABLE: -1,
        NONE: 0,
        FREETEXT: 1,
        HIGHLIGHT: 2,
        STAMP: 3,
        INK: 4,
        POPUP: 5,
    },
    PDFDateString: {toDateObject: (value: string | null | undefined) => {
        if (!value) {
            return null;
        }
        const trimmed = value.startsWith('D:') ? value.slice(2) : value;
        const year = Number(trimmed.slice(0, 4));
        const month = Number(trimmed.slice(4, 6));
        const day = Number(trimmed.slice(6, 8));
        if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
            return null;
        }
        return new Date(Date.UTC(year, Math.max(0, month - 1), day || 1));
    }},
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    debug: vi.fn(),
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}}));

const __test__ = {
    buildPdfAnnotationCommentSummary,
    buildPopupIndex,
    collectPagePdfSnapshotEntries,
    collectPdfAnnotationNamesByPage,
    loadPdfPageAnnotations,
    pickLatestAnnotationTimestamp,
    resolveCombinedAnnotationText,
    resolveEditorMarkerRect,
    resolveMarkupSubtypeOverrideRegistration,
    safeReadEditorData,
    tryExtractPdfLinkAnnotation,
};

const computeStableKey = vi.fn((params: {
    pageIndex: number;
    id: string;
    source: 'editor' | 'pdf' | 'shape';
    uid?: string | null;
    annotationId?: string | null;
    annotationName?: string | null | undefined;
}) => `src:${params.source}:${params.pageIndex}:${params.id}` as const);

const resolveKindLabel = vi.fn((subtype: string | null | undefined) => `kind:${subtype ?? 'null'}`);

const summaryDeps = {
    computeStableKey,
    resolveKindLabel,
};

function makeEditor(overrides: Partial<IPdfjsEditor> = {}): IPdfjsEditor {
    return {
        id: overrides.id ?? 'editor-1',
        uid: overrides.uid ?? 'editor-1',
        ...overrides,
    };
}

describe('useAnnotationSync helpers / safeReadEditorData', () => {
    it('returns object payload from getData', () => {
        const editor = makeEditor({getData: () => ({
            modificationDate: 'D:20240501',
            color: '#fff',
        })});
        expect(__test__.safeReadEditorData(editor)).toEqual({
            modificationDate: 'D:20240501',
            color: '#fff',
        });
    });

    it('returns empty object when getData throws', () => {
        const editor = makeEditor({getData: () => {
            throw new Error('boom');
        }});
        expect(__test__.safeReadEditorData(editor)).toEqual({});
    });

    it('returns empty object when getData is missing', () => {
        const editor = makeEditor({});
        expect(__test__.safeReadEditorData(editor)).toEqual({});
    });
});

describe('useAnnotationSync helpers / resolveMarkupSubtypeOverrideRegistration', () => {
    it.each([
        [
            null,
            'Underline',
            null,
        ],
        [
            'id-1',
            null,
            null,
        ],
        [
            'id-1',
            'Highlight',
            null,
        ],
        [
            'id-1',
            'Ink',
            null,
        ],
        [
            'id-1',
            'Typewriter',
            null,
        ],
        [
            'id-1',
            'Stamp',
            null,
        ],
        [
            'id-1',
            'Underline',
            {
                annotationId: 'id-1',
                subtype: 'Underline',
            },
        ],
        [
            'id-1',
            'StrikeOut',
            {
                annotationId: 'id-1',
                subtype: 'StrikeOut',
            },
        ],
        [
            'id-1',
            'Squiggly',
            {
                annotationId: 'id-1',
                subtype: 'Squiggly',
            },
        ],
    ] as const)('maps annotation %s and subtype %s to %o', (annotationId, subtype, expected) => {
        expect(__test__.resolveMarkupSubtypeOverrideRegistration(annotationId, subtype)).toEqual(expected);
    });
});

describe('useAnnotationSync helpers / resolveCombinedAnnotationText', () => {
    it('returns annotation text when visible content present', () => {
        const text = __test__.resolveCombinedAnnotationText(
            { contents: 'note body' },
            { contents: 'popup body' },
        );
        expect(text).toBe('note body');
    });

    it('falls through to popup text when annotation is empty after stripping ZWS', () => {
        const text = __test__.resolveCombinedAnnotationText(
            {contents: '​﻿   '},
            { contents: 'popup body' },
        );
        expect(text).toBe('popup body');
    });

    it('returns empty annotation text when popup is also empty', () => {
        const text = __test__.resolveCombinedAnnotationText(
            { contents: '' },
            { contents: '' },
        );
        expect(text).toBe('');
    });

    it('returns annotation text when no popup is provided', () => {
        const text = __test__.resolveCombinedAnnotationText(
            { contents: 'just annotation' },
            null,
        );
        expect(text).toBe('just annotation');
    });

    it('prefers richText.str over plain contents', () => {
        const text = __test__.resolveCombinedAnnotationText(
            {
                contents: 'plain',
                richText: {str: 'rich body'},
            },
            null,
        );
        expect(text).toBe('rich body');
    });
});

describe('useAnnotationSync helpers / pickLatestAnnotationTimestamp', () => {
    it.each([
        [
            {},
            null,
            null,
        ],
        [
            {modificationDate: 'D:20240301'},
            null,
            Date.UTC(2024, 2, 1),
        ],
        [
            {creationDate: 'D:20240115'},
            null,
            Date.UTC(2024, 0, 15),
        ],
        [
            {modificationDate: 'D:20240301'},
            {modificationDate: 'D:20240601'},
            Date.UTC(2024, 5, 1),
        ],
        [
            {},
            {modificationDate: 'D:20240601'},
            Date.UTC(2024, 5, 1),
        ],
    ])('selects the latest timestamp for annotation %o and popup %o', (annotation, popup, expected) => {
        expect(__test__.pickLatestAnnotationTimestamp(annotation, popup)).toBe(expected);
    });
});

describe('useAnnotationSync helpers / buildPopupIndex', () => {
    it('indexes popup annotations by id', () => {
        const map = __test__.buildPopupIndex([
            {
                id: 'p-1',
                subtype: 'Popup',
            },
            {
                id: 'a-1',
                subtype: 'Highlight',
            },
            {
                id: 'p-2',
                subtype: 'Popup',
            },
        ]);
        expect(map.size).toBe(2);
        expect(map.get('p-1')?.subtype).toBe('Popup');
        expect(map.get('p-2')?.subtype).toBe('Popup');
    });

    it('skips popup annotations without an id', () => {
        const map = __test__.buildPopupIndex([{ subtype: 'Popup' }]);
        expect(map.size).toBe(0);
    });

    it('returns empty map when no popups present', () => {
        const map = __test__.buildPopupIndex([{
            id: 'a-1',
            subtype: 'Highlight',
        }]);
        expect(map.size).toBe(0);
    });
});

describe('useAnnotationSync helpers / tryExtractPdfLinkAnnotation', () => {
    const pageView = [
        0,
        0,
        100,
        100,
    ];

    it('returns null when both url and destination are missing', () => {
        const link = __test__.tryExtractPdfLinkAnnotation(
            {
                id: 'l-1',
                rect: [
                    0,
                    0,
                    10,
                    10,
                ],
            },
            1,
            0,
            pageView,
            0,
        );
        expect(link).toBeNull();
    });

    it('builds link from destination-only annotations', () => {
        const link = __test__.tryExtractPdfLinkAnnotation(
            {
                id: 'l-dest',
                dest: 'section-2',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            1,
            0,
            pageView,
            0,
        );
        expect(link?.id).toBe('l-dest');
        expect(link?.url).toBeUndefined();
        expect(link?.dest).toBe('section-2');
        expect(link?.rect).toBeDefined();
    });

    it('preserves array destinations from PDF.js link annotations', () => {
        const dest = [
            {
                num: 3,
                gen: 0,
            },
            {name: 'XYZ'},
            10,
            20,
            null,
        ];
        const link = __test__.tryExtractPdfLinkAnnotation(
            {
                id: 'l-array-dest',
                dest,
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            1,
            0,
            pageView,
            0,
        );
        expect(link?.dest).toBe(dest);
    });

    it('returns null when rect is missing', () => {
        const link = __test__.tryExtractPdfLinkAnnotation(
            {
                id: 'l-1',
                url: 'https://example.com',
            },
            1,
            0,
            pageView,
            0,
        );
        expect(link).toBeNull();
    });

    it('builds link with synthesized id when annotation id missing', () => {
        const link = __test__.tryExtractPdfLinkAnnotation(
            {
                url: 'https://example.com',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            3,
            7,
            pageView,
            0,
        );
        expect(link?.id).toBe('link-3-7');
        expect(link?.pageNumber).toBe(3);
        expect(link?.url).toBe('https://example.com');
        expect(link?.rect).toBeDefined();
    });

    it('preserves explicit annotation id when present', () => {
        const link = __test__.tryExtractPdfLinkAnnotation(
            {
                id: 'link-explicit',
                url: 'https://example.com',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            1,
            0,
            pageView,
            0,
        );
        expect(link?.id).toBe('link-explicit');
    });
});

describe('useAnnotationSync helpers / buildPdfAnnotationCommentSummary', () => {
    const pageView = [
        0,
        0,
        100,
        100,
    ];

    it('builds a comment summary preserving subtype, page, source=pdf', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'a-1',
                subtype: 'Highlight',
                contents: 'hello',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            null,
            5,
            0,
            pageView,
            0,
            summaryDeps,
        );

        expect(summary.id).toBe('a-1');
        expect(summary.source).toBe('pdf');
        expect(summary.subtype).toBe('Highlight');
        expect(summary.pageIndex).toBe(4);
        expect(summary.pageNumber).toBe(5);
        expect(summary.text).toBe('hello');
        expect(summary.uid).toBeNull();
        expect(summary.annotationId).toBe('a-1');
        expect(summary.kindLabel).toBe('kind:Highlight');
        expect(summary.stableKey).toBe('src:pdf:4:a-1');
    });

    it('prefers the PDF annotation /NM name for stable identity', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: '42R',
                annotationName: 'evb-markup:stable-id',
                subtype: 'Highlight',
                contents: 'hello',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            null,
            5,
            0,
            pageView,
            0,
            {
                computeStableKey: computeSummaryStableKey,
                resolveKindLabel,
            },
        );

        expect(summary.annotationName).toBe('evb-markup:stable-id');
        expect(summary.stableKey).toBe('nm:evb-markup:stable-id');
    });

    it('falls through to popup text when annotation is ZWS-only', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'a-2',
                subtype: 'FreeText',
                contents: '​﻿',
                popupRef: 'p-2',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            {
                id: 'p-2',
                subtype: 'Popup',
                contents: 'real note',
            },
            1,
            2,
            pageView,
            0,
            summaryDeps,
        );

        expect(summary.text).toBe('real note');
    });

    it('does not treat a regular-size FreeText editor with a popup as a point note', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'a-3',
                subtype: 'FreeText',
                contents: 'note',
                popupRef: 'p-3',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            {
                id: 'p-3',
                subtype: 'Popup',
            },
            1,
            0,
            pageView,
            0,
            summaryDeps,
        );

        expect(summary.hasNote).toBe(false);
    });

    it('treats a FreeText popup at the inclusive point-note threshold as a note', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'freetext-1',
                subtype: 'FreeText',
                rect: [
                    100,
                    500,
                    112,
                    516,
                ],
                contents: 'note',
                popupRef: 'popup-1',
            },
            {
                id: 'popup-1',
                subtype: 'Popup',
                contents: 'note',
            },
            1,
            0,
            [
                0,
                0,
                600,
                800,
            ],
            0,
            summaryDeps,
        );

        expect(summary.hasNote).toBe(true);
        expect(summary.markerRect?.width).toBeCloseTo(0.02, 12);
        expect(summary.markerRect?.height).toBeCloseTo(0.02, 12);
        expect(summary.markerRect?.left).toBeCloseTo(100 / 600, 5);
        expect(summary.markerRect?.top).toBeCloseTo(1 - (516 / 800), 5);
    });

    it('rejects a FreeText popup just above the point-note threshold', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'freetext-above-threshold',
                subtype: 'FreeText',
                rect: [
                    100,
                    500,
                    112.0006,
                    516.0008,
                ],
                contents: 'note',
                popupRef: 'popup-above-threshold',
            },
            {
                id: 'popup-above-threshold',
                subtype: 'Popup',
                contents: 'note',
            },
            1,
            0,
            [
                0,
                0,
                600,
                800,
            ],
            0,
            summaryDeps,
        );

        expect(summary.hasNote).toBe(false);
        expect(summary.markerRect?.width).toBeGreaterThan(0.02);
        expect(summary.markerRect?.height).toBeGreaterThan(0.02);
    });

    it('keeps regular FreeText rects when there is no linked popup', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'freetext-1',
                subtype: 'FreeText',
                rect: [
                    100,
                    500,
                    220,
                    620,
                ],
                contents: 'visible text',
            },
            null,
            1,
            0,
            [
                0,
                0,
                600,
                800,
            ],
            0,
            summaryDeps,
        );

        expect(summary.markerRect?.width).toBeGreaterThan(0.02);
        expect(summary.markerRect?.height).toBeGreaterThan(0.02);
    });

    it('marks hasNote=false for FreeText without popup link or text', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'a-4',
                subtype: 'FreeText',
                contents: '',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            null,
            1,
            0,
            pageView,
            0,
            summaryDeps,
        );

        expect(summary.hasNote).toBe(false);
    });

    it('synthesizes id when annotation id missing', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                subtype: 'Highlight',
                contents: 'hi',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            null,
            7,
            3,
            pageView,
            0,
            summaryDeps,
        );

        expect(summary.id).toBe('pdf-7-3');
        expect(summary.annotationId).toBeNull();
    });

    it('extracts preview text for PDF-backed text markup with empty contents', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'highlight-1',
                subtype: 'Highlight',
                contents: '',
                rect: [
                    10,
                    60,
                    50,
                    80,
                ],
            },
            null,
            1,
            0,
            pageView,
            0,
            summaryDeps,
            [{
                str: 'Highlighted text',
                transform: [
                    10,
                    0,
                    0,
                    10,
                    10,
                    70,
                ],
                width: 40,
                height: 10,
            }],
            {
                transform: [
                    1,
                    0,
                    0,
                    -1,
                    0,
                    100,
                ],
                width: 100,
                height: 100,
                scale: 1,
            },
        );

        expect(summary.text).toBe('');
        expect(summary.previewText).toBe('Highlighted text');
    });

    it('treats generated text-markup contents as selected-text preview when there is no popup', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'strikeout-1',
                subtype: 'StrikeOut',
                contents: 'CD lower',
                rect: [
                    30,
                    70,
                    50,
                    80,
                ],
            },
            null,
            1,
            0,
            pageView,
            0,
            summaryDeps,
            [
                {
                    str: 'ABCDEFGH',
                    transform: [
                        10,
                        0,
                        0,
                        10,
                        10,
                        70,
                    ],
                    width: 80,
                    height: 10,
                },
                {
                    str: 'lower words',
                    transform: [
                        4,
                        0,
                        0,
                        4,
                        10,
                        67,
                    ],
                    width: 80,
                    height: 4,
                },
            ],
            {
                transform: [
                    1,
                    0,
                    0,
                    -1,
                    0,
                    100,
                ],
                width: 100,
                height: 100,
                scale: 1,
            },
        );

        expect(summary.text).toBe('');
        expect(summary.previewText).toBe('CD');
        expect(summary.hasNote).toBe(false);
    });

    it('does not replace explicit markup note text with extracted preview text', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'highlight-2',
                subtype: 'Highlight',
                contents: 'existing note',
                rect: [
                    10,
                    60,
                    50,
                    80,
                ],
            },
            null,
            1,
            0,
            pageView,
            0,
            summaryDeps,
            [{
                str: 'Highlighted text',
                transform: [
                    10,
                    0,
                    0,
                    10,
                    10,
                    70,
                ],
                width: 40,
                height: 10,
            }],
            {
                transform: [
                    1,
                    0,
                    0,
                    -1,
                    0,
                    100,
                ],
                width: 100,
                height: 100,
                scale: 1,
            },
        );

        expect(summary.text).toBe('existing note');
        expect(summary.previewText).toBeNull();
    });

    it('uses popup author when annotation has no author', () => {
        const summary = __test__.buildPdfAnnotationCommentSummary(
            {
                id: 'a-5',
                subtype: 'Highlight',
                contents: 'hi',
                rect: [
                    10,
                    10,
                    50,
                    50,
                ],
            },
            {
                id: 'p-5',
                subtype: 'Popup',
                title: 'Bob',
            },
            1,
            0,
            pageView,
            0,
            summaryDeps,
        );

        expect(summary.author).toBe('Bob');
    });
});

describe('useAnnotationSync helpers / collectPagePdfSnapshotEntries', () => {
    const pageView = [
        0,
        0,
        100,
        100,
    ];

    it('skips popup-only entries and produces a comment plus a link', () => {
        const comments: Array<ReturnType<typeof __test__.buildPdfAnnotationCommentSummary>> = [];
        const links: Array<NonNullable<ReturnType<typeof __test__.tryExtractPdfLinkAnnotation>>> = [];

        __test__.collectPagePdfSnapshotEntries(
            {
                annotations: [
                    {
                        id: 'p-1',
                        subtype: 'Popup',
                    },
                    {
                        id: 'a-1',
                        subtype: 'Highlight',
                        contents: 'note',
                        rect: [
                            10,
                            10,
                            50,
                            50,
                        ],
                        popupRef: 'p-1',
                    },
                    {
                        id: 'l-1',
                        subtype: 'Link',
                        url: 'https://example.com',
                        rect: [
                            10,
                            10,
                            50,
                            50,
                        ],
                    },
                ],
                pageView,
                pageRotation: 0,
            },
            2,
            summaryDeps,
            comments,
            links,
        );

        expect(comments).toHaveLength(1);
        expect(comments[0]?.id).toBe('a-1');
        expect(comments[0]?.subtype).toBe('Highlight');
        expect(links).toHaveLength(1);
        expect(links[0]?.url).toBe('https://example.com');
    });

    it('skips imported embedded shapes', () => {
        const comments: Array<ReturnType<typeof __test__.buildPdfAnnotationCommentSummary>> = [];
        const links: Array<NonNullable<ReturnType<typeof __test__.tryExtractPdfLinkAnnotation>>> = [];

        __test__.collectPagePdfSnapshotEntries(
            {
                annotations: [{
                    id: 'shape-1',
                    subtype: 'Square',
                    rect: [
                        10,
                        10,
                        50,
                        50,
                    ],
                }],
                pageView,
                pageRotation: 0,
            },
            1,
            summaryDeps,
            comments,
            links,
        );

        expect(comments).toHaveLength(0);
        expect(links).toHaveLength(0);
    });
});

describe('useAnnotationSync helpers / resolveEditorMarkerRect', () => {
    it('uses pending anchor when editor rect missing', () => {
        const editor: IPdfjsEditor = {__evbPendingAnchorRect: {
            left: 0.1,
            top: 0.1,
            width: 0.1,
            height: 0.1,
        }};
        const result = __test__.resolveEditorMarkerRect(editor);
        expect(result.shouldUsePendingAnchor).toBe(true);
        expect(result.markerRect).toEqual({
            left: 0.1,
            top: 0.1,
            width: 0.1,
            height: 0.1,
        });
    });

    it('uses editor rect when pending anchor is absent', () => {
        const editor: IPdfjsEditor = {
            x: 0.2,
            y: 0.3,
            width: 0.1,
            height: 0.1,
        };
        const result = __test__.resolveEditorMarkerRect(editor);
        expect(result.shouldUsePendingAnchor).toBe(false);
        expect(result.markerRect).toEqual({
            left: 0.2,
            top: 0.3,
            width: 0.1,
            height: 0.1,
        });
    });

    it('keeps editor rect when pending anchor matches closely', () => {
        const editor: IPdfjsEditor = {
            x: 0.2,
            y: 0.3,
            width: 0.1,
            height: 0.1,
            __evbPendingAnchorRect: {
                left: 0.21,
                top: 0.31,
                width: 0.1,
                height: 0.1,
            },
        };
        const result = __test__.resolveEditorMarkerRect(editor);
        expect(result.shouldUsePendingAnchor).toBe(false);
        expect(result.markerRect?.left).toBeCloseTo(0.2, 5);
    });

    it('uses point-sized pending anchors even when they are close to the editor rect', () => {
        const editor: IPdfjsEditor = {
            x: 0.2,
            y: 0.3,
            width: 0.1,
            height: 0.1,
            __evbPendingAnchorRect: {
                left: 0.21,
                top: 0.31,
                width: 0.0016,
                height: 0.0016,
            },
        };
        const result = __test__.resolveEditorMarkerRect(editor);
        expect(result.shouldUsePendingAnchor).toBe(true);
        expect(result.markerRect).toEqual({
            left: 0.21,
            top: 0.31,
            width: 0.0016,
            height: 0.0016,
        });
    });
});

describe('useAnnotationSync helpers / collectPdfAnnotationNamesByPage', () => {
    it('reads PDF annotation names by pdf.js annotation ref', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([
            100,
            200,
        ]);
        const annotation = pdfDocument.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Text'),
            Rect: [
                10,
                10,
                20,
                20,
            ],
            Contents: PDFHexString.fromText('note'),
            NM: PDFHexString.fromText('evb-markup:stable'),
        });
        const annotationRef = pdfDocument.context.register(annotation);
        page.node.set(
            PDFName.of('Annots'),
            pdfDocument.context.obj([annotationRef]),
        );

        const data = await pdfDocument.save();
        const doc = { getData: vi.fn(async () => data) };

        const result = await __test__.collectPdfAnnotationNamesByPage(doc as never);

        expect(result.get(0)?.get(formatPdfJsAnnotationRef(annotationRef))).toBe('evb-markup:stable');
        expect(doc.getData).toHaveBeenCalledTimes(1);
    });

    it('skips pages without annotation arrays', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage([
            100,
            200,
        ]);
        const data = await pdfDocument.save();
        const doc = { getData: vi.fn(async () => data) };

        const result = await __test__.collectPdfAnnotationNamesByPage(doc as never);

        expect(result.size).toBe(0);
    });

    it('skips the full document read when name enrichment is disabled', async () => {
        const doc = { getData: vi.fn(async () => Uint8Array.of()) };

        const result = await __test__.collectPdfAnnotationNamesByPage(doc as never, { allowFullRead: false });

        expect(result.size).toBe(0);
        expect(doc.getData).not.toHaveBeenCalled();
    });
});

describe('useAnnotationSync helpers / loadPdfPageAnnotations', () => {
    it('cleans the PDF page after reading annotations', async () => {
        const cleanup = vi.fn();
        const page = {
            getAnnotations: vi.fn(async () => [{id: 'a-1'}]),
            view: [
                0,
                0,
                100,
                200,
            ],
            rotate: 0,
            cleanup,
        };
        const doc = {getPage: vi.fn(async () => page)};

        const result = await __test__.loadPdfPageAnnotations(doc as never, 1);

        expect(result?.annotations).toEqual([{id: 'a-1'}]);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('releases leased PDF pages without calling cleanup directly', async () => {
        const cleanup = vi.fn();
        const release = vi.fn();
        const page = {
            getAnnotations: vi.fn(async () => [{id: 'a-1'}]),
            view: [
                0,
                0,
                100,
                200,
            ],
            rotate: 0,
            cleanup,
        };
        const doc = {getPage: vi.fn(async () => page)};

        const result = await __test__.loadPdfPageAnnotations(
            doc as never,
            1,
            undefined,
            {leasePage: vi.fn(async () => ({
                page: page as never,
                release,
            }))},
        );

        expect(result?.annotations).toEqual([{id: 'a-1'}]);
        expect(release).toHaveBeenCalledOnce();
        expect(cleanup).not.toHaveBeenCalled();
        expect(doc.getPage).not.toHaveBeenCalled();
    });

    it('attaches PDF annotation names by annotation id', async () => {
        const cleanup = vi.fn();
        const page = {
            getAnnotations: vi.fn(async () => [
                {id: '5R'},
                {id: '6R'},
            ]),
            view: [
                0,
                0,
                100,
                200,
            ],
            rotate: 0,
            cleanup,
        };
        const doc = {getPage: vi.fn(async () => page)};
        const annotationNames = new Map([[
            '5R',
            'evb-markup:stable',
        ]]);

        const result = await __test__.loadPdfPageAnnotations(doc as never, 1, annotationNames);

        expect(result?.annotations).toEqual([
            {
                id: '5R',
                annotationName: 'evb-markup:stable',
            },
            {id: '6R'},
        ]);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('cleans the PDF page when annotation reading fails', async () => {
        const cleanup = vi.fn();
        const page = {
            getAnnotations: vi.fn(async () => {
                throw new Error('annotation read failed');
            }),
            cleanup,
        };
        const doc = {getPage: vi.fn(async () => page)};

        await expect(__test__.loadPdfPageAnnotations(doc as never, 1)).resolves.toBeNull();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
});
