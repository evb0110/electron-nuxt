import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
} from 'pdf-lib';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import {
    type IPdfSerializationSavePayload,
    serializePdfEdits,
} from '@app/composables/pdf/pdfSerializationOperations';
import { importEmbeddedShapeAnnotations } from '@app/composables/pdf/pdfEmbeddedShapeAnnotations';
import type { IMarkupSubtypeHint } from '@app/composables/pdf/pdfSerializationSubtypeHints';
import { getPdfDictContents } from '@app/utils/pdf-dict';

function createEmptyPayload(): IPdfSerializationSavePayload {
    return {
        markupSubtypeOverrides: [],
        markupSubtypeHints: [],
        rewriteShapeState: false,
        shapes: [],
        deletedShapeAnnotationIds: [],
        deletedShapeStableKeys: [],
        freeTextComments: [],
        annotationComments: [],
        pendingEmbeddedTextUpdates: [],
        pendingEmbeddedAnnotationDeletes: [],
        pageLabelsDirty: false,
        pageLabelRanges: [],
        totalPages: 1,
        bookmarksDirty: false,
        bookmarkItems: [],
        untitledBookmarkLabel: '',
        placedImage: null,
    };
}

async function createPdfWithSquareAndLineAnnotations() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);

    const squareDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [
            PDFNumber.of(60),
            PDFNumber.of(480),
            PDFNumber.of(180),
            PDFNumber.of(680),
        ],
        C: [
            1,
            0,
            0,
        ],
        Border: [
            0,
            0,
            2,
        ],
    });
    const lineDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Line'),
        Rect: [
            PDFNumber.of(90),
            PDFNumber.of(290),
            PDFNumber.of(350),
            PDFNumber.of(530),
        ],
        L: [
            PDFNumber.of(110),
            PDFNumber.of(500),
            PDFNumber.of(330),
            PDFNumber.of(320),
        ],
        Border: [
            0,
            0,
            3,
        ],
    });

    const squareRef = doc.context.register(squareDict);
    const lineRef = doc.context.register(lineDict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([
        squareRef,
        lineRef,
    ]));

    return {
        bytes: new Uint8Array(await doc.save()),
        squareRef,
        lineRef,
    };
}

async function createPdfWithManagedSquareAnnotation() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);

    const squareDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [
            PDFNumber.of(60),
            PDFNumber.of(480),
            PDFNumber.of(180),
            PDFNumber.of(680),
        ],
        C: [
            1,
            0,
            0,
        ],
        Border: [
            0,
            0,
            2,
        ],
        EVBShapeKey: PDFHexString.fromText('evb-shape:managed-square'),
    });

    const squareRef = doc.context.register(squareDict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([squareRef]));

    return {
        bytes: new Uint8Array(await doc.save()),
        squareRef,
    };
}

function getPageAnnotRefs(doc: PDFDocument, pageIndex = 0) {
    const annots = doc.getPage(pageIndex).node.Annots();
    if (!(annots instanceof PDFArray)) {
        return [];
    }

    const refs: PDFRef[] = [];
    for (let index = 0; index < annots.size(); index += 1) {
        const value = annots.get(index);
        if (value instanceof PDFRef) {
            refs.push(value);
        }
    }
    return refs;
}

function getAnnotDict(doc: PDFDocument, ref: PDFRef) {
    return doc.context.lookupMaybe(ref, PDFDict);
}

function getRectNumbers(dict: PDFDict) {
    const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (!(rect instanceof PDFArray)) {
        return null;
    }

    const values: number[] = [];
    for (let index = 0; index < rect.size(); index += 1) {
        const value = rect.get(index);
        if (!(value instanceof PDFNumber)) {
            return null;
        }
        values.push(value.asNumber());
    }
    return values;
}

