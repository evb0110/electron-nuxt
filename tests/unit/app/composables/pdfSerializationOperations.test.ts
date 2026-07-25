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
import { serializePdfEdits } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits';
import { updateEmbeddedAnnotationText } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/updateEmbeddedAnnotationText';
import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { hasEmbeddedShapeCandidateBytes } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/scanDocumentForEmbeddedShapeCandidates';
import { readManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/readManagedShapeStableKey';
import { writeManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/writeManagedShapeStableKey';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import {
    getPdfDictContents,
    getPdfStringValue,
} from '@app/utils/pdfDict';

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

async function createPdfWithStampAnnotation() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);

    const stampDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Stamp'),
        Rect: [
            PDFNumber.of(120),
            PDFNumber.of(420),
            PDFNumber.of(260),
            PDFNumber.of(540),
        ],
        Contents: PDFHexString.fromText('Approved'),
    });
    const stampRef = doc.context.register(stampDict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([stampRef]));

    return {
        bytes: new Uint8Array(await doc.save()),
        stampRef,
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

function getColorNumbers(dict: PDFDict) {
    const color = dict.lookupMaybe(PDFName.of('C'), PDFArray);
    if (!(color instanceof PDFArray)) {
        return null;
    }

    const values: number[] = [];
    for (let index = 0; index < color.size(); index += 1) {
        const value = color.get(index);
        if (!(value instanceof PDFNumber)) {
            return null;
        }
        values.push(value.asNumber());
    }
    return values;
}

function getRectSize(rect: number[] | null) {
    if (!rect || rect.length !== 4) {
        return null;
    }
    return {
        width: Math.abs(rect[2]! - rect[0]!),
        height: Math.abs(rect[3]! - rect[1]!),
    };
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

describe('serializePdfEdits force rewrite', () => {
    it('returns original bytes when no serialization work is present', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([
            200,
            200,
        ]);
        const bytes = new Uint8Array(await doc.save());

        const result = await serializePdfEdits(bytes, createEmptyPayload());

        expect(result).toBe(bytes);
    });

    it('rewrites with pdf-lib when forceRewrite is requested without other edits', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([
            200,
            200,
        ]);
        const bytes = new Uint8Array(await doc.save());
        const payload = createEmptyPayload();
        payload.forceRewrite = true;

        const result = await serializePdfEdits(bytes, payload);

        expect(result).not.toBe(bytes);
        const rewritten = await PDFDocument.load(result, { updateMetadata: false });
        expect(rewritten.getPageCount()).toBe(1);
    });
});

