import {
    PDFDocument,
    PDFHexString,
    PDFName,
} from 'pdf-lib';

export async function createEmbeddedShapeColorPdf(options: {includeOutOfRangeColors?: boolean} = {}) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);

    const grayAndCmykSquare = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Square'),
        Rect: [
            60,
            480,
            240,
            720,
        ],
        C: [0.5],
        IC: [
            0,
            1,
            1,
            0,
        ],
        Border: [
            0,
            0,
            0,
        ],
        EVBShapeKey: PDFHexString.fromText('evb-shape:gray-cmyk-square'),
    });
    const rgbCircle = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Circle'),
        Rect: [
            300,
            420,
            450,
            600,
        ],
        C: [
            0.2,
            0.4,
            0.6,
        ],
        Border: [
            0,
            0,
            2,
        ],
        EVBShapeKey: PDFHexString.fromText('evb-shape:rgb-circle'),
    });
    const unsupportedColorPolygon = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Polygon'),
        Rect: [
            260,
            140,
            500,
            340,
        ],
        Vertices: [
            280,
            320,
            480,
            300,
            430,
            180,
        ],
        C: [
            0.25,
            0.75,
        ],
        IC: [
            0.75,
            0.25,
        ],
        Border: [
            0,
            0,
            3,
        ],
        EVBShapeKey: PDFHexString.fromText('evb-shape:unsupported-color-polygon'),
    });

    const grayAndCmykSquareRef = doc.context.register(grayAndCmykSquare);
    const rgbCircleRef = doc.context.register(rgbCircle);
    const unsupportedColorPolygonRef = doc.context.register(unsupportedColorPolygon);
    const annotationRefs = [
        grayAndCmykSquareRef,
        rgbCircleRef,
        unsupportedColorPolygonRef,
    ];
    if (options.includeOutOfRangeColors) {
        annotationRefs.push(doc.context.register(doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Square'),
            Rect: [
                30,
                30,
                90,
                90,
            ],
            C: [1.5],
            EVBShapeKey: PDFHexString.fromText('evb-shape:out-of-range-gray'),
        })));
        annotationRefs.push(doc.context.register(doc.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Square'),
            Rect: [
                100,
                30,
                160,
                90,
            ],
            C: [
                0.5,
                2,
                -1,
            ],
            EVBShapeKey: PDFHexString.fromText('evb-shape:mixed-range-rgb'),
        })));
    }
    page.node.set(PDFName.of('Annots'), doc.context.obj(annotationRefs));

    return new Uint8Array(await doc.save());
}