function getNestedNumberArrays(dict: PDFDict, key: string) {
    const outer = dict.lookupMaybe(PDFName.of(key), PDFArray);
    if (!(outer instanceof PDFArray)) {
        return null;
    }

    const values: number[][] = [];
    for (let outerIndex = 0; outerIndex < outer.size(); outerIndex += 1) {
        const inner = outer.lookup(outerIndex, PDFArray);
        if (!(inner instanceof PDFArray)) {
            return null;
        }

        const row: number[] = [];
        for (let innerIndex = 0; innerIndex < inner.size(); innerIndex += 1) {
            const value = inner.get(innerIndex);
            if (!(value instanceof PDFNumber)) {
                return null;
            }
            row.push(value.asNumber());
        }
        values.push(row);
    }
    return values;
}

function getNumberArray(dict: PDFDict, key: string) {
    const array = dict.lookupMaybe(PDFName.of(key), PDFArray);
    if (!(array instanceof PDFArray)) {
        return null;
    }

    const values: number[] = [];
    for (let index = 0; index < array.size(); index += 1) {
        const value = array.get(index);
        if (!(value instanceof PDFNumber)) {
            return null;
        }
        values.push(value.asNumber());
    }
    return values;
}

describe('serializePdfEdits embedded geometric shapes', () => {
    it('updates imported geometric annotations in place and deletes removed ones by ref', async () => {
        const {
            bytes,
            squareRef,
            lineRef,
        } = await createPdfWithSquareAndLineAnnotations();

        const payload = createEmptyPayload();
        payload.shapes = [{
            id: 'embedded-shape:0:1',
            type: 'rectangle',
            pageIndex: 0,
            x: 0.2,
            y: 0.15,
            width: 0.25,
            height: 0.3,
            color: '#336699',
            fillColor: '#abcdef',
            opacity: 0.6,
            strokeWidth: 4,
            source: 'embedded',
            annotationId: `${squareRef.objectNumber}R${squareRef.generationNumber}`,
            pdfSubtype: 'Square',
        } satisfies IShapeAnnotation];
        payload.deletedShapeAnnotationIds = [`${lineRef.objectNumber}R${lineRef.generationNumber}`];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(doc);

        expect(annotRefs).toHaveLength(1);
        expect(annotRefs[0]?.toString()).toBe(squareRef.toString());

        const squareDict = getAnnotDict(doc, squareRef);
        expect(squareDict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Square');
        expect(getRectNumbers(squareDict!)).toEqual(expect.arrayContaining([
            expect.closeTo(120, 6),
            expect.closeTo(440, 6),
            expect.closeTo(270, 6),
            expect.closeTo(680, 6),
        ]));
        expect(squareDict?.lookupMaybe(PDFName.of('IC'), PDFArray)).toBeInstanceOf(PDFArray);
        expect(getAnnotDict(doc, lineRef)).toBeInstanceOf(PDFDict);
    });

    it('appends new polygon shapes as standard Polygon annotations', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([
            600,
            800,
        ]);

        const payload = createEmptyPayload();
        payload.shapes = [{
            id: 'polygon-shape',
            type: 'polygon',
            pageIndex: 0,
            x: 0.3,
            y: 0.2,
            width: 0.4,
            height: 0.25,
            color: '#ff0000',
            fillColor: '#ffeecc',
            opacity: 0.8,
            strokeWidth: 3,
            points: [
                {
                    x: 0.32,
                    y: 0.22,
                },
                {
                    x: 0.62,
                    y: 0.24,
                },
                {
                    x: 0.56,
                    y: 0.42,
                },
            ],
            source: 'local',
        } satisfies IShapeAnnotation];

        const result = await serializePdfEdits(
            new Uint8Array(await sourceDoc.save()),
            payload,
        );
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(doc);

        expect(annotRefs).toHaveLength(1);
        const polygonDict = getAnnotDict(doc, annotRefs[0]!);
        expect(polygonDict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Polygon');
        expect(polygonDict?.lookupMaybe(PDFName.of('Vertices'), PDFArray)).toBeInstanceOf(PDFArray);
        expect(polygonDict?.lookupMaybe(PDFName.of('IC'), PDFArray)).toBeInstanceOf(PDFArray);
    });

    it('serializes embedded ink-like polylines back as Ink annotations', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([
            600,
            800,
        ]);

        const payload = createEmptyPayload();
        payload.shapes = [{
            id: 'ink-shape',
            type: 'polyline',
            pageIndex: 0,
            x: 0.15,
            y: 0.2,
            width: 0.35,
            height: 0.24,
            color: '#f0c000',
            opacity: 0.7,
            strokeWidth: 5,
            points: [
                {
                    x: 0.15,
                    y: 0.2,
                },
                {
                    x: 0.25,
                    y: 0.24,
                },
                {
                    x: 0.38,
                    y: 0.31,
                },
                {
                    x: 0.5,
                    y: 0.44,
                },
            ],
            strokes: [
                [
                    {
                        x: 0.15,
                        y: 0.2,
                    },
                    {
                        x: 0.25,
                        y: 0.24,
                    },
                    {
                        x: 0.38,
                        y: 0.31,
                    },
                    {
                        x: 0.5,
                        y: 0.44,
                    },
                ],
                [
                    {
                        x: 0.2,
                        y: 0.48,
                    },
                    {
                        x: 0.33,
                        y: 0.52,
                    },
                    {
                        x: 0.46,
                        y: 0.56,
                    },
                ],
            ],
            source: 'embedded',
            annotationId: null,
            pdfSubtype: 'Ink',
        } satisfies IShapeAnnotation];

        const result = await serializePdfEdits(
            new Uint8Array(await sourceDoc.save()),
            payload,
        );
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(doc);

        expect(annotRefs).toHaveLength(1);
        const inkDict = getAnnotDict(doc, annotRefs[0]!);
        expect(inkDict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Ink');
        expect(getNestedNumberArrays(inkDict!, 'InkList')).toEqual([
            [
                expect.closeTo(90, 6),
                expect.closeTo(640, 6),
                expect.closeTo(150, 6),
                expect.closeTo(608, 6),
                expect.closeTo(228, 6),
                expect.closeTo(552, 6),
                expect.closeTo(300, 6),
                expect.closeTo(448, 6),
            ],
            [
                expect.closeTo(120, 6),
                expect.closeTo(416, 6),
                expect.closeTo(198, 6),
                expect.closeTo(384, 6),
                expect.closeTo(276, 6),
                expect.closeTo(352, 6),
            ],
        ]);
    });

    it('removes queued embedded annotation deletes during save serialization', async () => {
        const {
            bytes,
            squareRef,
            lineRef,
        } = await createPdfWithSquareAndLineAnnotations();

        const payload = createEmptyPayload();
        payload.pendingEmbeddedAnnotationDeletes = [{
            id: `${lineRef.objectNumber}R${lineRef.generationNumber}`,
            stableKey: `ann:0:${lineRef.objectNumber}R${lineRef.generationNumber}`,
            pageIndex: 0,
            pageNumber: 1,
            text: '',
            author: null,
            modifiedAt: null,
            color: null,
            uid: null,
            annotationId: `${lineRef.objectNumber}R${lineRef.generationNumber}`,
            source: 'pdf',
        } satisfies IAnnotationCommentSummary];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(doc);

        expect(annotRefs.map(ref => ref.toString())).toEqual([squareRef.toString()]);
        expect(getAnnotDict(doc, lineRef)).toBeInstanceOf(PDFDict);
    });

    it('treats managed geometric annotations as canonical overlay state on save', async () => {
        const { bytes } = await createPdfWithManagedSquareAnnotation();

        const payload = createEmptyPayload();
        payload.rewriteShapeState = true;

        const result = await serializePdfEdits(bytes, payload);
        const importedShapes = await importEmbeddedShapeAnnotations(result);

        expect(importedShapes).toEqual([]);
    });

    it('updates managed geometric annotations in place by stable key during shape rewrites', async () => {
        const {
            bytes,
            squareRef,
        } = await createPdfWithManagedSquareAnnotation();

        const payload = createEmptyPayload();
        payload.rewriteShapeState = true;
        payload.shapes = [{
            id: 'shape-managed-square',
            stableKey: 'evb-shape:managed-square',
            type: 'rectangle',
            pageIndex: 0,
            x: 0.24,
            y: 0.16,
            width: 0.18,
            height: 0.22,
            color: '#336699',
            fillColor: '#abcdef',
            opacity: 0.55,
            strokeWidth: 5,
            source: 'embedded',
            pdfSubtype: 'Square',
        } satisfies IShapeAnnotation];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(doc);
        const importedShapes = await importEmbeddedShapeAnnotations(result);

        expect(annotRefs.map(ref => ref.toString())).toEqual([squareRef.toString()]);
        expect(importedShapes).toHaveLength(1);
        expect(importedShapes[0]).toMatchObject({
            stableKey: 'evb-shape:managed-square',
            pdfSubtype: 'Square',
            color: '#336699',
            fillColor: '#abcdef',
            opacity: 0.55,
            strokeWidth: 5,
        });
    });
});

async function createPdfWithHighlightAnnotations(
    rectsByPage: number[][][],
    options: { withAppearance?: boolean } = {},
) {
    const doc = await PDFDocument.create();
    const refs: PDFRef[][] = [];
    for (const pageRects of rectsByPage) {
        const page = doc.addPage([
            600,
            800,
        ]);
        const pageRefs: PDFRef[] = [];
        for (const rect of pageRects) {
            const dict = doc.context.obj({
                Type: PDFName.of('Annot'),
                Subtype: PDFName.of('Highlight'),
                Rect: [
                    PDFNumber.of(rect[0]!),
                    PDFNumber.of(rect[1]!),
                    PDFNumber.of(rect[2]!),
                    PDFNumber.of(rect[3]!),
                ],
                ...(options.withAppearance
                    ? { AP: doc.context.obj({ N: doc.context.register(doc.context.formXObject([], {})) }) }
                    : {}),
            });
            pageRefs.push(doc.context.register(dict));
        }
        if (pageRefs.length > 0) {
            page.node.set(PDFName.of('Annots'), doc.context.obj(pageRefs));
        }
        refs.push(pageRefs);
    }
    return {
        bytes: new Uint8Array(await doc.save()),
        refs,
    };
}

async function createPdfWithFreeTextNotes(notes: Array<{
    pageIndex: number;
    rect: [number, number, number, number];
    contents?: string;
    withPopup?: boolean;
}>) {
    const doc = await PDFDocument.create();
    const pageMap = new Map<number, ReturnType<typeof doc.addPage>>();
    let maxPageIndex = -1;
    for (const note of notes) {
        if (note.pageIndex > maxPageIndex) {
            maxPageIndex = note.pageIndex;
        }
    }
    for (let i = 0; i <= maxPageIndex; i += 1) {
        pageMap.set(i, doc.addPage([
            600,
            800,
        ]));
    }

    const noteRefs: PDFRef[] = [];
    const refsByPage = new Map<number, PDFRef[]>();
    for (const note of notes) {
        const annotDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('FreeText'),
            Rect: [
                PDFNumber.of(note.rect[0]),
                PDFNumber.of(note.rect[1]),
                PDFNumber.of(note.rect[2]),
                PDFNumber.of(note.rect[3]),
            ],
        });
        if (note.contents !== undefined) {
            annotDict.set(PDFName.of('Contents'), PDFHexString.fromText(note.contents));
        }
        if (note.withPopup !== false) {
            const popupDict = doc.context.obj({
                Type: PDFName.of('Annot'),
                Subtype: PDFName.of('Popup'),
            });
            const popupRef = doc.context.register(popupDict);
            annotDict.set(PDFName.of('Popup'), popupRef);
        }
        const ref = doc.context.register(annotDict);
        noteRefs.push(ref);
        const list = refsByPage.get(note.pageIndex) ?? [];
        list.push(ref);
        refsByPage.set(note.pageIndex, list);
    }

    for (const [
        pageIndex,
        refs,
    ] of refsByPage.entries()) {
        const page = pageMap.get(pageIndex);
        if (!page) {
            continue;
        }
        page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
    }

    return {
        bytes: new Uint8Array(await doc.save()),
        noteRefs,
    };
}

