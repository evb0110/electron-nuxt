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
import { serializePdfEdits } from '@app/utils/pdf-viewer/pdf-serialization-operations/serializePdfEdits';
import { readManagedShapeStableKey } from '@app/utils/pdf-viewer/pdf-serialization-refs/readManagedShapeStableKey';

async function createPdfWithEmbeddedShapes() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);

    const squareDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [
            60,
            520,
            180,
            680,
        ],
        C: [
            0,
            0,
            0,
        ],
        Border: [
            0,
            0,
            1,
        ],
    });
    const lineDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Line'),
        Rect: [
            70,
            630,
            250,
            710,
        ],
        L: [
            72,
            700,
            240,
            640,
        ],
        C: [
            0,
            0,
            0,
        ],
        Border: [
            0,
            0,
            2,
        ],
    });
    const polygonDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Polygon'),
        Rect: [
            295,
            635,
            435,
            705,
        ],
        Vertices: [
            300,
            700,
            360,
            640,
            430,
            690,
        ],
        C: [
            0,
            0,
            0,
        ],
        Border: [
            0,
            0,
            1,
        ],
    });
    const inkDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Ink'),
        Rect: [
            100,
            140,
            320,
            320,
        ],
        InkList: [[
            120,
            300,
            180,
            270,
            240,
            220,
            300,
            170,
        ]],
        C: [
            0.9,
            0.7,
            0.1,
        ],
        Border: [
            0,
            0,
            5,
        ],
    });

    const squareRef = doc.context.register(squareDict);
    const lineRef = doc.context.register(lineDict);
    const polygonRef = doc.context.register(polygonDict);
    const inkRef = doc.context.register(inkDict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([
        squareRef,
        lineRef,
        polygonRef,
        inkRef,
    ]));

    return {
        data: new Uint8Array(await doc.save()),
        squareRef,
        lineRef,
        polygonRef,
        inkRef,
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

function getLineEndings(dict: PDFDict) {
    const lineEndings = dict.lookupMaybe(PDFName.of('LE'), PDFArray);
    if (!(lineEndings instanceof PDFArray)) {
        return [];
    }

    return Array.from({ length: lineEndings.size() }, (_, index) => lineEndings.get(index)?.toString());
}

function refTag(ref: PDFRef) {
    return `${ref.objectNumber} ${ref.generationNumber} R`;
}

describe('serializePdfEdits embedded shapes', () => {
    it('updates embedded geometric annotations in place and deletes removed ones', async () => {
        const {
            data,
            squareRef,
            lineRef,
            polygonRef,
            inkRef,
        } = await createPdfWithEmbeddedShapes();
        const squareTag = `${squareRef.objectNumber}R${squareRef.generationNumber}`;
        const lineTag = `${lineRef.objectNumber}R${lineRef.generationNumber}`;
        const polygonTag = `${polygonRef.objectNumber}R${polygonRef.generationNumber}`;
        const inkTag = `${inkRef.objectNumber}R${inkRef.generationNumber}`;

        const shapes: IShapeAnnotation[] = [
            {
                id: 'shape-square',
                type: 'rectangle',
                pageIndex: 0,
                x: 0.2,
                y: 0.1,
                width: 0.25,
                height: 0.3,
                color: '#ff0000',
                fillColor: '#00ff00',
                opacity: 0.5,
                strokeWidth: 5,
                source: 'embedded',
                annotationId: squareTag,
                pdfSubtype: 'Square',
            },
            {
                id: 'shape-line',
                type: 'arrow',
                pageIndex: 0,
                x: 0.15,
                y: 0.2,
                width: 0,
                height: 0,
                x2: 0.7,
                y2: 0.25,
                color: '#112233',
                opacity: 0.8,
                strokeWidth: 3,
                lineStartStyle: 'openArrow',
                lineEndStyle: 'closedArrow',
                source: 'embedded',
                annotationId: lineTag,
                pdfSubtype: 'Line',
            },
            {
                id: 'shape-ink',
                type: 'polyline',
                pageIndex: 0,
                x: 0.2,
                y: 0.55,
                width: 0.3,
                height: 0.15,
                color: '#f0c000',
                opacity: 0.75,
                strokeWidth: 7,
                points: [
                    {
                        x: 0.2,
                        y: 0.55,
                    },
                    {
                        x: 0.3,
                        y: 0.58,
                    },
                    {
                        x: 0.38,
                        y: 0.63,
                    },
                    {
                        x: 0.5,
                        y: 0.7,
                    },
                ],
                source: 'embedded',
                annotationId: inkTag,
                pdfSubtype: 'Ink',
            },
        ];

        const result = await serializePdfEdits(data, {
            markupSubtypeOverrides: [],
            markupSubtypeHints: [],
            rewriteShapeState: true,
            shapes,
            deletedShapeAnnotationIds: [polygonTag],
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
        });

        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(doc);
        expect(annotRefs.map(ref => refTag(ref))).toEqual([
            refTag(squareRef),
            refTag(lineRef),
            refTag(inkRef),
        ]);

        const squareDict = getAnnotDict(doc, squareRef)!;
        const lineDict = getAnnotDict(doc, lineRef)!;
        const inkDict = getAnnotDict(doc, inkRef)!;
        expect(getRectNumbers(squareDict)).toEqual([
            expect.closeTo(120, 6),
            expect.closeTo(480, 6),
            expect.closeTo(270, 6),
            expect.closeTo(720, 6),
        ]);
        expect(squareDict.get(PDFName.of('IC'))).toBeTruthy();

        expect(getRectNumbers(lineDict)).toEqual([
            expect.closeTo(87, 6),
            expect.closeTo(597, 6),
            expect.closeTo(423, 6),
            expect.closeTo(643, 6),
        ]);
        expect(getLineEndings(lineDict)).toEqual([
            '/OpenArrow',
            '/ClosedArrow',
        ]);
        expect(inkDict.get(PDFName.of('Subtype'))?.toString()).toBe('/Ink');
        expect(inkDict.lookupMaybe(PDFName.of('InkList'), PDFArray)).toBeInstanceOf(PDFArray);
    });

    it('writes a stable key when updating an embedded annotation in place', async () => {
        const {
            data,
            squareRef,
        } = await createPdfWithEmbeddedShapes();
        const squareTag = `${squareRef.objectNumber}R${squareRef.generationNumber}`;

        const shapes: IShapeAnnotation[] = [{
            id: 'shape-square',
            stableKey: 'evb-shape:updated-square',
            type: 'rectangle',
            pageIndex: 0,
            x: 0.2,
            y: 0.1,
            width: 0.25,
            height: 0.3,
            color: '#ff0000',
            fillColor: '#00ff00',
            opacity: 0.5,
            strokeWidth: 5,
            source: 'embedded',
            annotationId: squareTag,
            pdfSubtype: 'Square',
        }];

        const result = await serializePdfEdits(data, {
            markupSubtypeOverrides: [],
            markupSubtypeHints: [],
            rewriteShapeState: false,
            shapes,
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
        });

        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const squareDict = getAnnotDict(doc, squareRef)!;
        expect(readManagedShapeStableKey(squareDict)).toBe('evb-shape:updated-square');
        expect(getRectNumbers(squareDict)).toEqual([
            expect.closeTo(120, 6),
            expect.closeTo(480, 6),
            expect.closeTo(270, 6),
            expect.closeTo(720, 6),
        ]);
    });
});
