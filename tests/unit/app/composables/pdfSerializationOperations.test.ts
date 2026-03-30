import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRef,
} from 'pdf-lib';
import type { IShapeAnnotation } from '@app/types/annotations';
import {
    type IPdfSerializationSavePayload,
    serializePdfEdits,
} from '@app/composables/pdf/pdfSerializationOperations';

function createEmptyPayload(): IPdfSerializationSavePayload {
    return {
        markupSubtypeOverrides: [],
        markupSubtypeHints: [],
        shapes: [],
        deletedShapeAnnotationIds: [],
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
});
