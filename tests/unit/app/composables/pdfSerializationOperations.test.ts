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
    IShapeAnnotation,
} from '@app/types/annotations';
import {
    type IPdfSerializationSavePayload,
    serializePdfEdits,
} from '@app/composables/pdf/pdfSerializationOperations';
import { importEmbeddedShapeAnnotations } from '@app/composables/pdf/pdfEmbeddedShapeAnnotations';

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