function makeFreeTextComment(overrides: Partial<IAnnotationCommentSummary> & {
    pageIndex: number;
    markerRect: IAnnotationMarkerRect;
}): IAnnotationCommentSummary {
    return {
        id: 'comment',
        stableKey: 'comment',
        pageNumber: overrides.pageIndex + 1,
        text: '',
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'editor',
        ...overrides,
    };
}

describe('serializePdfEdits markup subtype rewrites', () => {
    it('rewrites Highlight to Underline using a ref override', async () => {
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[[
            60,
            480,
            180,
            680,
        ]]]);
        const targetRef = refs[0]![0]!;

        const payload = createEmptyPayload();
        const overrideTag = targetRef.generationNumber === 0
            ? `${targetRef.objectNumber}R`
            : `${targetRef.objectNumber}R${targetRef.generationNumber}`;
        payload.markupSubtypeOverrides = [[
            overrideTag,
                'Underline' satisfies TMarkupSubtype,
        ]];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
    });

    it('removes a stale Highlight appearance stream when rewriting subtype', async () => {
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[[
            60,
            480,
            180,
            680,
        ]]], { withAppearance: true });
        const targetRef = refs[0]![0]!;

        const payload = createEmptyPayload();
        payload.markupSubtypeOverrides = [[
            `${targetRef.objectNumber}R`,
                'Underline' satisfies TMarkupSubtype,
        ]];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeUndefined();
    });

    it('does not throw or mutate when override targets a missing ref', async () => {
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[[
            60,
            480,
            180,
            680,
        ]]]);
        const targetRef = refs[0]![0]!;

        const payload = createEmptyPayload();
        payload.markupSubtypeOverrides = [[
            '99999R',
                'StrikeOut' satisfies TMarkupSubtype,
        ]];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
    });

    it('uses subtype hints to rewrite when overrides do not match', async () => {
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[[
            60,
            480,
            180,
            680,
        ]]]);
        const targetRef = refs[0]![0]!;

        const payload = createEmptyPayload();
        const hint: IMarkupSubtypeHint = {
            subtype: 'StrikeOut',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.15,
                width: 0.2,
                height: 0.25,
            },
            consumed: false,
        };
        payload.markupSubtypeHints = [hint];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/StrikeOut');
    });

    it('does not consume the same hint twice across multiple highlights on a page', async () => {
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[
            [
                60,
                600,
                180,
                700,
            ],
            [
                300,
                100,
                400,
                200,
            ],
        ]]);
        const firstRef = refs[0]![0]!;
        const secondRef = refs[0]![1]!;

        const payload = createEmptyPayload();
        const sharedHint: IMarkupSubtypeHint = {
            subtype: 'Underline',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.125,
                width: 0.2,
                height: 0.125,
            },
            consumed: false,
        };
        payload.markupSubtypeHints = [sharedHint];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });

        const firstSubtype = getAnnotDict(doc, firstRef)?.get(PDFName.of('Subtype'))?.toString();
        const secondSubtype = getAnnotDict(doc, secondRef)?.get(PDFName.of('Subtype'))?.toString();
        const rewritten = [
            firstSubtype,
            secondSubtype,
        ].filter(value => value === '/Underline');
        expect(rewritten).toHaveLength(1);
    });
});

