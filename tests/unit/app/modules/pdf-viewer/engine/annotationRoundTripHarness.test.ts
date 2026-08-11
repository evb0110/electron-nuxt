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
    PDFRawStream,
    PDFRef,
} from 'pdf-lib';
import type { IShapeAnnotation } from '@app/types/annotations';
import {
    createAnnotationRoundTripPayload,
    createBlankRoundTripPdf,
    createRoundTripNote,
    runAnnotationRoundTrip,
} from '@tests/helpers/annotationRoundTripHarness';

const SHAPE_FIXTURES: IShapeAnnotation[] = [
    {
        id: 'rectangle',
        stableKey: 'rectangle',
        type: 'rectangle',
        pageIndex: 0,
        x: 0.08,
        y: 0.45,
        width: 0.1,
        height: 0.08,
        color: '#ff0000',
        opacity: 0.6,
        strokeWidth: 2,
    },
    {
        id: 'circle',
        stableKey: 'circle',
        type: 'circle',
        pageIndex: 0,
        x: 0.22,
        y: 0.45,
        width: 0.1,
        height: 0.08,
        color: '#00aa00',
        opacity: 0.7,
        strokeWidth: 2,
    },
    {
        id: 'line',
        stableKey: 'line',
        type: 'line',
        pageIndex: 0,
        x: 0.36,
        y: 0.45,
        width: 0.1,
        height: 0.08,
        x2: 0.46,
        y2: 0.53,
        color: '#0000ff',
        opacity: 0.8,
        strokeWidth: 2,
    },
    {
        id: 'arrow',
        stableKey: 'arrow',
        type: 'arrow',
        pageIndex: 0,
        x: 0.5,
        y: 0.45,
        width: 0.1,
        height: 0.08,
        x2: 0.6,
        y2: 0.53,
        color: '#9900ff',
        opacity: 0.9,
        strokeWidth: 2,
    },
    {
        id: 'polyline',
        stableKey: 'polyline',
        type: 'polyline',
        pageIndex: 0,
        x: 0.64,
        y: 0.45,
        width: 0.1,
        height: 0.08,
        color: '#008899',
        opacity: 1,
        strokeWidth: 2,
        points: [
            {
                x: 0.64,
                y: 0.53,
            },
            {
                x: 0.69,
                y: 0.45,
            },
            {
                x: 0.74,
                y: 0.53,
            },
        ],
    },
    {
        id: 'polygon',
        stableKey: 'polygon',
        type: 'polygon',
        pageIndex: 0,
        x: 0.78,
        y: 0.45,
        width: 0.1,
        height: 0.08,
        color: '#aa6600',
        opacity: 1,
        strokeWidth: 2,
        points: [
            {
                x: 0.78,
                y: 0.53,
            },
            {
                x: 0.83,
                y: 0.45,
            },
            {
                x: 0.88,
                y: 0.53,
            },
        ],
    },
    {
        id: 'ink',
        stableKey: 'evb-shape:ink',
        type: 'polyline',
        pageIndex: 0,
        x: 0.1,
        y: 0.65,
        width: 0.25,
        height: 0.08,
        color: '#2563eb',
        opacity: 0.65,
        strokeWidth: 2.5,
        points: [
            {
                x: 0.1,
                y: 0.7,
            },
            {
                x: 0.18,
                y: 0.65,
            },
            {
                x: 0.25,
                y: 0.73,
            },
        ],
        strokes: [[
            {
                x: 0.1,
                y: 0.7,
            },
            {
                x: 0.18,
                y: 0.65,
            },
            {
                x: 0.25,
                y: 0.73,
            },
        ]],
        pdfSubtype: 'Ink',
    },
];

async function createBoundaryAndLegacyFixture() {
    const document = await PDFDocument.create();
    const page = document.addPage([
        600,
        800,
    ]);
    const refs: PDFRef[] = [];
    const addFreeText = (name: string, text: string, size: number, popupText = text) => {
        const rectWidth = 600 * size;
        const rectHeight = 800 * size;
        const annotation = document.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('FreeText'),
            Rect: [
                PDFNumber.of(60),
                PDFNumber.of(600),
                PDFNumber.of(60 + rectWidth),
                PDFNumber.of(600 + rectHeight),
            ],
            Contents: PDFHexString.fromText(text),
            NM: PDFHexString.fromText(name),
        });
        const annotationRef = document.context.register(annotation);
        const popup = document.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of('Popup'),
            Parent: annotationRef,
            Rect: [
                PDFNumber.of(60),
                PDFNumber.of(600),
                PDFNumber.of(61),
                PDFNumber.of(601),
            ],
            Contents: PDFHexString.fromText(popupText),
        });
        const popupRef = document.context.register(popup);
        annotation.set(PDFName.of('Popup'), popupRef);
        refs.push(annotationRef, popupRef);
    };
    addFreeText('boundary-inclusive', 'inclusive', 0.02);
    addFreeText('boundary-exclusive', 'exclusive', 0.020001);
    addFreeText('legacy-zws', '\u200B', 0.01, 'legacy popup text');
    addFreeText('legacy-bom', '\uFEFF', 0.01, 'legacy popup text');
    addFreeText('duplicate-name', 'first duplicate', 0.01);
    addFreeText('duplicate-name', 'second duplicate', 0.01);
    page.node.set(PDFName.of('Annots'), document.context.obj(refs));
    return new Uint8Array(await document.save());
}