describe('serializePdfEdits embedded geometric shapes', () => {
    it('preserves a managed shape through object-stream reopen and a second save', async () => {
        const { bytes: firstSave } = await createPdfWithManagedSquareAnnotation();

        expect(new TextDecoder().decode(firstSave)).toContain('/ObjStm');
        expect(hasEmbeddedShapeCandidateBytes(firstSave)).toBe(false);

        const reopenedShapes = await importEmbeddedShapeAnnotations(firstSave);
        expect(reopenedShapes).toEqual([expect.objectContaining({
            stableKey: 'evb-shape:managed-square',
            source: 'embedded',
            type: 'rectangle',
        })]);

        const payload = createEmptyPayload();
        payload.rewriteShapeState = true;
        payload.shapes = reopenedShapes;
        const secondSave = await serializePdfEdits(firstSave, payload);

        expect(hasEmbeddedShapeCandidateBytes(secondSave)).toBe(false);
        await expect(importEmbeddedShapeAnnotations(secondSave)).resolves.toEqual([expect.objectContaining({
            stableKey: 'evb-shape:managed-square',
            source: 'embedded',
            type: 'rectangle',
        })]);
    });

    it('backfills EVBShapeKey when a managed shape only has /NM', async () => {
        const doc = await PDFDocument.create();
        const dict = PDFDict.withContext(doc.context);
        dict.set(PDFName.of('NM'), PDFHexString.fromText('evb-shape:managed-square'));

        expect(readManagedShapeStableKey(dict)).toBe('evb-shape:managed-square');
        expect(writeManagedShapeStableKey(dict, 'evb-shape:managed-square')).toBe(true);
        expect(getPdfStringValue(dict.get(PDFName.of('EVBShapeKey'))))
            .toBe('evb-shape:managed-square');
        expect(getPdfStringValue(dict.get(PDFName.of('NM'))))
            .toBe('evb-shape:managed-square');
    });

    it('fails when a remaining shape cannot be serialized to a document page', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([
            600,
            800,
        ]);
        const payload = createEmptyPayload();
        payload.shapes = [{
            id: 'shape-missing-page',
            stableKey: 'shape-missing-page',
            type: 'rectangle',
            pageIndex: 1,
            x: 0.2,
            y: 0.15,
            width: 0.25,
            height: 0.3,
            color: '#336699',
            opacity: 0.6,
            strokeWidth: 4,
            source: 'local',
        } satisfies IShapeAnnotation];

        await expect(serializePdfEdits(new Uint8Array(await doc.save()), payload))
            .rejects.toThrow(/Unable to serialize shape annotation/u);
    });

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

    it('removes embedded annotations from the canonical delete program during source replay', async () => {
        const {
            bytes,
            squareRef,
            lineRef,
        } = await createPdfWithSquareAndLineAnnotations();
        const lineId = `${lineRef.objectNumber}R${lineRef.generationNumber}`;
        const payload = createEmptyPayload();
        payload.canonicalAnnotationProgram = [{
            backend: 'pdf-lib-rewrite',
            order: 0,
            annotationId: 'anno-line' as never,
            operation: 'delete-annotation',
            fields: {
                identity: {
                    id: 'anno-line',
                    pdfRef: lineId,
                },
                pageIndex: 0,
                kind: 'text-markup',
            },
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });

        expect(getPageAnnotRefs(doc).map(ref => ref.toString())).toEqual([squareRef.toString()]);
        expect(getAnnotDict(doc, lineRef)).toBeInstanceOf(PDFDict);
    });

    it('leaves canonical shape deletes to the shape channel', async () => {
        const {
            bytes,
            squareRef,
            lineRef,
        } = await createPdfWithSquareAndLineAnnotations();
        const lineId = `${lineRef.objectNumber}R${lineRef.generationNumber}`;
        const payload = createEmptyPayload();
        payload.deletedShapeAnnotationIds = [lineId];
        payload.canonicalAnnotationProgram = [{
            backend: 'pdf-lib-rewrite',
            order: 0,
            annotationId: 'anno-line' as never,
            operation: 'delete-annotation',
            fields: {
                identity: {
                    id: 'anno-line',
                    pdfRef: lineId,
                },
                pageIndex: 0,
                kind: 'shape',
            },
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });

        expect(getPageAnnotRefs(doc).map(ref => ref.toString())).toEqual([squareRef.toString()]);
    });

    it('does not fail a save whose canonical shape delete targets a ref outside the serialized document', async () => {
        const {bytes} = await createPdfWithSquareAndLineAnnotations();
        const payload = createEmptyPayload();
        payload.rewriteShapeState = true;
        payload.deletedShapeAnnotationIds = ['9999R0'];
        payload.canonicalAnnotationProgram = [{
            backend: 'pdf-lib-rewrite',
            order: 0,
            annotationId: 'anno-shape' as never,
            operation: 'delete-annotation',
            fields: {
                identity: {
                    id: 'anno-shape',
                    pdfRef: '9999R0',
                },
                pageIndex: 0,
                kind: 'shape',
            },
        }];

        await expect(serializePdfEdits(bytes, payload)).resolves.toBeInstanceOf(Uint8Array);
    });

    it('removes queued embedded Stamp annotations during save serialization', async () => {
        const {
            bytes,
            stampRef,
        } = await createPdfWithStampAnnotation();

        const stampId = `${stampRef.objectNumber}R${stampRef.generationNumber}`;
        const payload = createEmptyPayload();
        payload.canonicalAnnotationProgram = [{
            backend: 'pdf-lib-rewrite',
            order: 0,
            annotationId: 'anno-stamp' as never,
            operation: 'delete-annotation',
            fields: {
                identity: {
                    id: 'anno-stamp',
                    pdfRef: stampId,
                },
                pageIndex: 0,
                kind: 'text-markup',
            },
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });

        expect(getPageAnnotRefs(doc)).toHaveLength(0);
        expect(getAnnotDict(doc, stampRef)).toBeInstanceOf(PDFDict);
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
        expect(getPdfStringValue(getAnnotDict(doc, squareRef)?.get(PDFName.of('NM'))))
            .toBe('evb-shape:managed-square');
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
    options: {
        colorsByPage?: number[][][];
        malformedColorsByPage?: boolean[][];
        malformedQuadPointsByPage?: boolean[][];
        opacitiesByPage?: number[][];
        quadPointsByPage?: number[][][];
        withAppearance?: boolean;
    } = {},
) {
    const doc = await PDFDocument.create();
    const refs: PDFRef[][] = [];
    for (const [
        pageIndex,
        pageRects,
    ] of rectsByPage.entries()) {
        const page = doc.addPage([
            600,
            800,
        ]);
        const pageRefs: PDFRef[] = [];
        for (const [
            rectIndex,
            rect,
        ] of pageRects.entries()) {
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
            const color = options.colorsByPage?.[pageIndex]?.[rectIndex];
            const malformedColor = options.malformedColorsByPage?.[pageIndex]?.[rectIndex] === true;
            if (malformedColor) {
                dict.set(PDFName.of('C'), PDFName.of('Nope'));
            } else if (color) {
                dict.set(PDFName.of('C'), doc.context.obj(color.map(value => PDFNumber.of(value))));
            }
            const opacity = options.opacitiesByPage?.[pageIndex]?.[rectIndex];
            if (typeof opacity === 'number') {
                dict.set(PDFName.of('CA'), PDFNumber.of(opacity));
            }
            const quadPoints = options.quadPointsByPage?.[pageIndex]?.[rectIndex];
            const malformedQuadPoints = options.malformedQuadPointsByPage?.[pageIndex]?.[rectIndex] === true;
            if (malformedQuadPoints) {
                dict.set(PDFName.of('QuadPoints'), PDFName.of('Nope'));
            } else if (quadPoints) {
                dict.set(PDFName.of('QuadPoints'), doc.context.obj(quadPoints.map(value => PDFNumber.of(value))));
            }
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

async function createSingleHighlight(
    options: Parameters<typeof createPdfWithHighlightAnnotations>[1] = {},
) {
    const {
        bytes,
        refs,
    } = await createPdfWithHighlightAnnotations([[[
        60,
        480,
        180,
        680,
    ]]], options);
    const targetRef = refs[0]![0]!;
    return {
        bytes,
        targetRef,
        refTag: targetRef.generationNumber === 0
            ? `${targetRef.objectNumber}R`
            : `${targetRef.objectNumber}R${targetRef.generationNumber}`,
    };
}

async function createPdfWithNativeTextMarkupAnnotation(subtype: TMarkupSubtype = 'Underline') {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);
    const dict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of(subtype),
        Rect: [
            PDFNumber.of(60),
            PDFNumber.of(480),
            PDFNumber.of(180),
            PDFNumber.of(680),
        ],
        C: [
            PDFNumber.of(0),
            PDFNumber.of(188),
            PDFNumber.of(212),
        ],
        CA: PDFNumber.of(0.7),
        AP: doc.context.obj({ N: doc.context.register(doc.context.formXObject([], {})) }),
    });
    const ref = doc.context.register(dict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));

    return {
        bytes: new Uint8Array(await doc.save()),
        ref,
    };
}

async function createPdfWithFreeTextNotes(notes: Array<{
    pageIndex: number;
    rect: [number, number, number, number];
    contents?: string;
    name?: string;
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
        if (note.name !== undefined) {
            annotDict.set(PDFName.of('NM'), PDFHexString.fromText(note.name));
        }
        let popupRef: PDFRef | null = null;
        if (note.withPopup !== false) {
            const popupDict = doc.context.obj({
                Type: PDFName.of('Annot'),
                Subtype: PDFName.of('Popup'),
            });
            popupRef = doc.context.register(popupDict);
            annotDict.set(PDFName.of('Popup'), popupRef);
        }
        const ref = doc.context.register(annotDict);
        if (popupRef) {
            const popupDict = doc.context.lookup(popupRef, PDFDict);
            popupDict.set(PDFName.of('Parent'), ref);
        }
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
        stableKey: 'ann:0:comment',
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
            targetRef,
            refTag: overrideTag,
        } = await createSingleHighlight();

        const payload = createEmptyPayload();
        payload.markupSubtypeOverrides = [[
            overrideTag,
                'Underline' satisfies TMarkupSubtype,
        ]];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
    });

    it('persists exact text markup hint colors to the annotation color', async () => {
        const {
            bytes,
            targetRef,
            refTag: overrideTag,
        } = await createSingleHighlight({
            opacitiesByPage: [[0.35]],
            withAppearance: true,
        });

        const payload = createEmptyPayload();
        payload.markupSubtypeHints = [{
            annotationId: overrideTag,
            subtype: 'Highlight',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.15,
                width: 0.2,
                height: 0.25,
            },
            color: '#336699',
            consumed: false,
            source: 'editor',
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
        expect(getColorNumbers(dict!)).toEqual([
            184 / 255,
            201 / 255,
            219 / 255,
        ]);
        expect(getPdfStringValue(dict?.get(PDFName.of('NM'))))
            .toMatch(/^evb-markup:/u);
        expect(dict?.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber()).toBe(1);
        expect(dict?.get(PDFName.of('AP'))).toBeUndefined();
    });

    it('preserves unchanged exact highlight opacity and appearance streams', async () => {
        const {
            bytes,
            targetRef,
            refTag,
        } = await createSingleHighlight({
            opacitiesByPage: [[0.35]],
            withAppearance: true,
        });

        const payload = createEmptyPayload();
        payload.markupSubtypeHints = [{
            annotationId: refTag,
            subtype: 'Highlight',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.15,
                width: 0.2,
                height: 0.25,
            },
            consumed: false,
            source: 'pdf',
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
        expect(dict?.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber()).toBe(0.35);
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
        expect(getPdfStringValue(dict?.get(PDFName.of('NM')))).toBe('');
    });

    it('preserves highlight opacity and appearance when the hinted color already matches', async () => {
        const {
            bytes,
            targetRef,
            refTag,
        } = await createSingleHighlight({
            colorsByPage: [[[
                184 / 255,
                201 / 255,
                219 / 255,
            ]]],
            opacitiesByPage: [[0.35]],
            withAppearance: true,
        });

        const payload = createEmptyPayload();
        payload.markupSubtypeHints = [{
            annotationId: refTag,
            subtype: 'Highlight',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.15,
                width: 0.2,
                height: 0.25,
            },
            color: '#336699',
            consumed: false,
            source: 'editor',
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
        expect(getColorNumbers(dict!)).toEqual([
            184 / 255,
            201 / 255,
            219 / 255,
        ]);
        expect(dict?.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber()).toBe(0.35);
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
        expect(getPdfStringValue(dict?.get(PDFName.of('NM')))).toBe('');
    });

    it('persists geometry-matched text markup hint colors to the annotation color', async () => {
        const {
            bytes,
            targetRef,
        } = await createSingleHighlight();

        const payload = createEmptyPayload();
        payload.markupSubtypeHints = [{
            subtype: 'Highlight',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.15,
                width: 0.2,
                height: 0.25,
            },
            color: '#22c55e',
            consumed: false,
            source: 'pdf',
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
        expect(getColorNumbers(dict!)).toEqual([
            178 / 255,
            235 / 255,
            199 / 255,
        ]);
    });

    it('lets a current exact Highlight hint neutralize a stale ref override', async () => {
        const {
            bytes,
            targetRef,
            refTag: overrideTag,
        } = await createSingleHighlight();

        const payload = createEmptyPayload();
        payload.markupSubtypeOverrides = [[
            overrideTag,
                'Underline' satisfies TMarkupSubtype,
        ]];
        payload.markupSubtypeHints = [{
            annotationId: overrideTag,
            subtype: 'Highlight',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.15,
                width: 0.2,
                height: 0.25,
            },
            consumed: false,
            source: 'pdf',
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
    });

    it('lets a current exact Highlight hint neutralize a stale exact live subtype hint', async () => {
        const {
            bytes,
            targetRef,
            refTag,
        } = await createSingleHighlight();
        const markerRect = {
            left: 0.1,
            top: 0.15,
            width: 0.2,
            height: 0.25,
        };

        const payload = createEmptyPayload();
        payload.markupSubtypeHints = [
            {
                annotationId: refTag,
                subtype: 'Underline',
                pageIndex: 0,
                markerRect,
                consumed: false,
                source: 'editor-live',
            },
            {
                annotationId: refTag,
                subtype: 'Highlight',
                pageIndex: 0,
                markerRect,
                consumed: false,
                source: 'pdf',
            },
        ];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
    });

    it('uses an exact PDF-sourced subtype hint to preserve a materialized Underline', async () => {
        const {
            bytes,
            targetRef,
            refTag,
        } = await createSingleHighlight();

        const payload = createEmptyPayload();
        payload.markupSubtypeHints = [{
            annotationId: refTag,
            subtype: 'Underline',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.15,
                width: 0.2,
                height: 0.25,
            },
            consumed: false,
            source: 'pdf',
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
    });

    it('removes a stale Highlight appearance stream when rewriting subtype', async () => {
        const {
            bytes,
            targetRef,
        } = await createSingleHighlight({ withAppearance: true });

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

    it('rewrites markup subtype when optional color and QuadPoints fields are malformed', async () => {
        const {
            bytes,
            targetRef,
        } = await createSingleHighlight({
            malformedColorsByPage: [[true]],
            malformedQuadPointsByPage: [[true]],
            withAppearance: true,
        });

        const payload = createEmptyPayload();
        payload.markupSubtypeOverrides = [[
            `${targetRef.objectNumber}R`,
                'Underline' satisfies TMarkupSubtype,
        ]];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
        expect(getNumberArray(dict!, 'QuadPoints')).toEqual([
            60,
            680,
            180,
            680,
            60,
            480,
            180,
            480,
        ]);
    });

    it('preserves StrikeOut color, opacity, and QuadPoints while handing reload appearance to PDF.js', async () => {
        const {
            bytes,
            targetRef,
        } = await createSingleHighlight({
            colorsByPage: [[[
                0,
                188,
                212,
            ]]],
            opacitiesByPage: [[0.7]],
            quadPointsByPage: [[[
                60,
                680,
                180,
                680,
                60,
                480,
                180,
                480,
            ]]],
            withAppearance: true,
        });

        const payload = createEmptyPayload();
        payload.markupSubtypeOverrides = [[
            `${targetRef.objectNumber}R`,
                'StrikeOut' satisfies TMarkupSubtype,
        ]];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/StrikeOut');
        expect(getNumberArray(dict!, 'C')).toEqual([
            0,
            188,
            212,
        ]);
        expect(dict?.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber()).toBe(0.7);
        expect(getNumberArray(dict!, 'QuadPoints')).toEqual([
            60,
            680,
            180,
            680,
            60,
            480,
            180,
            480,
        ]);
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeUndefined();
    });

    it('preserves native non-highlight markup appearance streams during unrelated saves', async () => {
        const {
            bytes,
            ref,
        } = await createPdfWithNativeTextMarkupAnnotation('Underline');

        const payload = createEmptyPayload();
        payload.markupSubtypeHints = [{
            annotationId: `${ref.objectNumber}R`,
            subtype: 'Underline',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.15,
                width: 0.2,
                height: 0.25,
            },
            consumed: false,
            source: 'pdf',
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, ref);

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
        expect(getNumberArray(dict!, 'QuadPoints')).toEqual([
            60,
            680,
            180,
            680,
            60,
            480,
            180,
            480,
        ]);
    });

    it('keeps rewritten text markup stable across repeated saves', async () => {
        const rects = [
            [
                60,
                640,
                220,
                700,
            ],
            [
                60,
                540,
                220,
                600,
            ],
            [
                60,
                440,
                220,
                500,
            ],
        ];
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([rects], {
            colorsByPage: [[
                [
                    1,
                    0.84,
                    0,
                ],
                [
                    0,
                    188,
                    212,
                ],
                [
                    244,
                    67,
                    54,
                ],
            ]],
            opacitiesByPage: [[
                0.6,
                0.7,
                0.8,
            ]],
            withAppearance: true,
        });
        const highlightRef = refs[0]![0]!;
        const underlineRef = refs[0]![1]!;
        const strikeoutRef = refs[0]![2]!;

        const payload = createEmptyPayload();
        payload.markupSubtypeOverrides = [
            [
                `${underlineRef.objectNumber}R`,
                'Underline' satisfies TMarkupSubtype,
            ],
            [
                `${strikeoutRef.objectNumber}R`,
                'StrikeOut' satisfies TMarkupSubtype,
            ],
        ];

        const firstSave = await serializePdfEdits(bytes, payload);
        const secondSave = await serializePdfEdits(firstSave, payload);
        const snapshotMarkup = async (savedBytes: Uint8Array) => {
            const doc = await PDFDocument.load(savedBytes, { updateMetadata: false });
            return [
                highlightRef,
                underlineRef,
                strikeoutRef,
            ].map((ref) => {
                const dict = getAnnotDict(doc, ref)!;
                return {
                    hasAppearance: Boolean(dict.lookupMaybe(PDFName.of('AP'), PDFDict)),
                    color: getNumberArray(dict, 'C'),
                    opacity: dict.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber() ?? null,
                    quadPoints: getNumberArray(dict, 'QuadPoints'),
                    subtype: dict.get(PDFName.of('Subtype'))?.toString(),
                };
            });
        };

        expect(await snapshotMarkup(secondSave)).toEqual(await snapshotMarkup(firstSave));
    });

    it('clips overlapping saved highlight QuadPoints when rewriting to Underline', async () => {
        const overlappingQuadPoints = [
            60,
            700,
            520,
            700,
            60,
            520,
            520,
            520,
            60,
            580,
            520,
            580,
            60,
            400,
            520,
            400,
        ];
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[[
            60,
            400,
            520,
            700,
        ]]], { quadPointsByPage: [[overlappingQuadPoints]] });
        const targetRef = refs[0]![0]!;

        const payload = createEmptyPayload();
        payload.markupSubtypeOverrides = [[
            `${targetRef.objectNumber}R`,
                'Underline' satisfies TMarkupSubtype,
        ]];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, targetRef);
        const quadPoints = getNumberArray(dict!, 'QuadPoints');

        expect(dict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
        expect(quadPoints).toEqual([
            60,
            700,
            520,
            700,
            60,
            550,
            520,
            550,
            60,
            550,
            520,
            550,
            60,
            400,
            520,
            400,
        ]);
    });

    it('does not throw or mutate when override targets a missing ref', async () => {
        const {
            bytes,
            targetRef,
        } = await createSingleHighlight();

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
            targetRef,
        } = await createSingleHighlight();

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

    it('does not let comment-derived underline hints migrate onto a highlight', async () => {
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[[
            60,
            600,
            360,
            700,
        ]]]);
        const highlightRef = refs[0]![0]!;

        const payload = createEmptyPayload();
        payload.markupSubtypeHints = [{
            id: 'stale-comment-summary',
            subtype: 'Underline',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.125,
                width: 0.5,
                height: 0.125,
            },
            consumed: false,
            source: 'editor',
        }];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });

        expect(getAnnotDict(doc, highlightRef)?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
    });

    it('keeps an existing highlight when a new overlapping underline is materialized as Highlight', async () => {
        const sharedRect = [
            60,
            600,
            360,
            700,
        ];
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[
            sharedRect,
            sharedRect,
        ]], { colorsByPage: [[
            [
                1,
                0.84,
                0,
            ],
            [
                0.13,
                0.77,
                0.37,
            ],
        ]] });
        const highlightRef = refs[0]![0]!;
        const underlineRef = refs[0]![1]!;

        const payload = createEmptyPayload();
        const markerRect: IAnnotationMarkerRect = {
            left: 0.1,
            top: 0.125,
            width: 0.5,
            height: 0.125,
        };
        payload.markupSubtypeHints = [
            {
                id: 'new-underline-editor',
                subtype: 'Underline',
                pageIndex: 0,
                markerRect,
                color: '#22c55e',
                consumed: false,
                pageMarkupIndex: 0,
            },
            {
                id: 'existing-highlight-comment',
                annotationId: `${highlightRef.objectNumber}R`,
                subtype: 'Highlight',
                pageIndex: 0,
                markerRect,
                color: '#ffd400',
                consumed: false,
                pageMarkupIndex: 0,
            },
        ];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });

        expect(getAnnotDict(doc, highlightRef)?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
        expect(getAnnotDict(doc, underlineRef)?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
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

    it('does not apply a duplicated underline hint to an overlapping highlight', async () => {
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[
            [
                60,
                600,
                360,
                700,
            ],
            [
                60,
                600,
                180,
                700,
            ],
        ]]);
        const highlightRef = refs[0]![0]!;
        const underlineRef = refs[0]![1]!;

        const payload = createEmptyPayload();
        const underlineHint: IMarkupSubtypeHint = {
            id: 'editor:0:underline',
            subtype: 'Underline',
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.125,
                width: 0.2,
                height: 0.125,
            },
            consumed: false,
            pageMarkupIndex: 1,
        };
        payload.markupSubtypeHints = [
            {
                ...underlineHint,
                pageMarkupIndex: null,
            },
            underlineHint,
        ];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });

        expect(getAnnotDict(doc, highlightRef)?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
        expect(getAnnotDict(doc, underlineRef)?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
    });

    it('does not let a duplicate underline hint with a later identity rewrite an overlapping highlight', async () => {
        const {
            bytes,
            refs,
        } = await createPdfWithHighlightAnnotations([[
            [
                60,
                600,
                360,
                700,
            ],
            [
                60,
                600,
                180,
                700,
            ],
        ]]);
        const highlightRef = refs[0]![0]!;
        const underlineRef = refs[0]![1]!;

        const payload = createEmptyPayload();
        payload.markupSubtypeHints = [
            {
                id: 'runtime-editor-id',
                subtype: 'Underline',
                pageIndex: 0,
                markerRect: {
                    left: 0.1,
                    top: 0.125,
                    width: 0.2,
                    height: 0.125,
                },
                consumed: false,
                pageMarkupIndex: 1,
            },
            {
                id: 'comment-summary-id',
                subtype: 'Underline',
                pageIndex: 0,
                markerRect: {
                    left: 0.1,
                    top: 0.125,
                    width: 0.2,
                    height: 0.125,
                },
                consumed: false,
                pageMarkupIndex: 0,
            },
        ];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });

        expect(getAnnotDict(doc, highlightRef)?.get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
        expect(getAnnotDict(doc, underlineRef)?.get(PDFName.of('Subtype'))?.toString()).toBe('/Underline');
    });
});