describe('serializePdfEdits free-text note rect application', () => {
    it('applies a comment marker rect onto a matching FreeText annotation', async () => {
        const {
            bytes,
            noteRefs,
        } = await createPdfWithFreeTextNotes([{
            pageIndex: 0,
            rect: [
                100,
                500,
                200,
                600,
            ],
            contents: 'note',
        }]);
        const noteRef = noteRefs[0]!;

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            annotationId: `${noteRef.objectNumber}R${noteRef.generationNumber}`,
            text: 'note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, noteRef);
        const rect = getRectNumbers(dict!);

        expect(rect).not.toBeNull();
        expect(rect!.length).toBe(4);
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
    });

    it('updates embedded note text by stable object ref even when comment cache is stale', async () => {
        const {
            bytes,
            noteRefs,
        } = await createPdfWithFreeTextNotes([{
            pageIndex: 0,
            rect: [
                100,
                500,
                200,
                600,
            ],
            contents: 'old note',
        }]);
        const noteRef = noteRefs[0]!;

        const payload = createEmptyPayload();
        payload.pendingEmbeddedTextUpdates = [[
            `ann:0:${noteRef.objectNumber}R${noteRef.generationNumber}`,
            'edited note',
        ]];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, noteRef);

        expect(getPdfDictContents(dict ?? null)).toBe('edited note');
    });

    it('ignores comments with malformed marker rects', async () => {
        const {
            bytes,
            noteRefs,
        } = await createPdfWithFreeTextNotes([{
            pageIndex: 0,
            rect: [
                100,
                500,
                200,
                600,
            ],
            contents: 'note',
        }]);
        const noteRef = noteRefs[0]!;

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            text: 'note',
            markerRect: {
                left: Number.NaN,
                top: 0,
                width: 0.5,
                height: 0.5,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, noteRef);
        const rect = getRectNumbers(dict!);

        expect(rect).toEqual([
            100,
            500,
            200,
            600,
        ]);
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeUndefined();
    });

    it('preserves existing application order for multiple comments on the same page', async () => {
        const {
            bytes,
            noteRefs,
        } = await createPdfWithFreeTextNotes([
            {
                pageIndex: 0,
                rect: [
                    100,
                    500,
                    200,
                    600,
                ],
                contents: 'first',
            },
            {
                pageIndex: 0,
                rect: [
                    300,
                    100,
                    400,
                    200,
                ],
                contents: 'second',
            },
        ]);
        const firstRef = noteRefs[0]!;
        const secondRef = noteRefs[1]!;

        const payload = createEmptyPayload();
        payload.freeTextComments = [
            makeFreeTextComment({
                pageIndex: 0,
                annotationId: `${firstRef.objectNumber}R${firstRef.generationNumber}`,
                text: 'first',
                markerRect: {
                    left: 0.1,
                    top: 0.05,
                    width: 0.2,
                    height: 0.1,
                },
            }),
            makeFreeTextComment({
                pageIndex: 0,
                annotationId: `${secondRef.objectNumber}R${secondRef.generationNumber}`,
                text: 'second',
                markerRect: {
                    left: 0.5,
                    top: 0.7,
                    width: 0.1,
                    height: 0.1,
                },
            }),
        ];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const firstDict = getAnnotDict(doc, firstRef);
        const secondDict = getAnnotDict(doc, secondRef);

        expect(getRectNumbers(firstDict!)).not.toEqual([
            100,
            500,
            200,
            600,
        ]);
        expect(getRectNumbers(secondDict!)).not.toEqual([
            300,
            100,
            400,
            200,
        ]);
        expect(firstDict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
        expect(secondDict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
    });

    it('skips FreeText annotations without a Popup entry', async () => {
        const {
            bytes,
            noteRefs,
        } = await createPdfWithFreeTextNotes([{
            pageIndex: 0,
            rect: [
                100,
                500,
                200,
                600,
            ],
            contents: 'note',
            withPopup: false,
        }]);
        const noteRef = noteRefs[0]!;

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            annotationId: `${noteRef.objectNumber}R${noteRef.generationNumber}`,
            text: 'note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.1,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, noteRef);

        expect(getRectNumbers(dict!)).toEqual([
            100,
            500,
            200,
            600,
        ]);
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeUndefined();
    });

    it('creates new FreeText popup notes directly from editor comments', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([
            600,
            800,
        ]);
        const bytes = new Uint8Array(await doc.save());

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            id: 'pdfjs_internal_editor_0',
            uid: 'pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: 'pdfjs_internal_editor_0',
            source: 'editor',
            subtype: 'FreeText',
            hasNote: true,
            text: 'large file note',
            author: 'Tester',
            color: 'rgba(255, 204, 0, 0.8)',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.02,
                height: 0.02,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const saved = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(saved);

        expect(annotRefs).toHaveLength(2);

        const freeTextRef = annotRefs.find((ref) => {
            const dict = getAnnotDict(saved, ref);
            return dict?.get(PDFName.of('Subtype'))?.toString() === '/FreeText';
        });
        const popupRef = annotRefs.find((ref) => {
            const dict = getAnnotDict(saved, ref);
            return dict?.get(PDFName.of('Subtype'))?.toString() === '/Popup';
        });

        expect(freeTextRef).toBeInstanceOf(PDFRef);
        expect(popupRef).toBeInstanceOf(PDFRef);

        const freeTextDict = getAnnotDict(saved, freeTextRef!);
        const popupDict = getAnnotDict(saved, popupRef!);

        expect(getPdfDictContents(freeTextDict ?? null)).toBe('large file note');
        expect(getPdfDictContents(popupDict ?? null)).toBe('large file note');
        expect(freeTextDict?.get(PDFName.of('Popup'))).toBe(popupRef);
        expect(popupDict?.get(PDFName.of('Parent'))).toBe(freeTextRef);
        expect(freeTextDict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
        expect(getNumberArray(freeTextDict!, 'C')).toEqual([
            1,
            0.8,
            0,
        ]);
        expect(getRectNumbers(freeTextDict!)).not.toBeNull();
        expect(getRectNumbers(popupDict!)).toEqual(getRectNumbers(freeTextDict!));
    });

    it('upserts directly-created FreeText popup notes by stable editor key', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([
            600,
            800,
        ]);

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            id: 'pdfjs_internal_editor_0',
            uid: 'pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: 'pdfjs_internal_editor_0',
            source: 'editor',
            subtype: 'FreeText',
            hasNote: true,
            text: 'first note text',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.02,
                height: 0.02,
            },
        })];

        const first = await serializePdfEdits(new Uint8Array(await doc.save()), payload);
        const firstSaved = await PDFDocument.load(first, { updateMetadata: false });
        const firstFreeTextRef = getPageAnnotRefs(firstSaved).find((ref) => {
            const dict = getAnnotDict(firstSaved, ref);
            return dict?.get(PDFName.of('Subtype'))?.toString() === '/FreeText';
        })!;
        const firstRect = getRectNumbers(getAnnotDict(firstSaved, firstFreeTextRef)!);
        payload.freeTextComments = [{
            ...payload.freeTextComments[0]!,
            text: 'edited note text',
            markerRect: {
                left: 0.2,
                top: 0.3,
                width: 0.02,
                height: 0.02,
            },
        }];
        const second = await serializePdfEdits(first, payload);
        const saved = await PDFDocument.load(second, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(saved);

        expect(annotRefs).toHaveLength(2);
        const freeTextRef = annotRefs.find((ref) => {
            const dict = getAnnotDict(saved, ref);
            return dict?.get(PDFName.of('Subtype'))?.toString() === '/FreeText';
        })!;
        const freeTextDict = getAnnotDict(saved, freeTextRef);

        expect(getPdfDictContents(freeTextDict ?? null)).toBe('edited note text');
        expect(getRectNumbers(freeTextDict!)).not.toEqual(firstRect);
    });
});