async function createOverlappingMarkupFixture() {
    const document = await PDFDocument.create();
    const page = document.addPage([
        600,
        800,
    ]);
    const refs = [
        'Highlight',
        'Underline',
        'Squiggly',
    ].map((subtype, index) => {
        const annotation = document.context.obj({
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of(subtype),
            Rect: [
                60,
                500,
                300,
                540,
            ],
            QuadPoints: [
                60,
                540,
                300,
                540,
                60,
                500,
                300,
                500,
            ],
            NM: PDFHexString.fromText(`overlap-${index}`),
            Contents: PDFHexString.fromText(`markup-${subtype}`),
            C: [
                1,
                index / 3,
                0,
            ],
            CA: 0.5 + index / 10,
        });
        return document.context.register(annotation);
    });
    page.node.set(PDFName.of('Annots'), document.context.obj(refs));
    return new Uint8Array(await document.save());
}

describe('AnnotationRoundTripHarness', () => {
    it('reopens a serialized non-ASCII sticky note with stable identity and a blank appearance', async () => {
        const payload = createAnnotationRoundTripPayload();
        payload.freeTextComments = [createRoundTripNote('Հայերեն · Русский · 日本語')];

        const result = await runAnnotationRoundTrip(await createBlankRoundTripPdf(), payload);
        const note = result.truth.find(annotation => annotation.subtype === 'FreeText');

        expect(note).toMatchObject({
            annotationName: expect.stringContaining('annotation-round-trip-note'),
            hasLinkedPopup: true,
            markerEligible: true,
            text: 'Հայերեն · Русский · 日本語',
        });
        expect(result.textItems).not.toContain('Հայերեն · Русский · 日本語');
        expect(result.inkPixelCount).toBe(0);
    });

    it('makes the .02 marker boundary explicit and preserves duplicate external names', async () => {
        const result = await runAnnotationRoundTrip(
            await createBoundaryAndLegacyFixture(),
            createAnnotationRoundTripPayload(),
        );
        const byName = (name: string) => result.truth.filter(annotation => annotation.annotationName === name);

        expect(byName('boundary-inclusive')[0]?.markerEligible).toBe(true);
        expect(byName('boundary-exclusive')[0]?.markerEligible).toBe(false);
        expect(byName('duplicate-name')).toHaveLength(2);
        expect(byName('duplicate-name').map(annotation => annotation.text).sort()).toEqual([
            'first duplicate',
            'second duplicate',
        ]);
        expect(byName('legacy-zws')[0]?.text).toBe('\u200B');
        expect(byName('legacy-bom')[0]?.text).toBe('\uFEFF');
    });

    it('reopens every managed geometric shape subtype', async () => {
        const payload = createAnnotationRoundTripPayload();
        payload.shapes = SHAPE_FIXTURES;
        const result = await runAnnotationRoundTrip(await createBlankRoundTripPdf(), payload);

        expect(result.truth.map(annotation => annotation.subtype).sort()).toEqual([
            'Circle',
            'Ink',
            'Line',
            'Line',
            'PolyLine',
            'Polygon',
            'Square',
        ]);
        expect(result.truth.every(annotation => annotation.normalizedRect !== null)).toBe(true);

        const serialized = await PDFDocument.load(result.bytes, {updateMetadata: false});
        const annots = serialized.getPage(0).node.Annots();
        expect(annots).toBeInstanceOf(PDFArray);
        const inkDict = annots instanceof PDFArray
            ? Array.from({length: annots.size()}, (_, index) => annots.get(index))
                .filter((value): value is PDFRef => value instanceof PDFRef)
                .map(ref => serialized.context.lookupMaybe(ref, PDFDict))
                .find(dict => dict?.get(PDFName.of('Subtype'))?.toString() === '/Ink')
            : null;
        expect(inkDict).toBeInstanceOf(PDFDict);
        const appearance = inkDict?.lookupMaybe(PDFName.of('AP'), PDFDict);
        expect(appearance).toBeInstanceOf(PDFDict);
        const normalAppearance = appearance?.get(PDFName.of('N'));
        expect(normalAppearance ? serialized.context.lookup(normalAppearance) : null).toBeInstanceOf(PDFRawStream);
        expect((inkDict?.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0) & 4).toBe(4);
    });

    it('keeps overlapping text-markup subtype, identity, color, and opacity distinct', async () => {
        const result = await runAnnotationRoundTrip(
            await createOverlappingMarkupFixture(),
            createAnnotationRoundTripPayload(),
        );

        expect(result.truth.map(annotation => ({
            name: annotation.annotationName,
            opacity: annotation.opacity,
            subtype: annotation.subtype,
        }))).toEqual([
            {
                name: 'overlap-0',
                opacity: 0.5,
                subtype: 'Highlight',
            },
            {
                name: 'overlap-1',
                opacity: 0.6,
                subtype: 'Underline',
            },
            {
                name: 'overlap-2',
                opacity: 0.7,
                subtype: 'Squiggly',
            },
        ]);
        expect(result.truth.map(annotation => annotation.color)).toEqual([
            [
                255,
                0,
                0,
            ],
            [
                255,
                85,
                0,
            ],
            [
                255,
                170,
                0,
            ],
        ]);
    });
});