describe('serializePdfEdits free-text note rect application', () => {
    it('fails when a pending embedded note text update cannot resolve its target', async () => {
        const { bytes } = await createPdfWithFreeTextNotes([{
            pageIndex: 0,
            rect: [
                100,
                500,
                200,
                600,
            ],
            contents: 'note',
        }]);
        const payload = createEmptyPayload();
        payload.pendingEmbeddedTextUpdates = [[
            'missing-stable-key',
            'updated note',
        ]];

        await expect(serializePdfEdits(bytes, payload))
            .rejects.toThrow(/Unable to apply embedded note text updates/u);
    });

    it('normalizes a large comment marker rect before applying it to a FreeText note', async () => {
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
        const rectSize = getRectSize(rect);

        expect(rect).not.toBeNull();
        expect(rect!.length).toBe(4);
        expect(rectSize?.width).toBeLessThanOrEqual(2);
        expect(rectSize?.height).toBeLessThanOrEqual(2);
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
    });

    it('keeps the linked Popup rect aligned when moving an existing FreeText note', async () => {
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
                left: 0.45,
                top: 0.35,
                width: 0.02,
                height: 0.02,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, noteRef);
        const popupRef = dict?.get(PDFName.of('Popup'));
        const popupDict = popupRef instanceof PDFRef ? getAnnotDict(doc, popupRef) : null;

        expect(popupDict).toBeInstanceOf(PDFDict);
        expect(getRectNumbers(popupDict!)).toEqual(getRectNumbers(dict!));
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

    it('matches an existing FreeText note by direct PDF ref before geometry or text fallbacks', async () => {
        const firstRect = [
            100,
            500,
            200,
            600,
        ] as [number, number, number, number];
        const secondRect = [
            300,
            100,
            400,
            200,
        ] as [number, number, number, number];
        const {
            bytes,
            noteRefs,
        } = await createPdfWithFreeTextNotes([
            {
                pageIndex: 0,
                rect: firstRect,
                contents: 'first',
            },
            {
                pageIndex: 0,
                rect: secondRect,
                contents: 'second',
            },
        ]);
        const firstRef = noteRefs[0]!;
        const secondRef = noteRefs[1]!;

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            annotationId: `${firstRef.objectNumber}R${firstRef.generationNumber}`,
            text: 'second',
            markerRect: {
                left: 0.5,
                top: 0.7,
                width: 0.1,
                height: 0.1,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const firstDict = getAnnotDict(doc, firstRef);
        const secondDict = getAnnotDict(doc, secondRef);

        expect(getRectNumbers(firstDict!)).not.toEqual(firstRect);
        expect(firstDict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
        expect(getRectNumbers(secondDict!)).toEqual(secondRect);
        expect(secondDict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeUndefined();
    });

    it('does not apply singleton fallback when multiple FreeText popup notes share a page', async () => {
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
                contents: 'target',
            },
            {
                pageIndex: 0,
                rect: [
                    300,
                    100,
                    400,
                    200,
                ],
                contents: 'unrelated',
            },
        ]);
        const targetRef = noteRefs[0]!;
        const unrelatedRef = noteRefs[1]!;

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            annotationId: `${targetRef.objectNumber}R${targetRef.generationNumber}`,
            text: 'target',
            markerRect: {
                left: 0.1,
                top: 0.05,
                width: 0.2,
                height: 0.1,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const targetDict = getAnnotDict(doc, targetRef);
        const unrelatedDict = getAnnotDict(doc, unrelatedRef);

        expect(getRectNumbers(targetDict!)).not.toEqual([
            100,
            500,
            200,
            600,
        ]);
        expect(targetDict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
        expect(getRectNumbers(unrelatedDict!)).toEqual([
            300,
            100,
            400,
            200,
        ]);
        expect(unrelatedDict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeUndefined();
    });

    it('does not reuse one FreeText comment match for multiple embedded notes', async () => {
        const firstRect = [
            100,
            500,
            200,
            600,
        ];
        const secondRect = [
            300,
            100,
            400,
            200,
        ];
        const {
            bytes,
            noteRefs,
        } = await createPdfWithFreeTextNotes([
            {
                pageIndex: 0,
                rect: firstRect as [number, number, number, number],
                contents: 'same',
            },
            {
                pageIndex: 0,
                rect: secondRect as [number, number, number, number],
                contents: 'same',
            },
        ]);
        const firstRef = noteRefs[0]!;
        const secondRef = noteRefs[1]!;

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            text: 'same',
            markerRect: {
                left: 0.72,
                top: 0.12,
                width: 0.02,
                height: 0.02,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const firstDict = getAnnotDict(doc, firstRef);
        const secondDict = getAnnotDict(doc, secondRef);

        expect(getRectNumbers(firstDict!)).not.toEqual(firstRect);
        expect(firstDict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
        expect(getRectNumbers(secondDict!)).toEqual(secondRect);
        expect(secondDict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeUndefined();
    });

    it('keeps narrow singleton fallback for one FreeText popup candidate and one comment', async () => {
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
            contents: 'saved note',
        }]);
        const noteRef = noteRefs[0]!;

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            text: 'different cached text',
            markerRect: {
                left: 0.8,
                top: 0.8,
                width: 0.02,
                height: 0.02,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const dict = getAnnotDict(doc, noteRef);

        expect(getRectNumbers(dict!)).not.toEqual([
            100,
            500,
            200,
            600,
        ]);
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
    });

    it('blanks FreeText popup appearance before direct embedded text updates', async () => {
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

        const result = await updateEmbeddedAnnotationText(
            bytes,
            makeFreeTextComment({
                pageIndex: 0,
                annotationId: `${noteRef.objectNumber}R${noteRef.generationNumber}`,
                text: 'old note',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.1,
                },
            }),
            'edited note',
        );
        expect(result).not.toBeNull();

        const doc = await PDFDocument.load(result!, { updateMetadata: false });
        const dict = getAnnotDict(doc, noteRef);
        const rectSize = getRectSize(getRectNumbers(dict!));

        expect(getPdfDictContents(dict ?? null)).toBe('edited note');
        expect(rectSize?.width).toBeLessThanOrEqual(2);
        expect(rectSize?.height).toBeLessThanOrEqual(2);
        expect(dict?.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
    });

    it('returns null instead of mixed sentinel values when embedded text target is missing', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([
            600,
            800,
        ]);
        const bytes = new Uint8Array(await doc.save());

        const result = await updateEmbeddedAnnotationText(
            bytes,
            makeFreeTextComment({
                pageIndex: 0,
                annotationId: '999999R0',
                text: 'missing note',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.3,
                    height: 0.1,
                },
            }),
            'edited note',
        );

        expect(result).toBeNull();
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
                width: 0.3,
                height: 0.1,
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
        const freeTextRect = getRectNumbers(freeTextDict!);
        const freeTextRectSize = getRectSize(freeTextRect);
        expect(freeTextRect).not.toBeNull();
        expect(freeTextRectSize?.width).toBeLessThanOrEqual(2);
        expect(freeTextRectSize?.height).toBeLessThanOrEqual(2);
        expect(getRectNumbers(popupDict!)).toEqual(getRectNumbers(freeTextDict!));
    });

    it('does not overwrite existing embedded FreeText notes when replaying editor-only notes', async () => {
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
            contents: 'existing embedded note',
            name: 'evb-note:uid:0:pdfjs_internal_editor_0',
        }]);
        const existingRef = noteRefs[0]!;

        const payload = createEmptyPayload();
        payload.freeTextComments = [
            makeFreeTextComment({
                pageIndex: 0,
                annotationId: `${existingRef.objectNumber}R${existingRef.generationNumber}`,
                source: 'pdf',
                subtype: 'FreeText',
                hasNote: true,
                text: 'existing embedded note',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.01,
                    height: 0.01,
                },
            }),
            makeFreeTextComment({
                pageIndex: 0,
                id: 'pdfjs_internal_editor_0',
                uid: 'pdfjs_internal_editor_0',
                stableKey: 'uid:0:pdfjs_internal_editor_0',
                annotationId: null,
                source: 'editor',
                subtype: 'Typewriter',
                hasNote: true,
                text: 'new editor note',
                markerRect: {
                    left: 0.7,
                    top: 0.24,
                    width: 0.01,
                    height: 0.01,
                },
            }),
        ];

        const result = await serializePdfEdits(bytes, payload);
        const saved = await PDFDocument.load(result, { updateMetadata: false });
        const freeTextRefs = getPageAnnotRefs(saved).filter((ref) => {
            const dict = getAnnotDict(saved, ref);
            return dict?.get(PDFName.of('Subtype'))?.toString() === '/FreeText';
        });
        const contents = freeTextRefs.map(ref => getPdfDictContents(getAnnotDict(saved, ref) ?? null));

        expect(freeTextRefs).toHaveLength(2);
        expect(contents).toContain('existing embedded note');
        expect(contents).toContain('new editor note');
        expect(getPdfDictContents(getAnnotDict(saved, existingRef) ?? null)).toBe('existing embedded note');
    });

    it('uses creation time to avoid legacy replay-name collisions for new editor notes', async () => {
        const { bytes } = await createPdfWithFreeTextNotes([{
            pageIndex: 0,
            rect: [
                100,
                500,
                200,
                600,
            ],
            contents: 'legacy embedded note',
            name: 'evb-note:uid:0:pdfjs_internal_editor_0',
        }]);

        const payload = createEmptyPayload();
        payload.freeTextComments = [makeFreeTextComment({
            pageIndex: 0,
            id: 'pdfjs_internal_editor_0',
            uid: 'pdfjs_internal_editor_0',
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            annotationId: null,
            source: 'editor',
            subtype: 'Typewriter',
            hasNote: true,
            text: 'fresh editor note',
            createdAt: 1780531944655,
            markerRect: {
                left: 0.7,
                top: 0.24,
                width: 0.01,
                height: 0.01,
            },
        })];

        const result = await serializePdfEdits(bytes, payload);
        const saved = await PDFDocument.load(result, { updateMetadata: false });
        const freeTextRefs = getPageAnnotRefs(saved).filter((ref) => {
            const dict = getAnnotDict(saved, ref);
            return dict?.get(PDFName.of('Subtype'))?.toString() === '/FreeText';
        });
        const contents = freeTextRefs.map(ref => getPdfDictContents(getAnnotDict(saved, ref) ?? null));
        const names = freeTextRefs.map(ref => getPdfStringValue(getAnnotDict(saved, ref)?.get(PDFName.of('NM'))));

        expect(freeTextRefs).toHaveLength(2);
        expect(contents).toContain('legacy embedded note');
        expect(contents).toContain('fresh editor note');
        expect(names).toContain('evb-note:uid:0:pdfjs_internal_editor_0:created:1780531944655');
    });

    it('creates multiple new FreeText popup notes on the same page without overwriting earlier notes', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([
            600,
            800,
        ]);
        const bytes = new Uint8Array(await doc.save());

        const payload = createEmptyPayload();
        payload.freeTextComments = [
            makeFreeTextComment({
                pageIndex: 0,
                id: 'pdfjs_internal_editor_0',
                uid: 'pdfjs_internal_editor_0',
                stableKey: 'uid:0:pdfjs_internal_editor_0',
                annotationId: 'pdfjs_internal_editor_0',
                source: 'editor',
                subtype: 'FreeText',
                hasNote: true,
                text: 'first same-page note',
                markerRect: {
                    left: 0.1,
                    top: 0.2,
                    width: 0.001,
                    height: 0.001,
                },
            }),
            makeFreeTextComment({
                pageIndex: 0,
                id: 'pdfjs_internal_editor_1',
                uid: 'pdfjs_internal_editor_1',
                stableKey: 'uid:0:pdfjs_internal_editor_1',
                annotationId: 'pdfjs_internal_editor_1',
                source: 'editor',
                subtype: 'FreeText',
                hasNote: true,
                text: 'second same-page note',
                markerRect: {
                    left: 0.4,
                    top: 0.3,
                    width: 0.001,
                    height: 0.001,
                },
            }),
        ];

        const result = await serializePdfEdits(bytes, payload);
        const saved = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(saved);
        const freeTextRefs = annotRefs.filter((ref) => (
            getAnnotDict(saved, ref)?.get(PDFName.of('Subtype'))?.toString() === '/FreeText'
        ));
        const popupRefs = annotRefs.filter((ref) => (
            getAnnotDict(saved, ref)?.get(PDFName.of('Subtype'))?.toString() === '/Popup'
        ));

        expect(annotRefs).toHaveLength(4);
        expect(freeTextRefs).toHaveLength(2);
        expect(popupRefs).toHaveLength(2);

        const notesByName = new Map(freeTextRefs.map((ref) => {
            const dict = getAnnotDict(saved, ref)!;
            return [
                getPdfStringValue(dict.get(PDFName.of('NM'))),
                {
                    dict,
                    ref,
                },
            ];
        }));

        for (const comment of payload.freeTextComments) {
            const note = notesByName.get(`evb-note:${comment.stableKey}`);
            expect(note).toBeDefined();
            expect(getPdfDictContents(note?.dict ?? null)).toBe(comment.text);
            expect(note?.dict.lookupMaybe(PDFName.of('AP'), PDFDict)).toBeInstanceOf(PDFDict);
            const freeTextRect = getRectNumbers(note!.dict);
            const freeTextRectSize = getRectSize(freeTextRect);
            expect(freeTextRectSize?.width).toBeLessThanOrEqual(2);
            expect(freeTextRectSize?.height).toBeLessThanOrEqual(2);

            const popupRef = note?.dict.get(PDFName.of('Popup'));
            expect(popupRef).toBeInstanceOf(PDFRef);
            const popupDict = getAnnotDict(saved, popupRef as PDFRef);
            expect(popupDict?.get(PDFName.of('Parent'))).toBe(note?.ref);
            expect(getPdfDictContents(popupDict ?? null)).toBe(comment.text);
            expect(getRectNumbers(popupDict!)).toEqual(freeTextRect);
        }
    });

    it('adopts PDF.js-created FreeText popup notes without adding a duplicate', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([
            600,
            800,
        ]);
        const annotDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('FreeText'),
            Rect: [
                PDFNumber.of(60),
                PDFNumber.of(632),
                PDFNumber.of(61),
                PDFNumber.of(633),
            ],
            Contents: PDFHexString.fromText('large file note'),
        });
        const annotRef = doc.context.register(annotDict);
        const popupDict = doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Popup'),
            Parent: annotRef,
            Rect: [
                PDFNumber.of(60),
                PDFNumber.of(632),
                PDFNumber.of(61),
                PDFNumber.of(633),
            ],
            Contents: PDFHexString.fromText('large file note'),
        });
        const popupRef = doc.context.register(popupDict);
        annotDict.set(PDFName.of('Popup'), popupRef);
        page.node.set(PDFName.of('Annots'), doc.context.obj([
            annotRef,
            popupRef,
        ]));

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
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.01,
                height: 0.01,
            },
        })];

        const result = await serializePdfEdits(new Uint8Array(await doc.save()), payload);
        const saved = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(saved);
        const freeTextRefs = annotRefs.filter((ref) => (
            getAnnotDict(saved, ref)?.get(PDFName.of('Subtype'))?.toString() === '/FreeText'
        ));
        const popupRefs = annotRefs.filter((ref) => (
            getAnnotDict(saved, ref)?.get(PDFName.of('Subtype'))?.toString() === '/Popup'
        ));

        expect(annotRefs).toHaveLength(2);
        expect(freeTextRefs).toHaveLength(1);
        expect(popupRefs).toHaveLength(1);

        const freeTextDict = getAnnotDict(saved, freeTextRefs[0]!);
        expect(getPdfStringValue(freeTextDict?.get(PDFName.of('NM')))).toBe('evb-note:uid:0:pdfjs_internal_editor_0');
        expect(getPdfDictContents(freeTextDict ?? null)).toBe('large file note');
        expect(freeTextDict?.get(PDFName.of('Popup'))).toBe(popupRefs[0]);
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
