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
    PDFRef,
} from 'pdf-lib';
import type { IShapeAnnotation } from '@app/types/annotations';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { serializePdfEdits } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits';
import { readManagedShapeStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/readManagedShapeStableKey';
import { createAnnotationRoundTripPayload } from '@tests/helpers/annotationRoundTripHarness';
import { readPdfRectFromDict } from '@pdf-core';

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;

const OFF_PAGE_SQUARE_KEY = 'evb-shape:off-page-square';
const ON_PAGE_SQUARE_KEY = 'evb-shape:on-page-square';
const OFF_PAGE_CIRCLE_KEY = 'evb-shape:off-page-circle';
const LINE_KEY = 'evb-shape:stale-ic-line';
const POLYGON_KEY = 'evb-shape:filled-polygon';

/**
 * This square crosses the left and top page edges. Marker geometry is clamped
 * into the unit page box for rendering and cannot express that, so a save that
 * did not touch the shape has to leave these exact numbers alone.
 */
const OFF_PAGE_SQUARE_RECT = [
    -40,
    700,
    120,
    900,
];

const ON_PAGE_SQUARE_RECT = [
    200,
    200,
    320,
    300,
];

/** Crosses the right and bottom page edges, the mirror of the square case. */
const OFF_PAGE_CIRCLE_RECT = [
    520,
    -60,
    700,
    140,
];

interface IFixtureAnnotation {
    stableKey: string;
    dict: Record<string, unknown>;
}

const SQUARE_ANNOTATIONS: IFixtureAnnotation[] = [
    {
        stableKey: OFF_PAGE_SQUARE_KEY,
        dict: {
            Type: 'Annot',
            Subtype: 'Square',
            Rect: OFF_PAGE_SQUARE_RECT,
            C: [
                0.2,
                0.4,
                0.6,
            ],
            CA: 1,
            Border: [
                0,
                0,
                2,
            ],
        },
    },
    {
        stableKey: ON_PAGE_SQUARE_KEY,
        dict: {
            Type: 'Annot',
            Subtype: 'Square',
            Rect: ON_PAGE_SQUARE_RECT,
            C: [
                0.1,
                0.7,
                0.2,
            ],
            CA: 1,
            Border: [
                0,
                0,
                2,
            ],
        },
    },
];

/**
 * Square and Circle share one branch of the serializer, so a suite that only
 * covers Square proves nothing about the ellipse subtype.
 */
const CIRCLE_ANNOTATIONS: IFixtureAnnotation[] = [{
    stableKey: OFF_PAGE_CIRCLE_KEY,
    dict: {
        Type: 'Annot',
        Subtype: 'Circle',
        Rect: OFF_PAGE_CIRCLE_RECT,
        C: [
            0.2,
            0.4,
            0.6,
        ],
        CA: 1,
        Border: [
            0,
            0,
            2,
        ],
    },
}];

const INTERIOR_COLOR_ANNOTATIONS: IFixtureAnnotation[] = [
    {
        stableKey: LINE_KEY,
        dict: {
            Type: 'Annot',
            Subtype: 'Line',
            Rect: [
                100,
                300,
                400,
                500,
            ],
            L: [
                100,
                300,
                400,
                500,
            ],
            // A Line has no interior; producers still leave one behind.
            IC: [
                1,
                0,
                0,
            ],
            C: [
                0,
                0,
                0,
            ],
            CA: 1,
            Border: [
                0,
                0,
                2,
            ],
        },
    },
    {
        stableKey: POLYGON_KEY,
        dict: {
            Type: 'Annot',
            Subtype: 'Polygon',
            Rect: [
                100,
                100,
                200,
                250,
            ],
            Vertices: [
                100,
                100,
                200,
                150,
                150,
                250,
            ],
            IC: [
                0,
                0,
                1,
            ],
            C: [
                0,
                0,
                0,
            ],
            CA: 1,
            Border: [
                0,
                0,
                2,
            ],
        },
    },
];

async function createShapeFixturePdf(annotations: IFixtureAnnotation[] = SQUARE_ANNOTATIONS) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        PAGE_WIDTH,
        PAGE_HEIGHT,
    ]);

    const refs = annotations.map(({
        stableKey,
        dict,
    }) => doc.context.register(doc.context.obj({
        ...dict,
        EVBShapeKey: PDFHexString.fromText(stableKey),
        NM: PDFHexString.fromText(stableKey),
    })));
    page.node.set(PDFName.of('Annots'), doc.context.obj(refs));

    return new Uint8Array(await doc.save());
}

async function readShapeDictsByStableKey(bytes: Uint8Array) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const dicts = new Map<string, PDFDict>();
    doc.getPages().forEach((page) => {
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            return;
        }
        for (let index = 0; index < annots.size(); index += 1) {
            const value = annots.get(index);
            const dict = value instanceof PDFRef
                ? doc.context.lookup(value, PDFDict)
                : value instanceof PDFDict
                    ? value
                    : null;
            const stableKey = readManagedShapeStableKey(dict ?? null);
            if (stableKey && dict) {
                dicts.set(stableKey, dict);
            }
        }
    });
    return dicts;
}

async function readShapeRect(bytes: Uint8Array, stableKey: string) {
    const dict = (await readShapeDictsByStableKey(bytes)).get(stableKey);
    const rect = dict ? readPdfRectFromDict(dict) : null;
    return rect ? [...rect] : null;
}

function requireShape(shapes: IShapeAnnotation[], stableKey: string) {
    const shape = shapes.find(candidate => candidate.stableKey === stableKey);
    expect(shape, `imported shape ${stableKey}`).toBeDefined();
    return shape!;
}

function saveWithShapes(bytes: Uint8Array, shapes: IShapeAnnotation[]) {
    return serializePdfEdits(bytes, {
        ...createAnnotationRoundTripPayload(),
        rewriteShapeState: true,
        shapes,
    });
}

describe('embedded shape rect preservation on the serialized save route', () => {
    it('keeps the source rect of an untouched off-page square when another shape is edited', async () => {
        const bytes = await createShapeFixturePdf();
        const imported = await importEmbeddedShapeAnnotations(bytes);
        const offPage = requireShape(imported, OFF_PAGE_SQUARE_KEY);
        const onPage = requireShape(imported, ON_PAGE_SQUARE_KEY);

        // Rendering needs the clamp; persistence must not inherit it.
        expect(offPage.x).toBe(0);
        expect(offPage.y).toBe(0);

        const savedBytes = await saveWithShapes(bytes, [
            offPage,
            {
                ...onPage,
                x: onPage.x + 0.1,
            },
        ]);

        expect(await readShapeRect(savedBytes, OFF_PAGE_SQUARE_KEY)).toEqual(OFF_PAGE_SQUARE_RECT);
        expect((await readShapeRect(savedBytes, ON_PAGE_SQUARE_KEY))?.[0])
            .toBeCloseTo(ON_PAGE_SQUARE_RECT[0]! + 0.1 * PAGE_WIDTH, 6);

        // Reopening yields the same clamped marker geometry as the first import:
        // the shape did not shrink on disk.
        const reimportedOffPage = requireShape(
            await importEmbeddedShapeAnnotations(savedBytes),
            OFF_PAGE_SQUARE_KEY,
        );
        expect(reimportedOffPage.x).toBe(offPage.x);
        expect(reimportedOffPage.y).toBe(offPage.y);
        expect(reimportedOffPage.width).toBe(offPage.width);
        expect(reimportedOffPage.height).toBe(offPage.height);
    });

    it('survives repeated open-save cycles of the same untouched off-page square', async () => {
        let currentBytes: Uint8Array<ArrayBufferLike> = await createShapeFixturePdf();
        for (let pass = 0; pass < 3; pass += 1) {
            const imported = await importEmbeddedShapeAnnotations(currentBytes);
            currentBytes = await saveWithShapes(currentBytes, imported);
        }

        expect(await readShapeRect(currentBytes, OFF_PAGE_SQUARE_KEY)).toEqual(OFF_PAGE_SQUARE_RECT);
    });

    it('serializes the new geometry of an edited off-page square', async () => {
        const bytes = await createShapeFixturePdf();
        const offPage = requireShape(await importEmbeddedShapeAnnotations(bytes), OFF_PAGE_SQUARE_KEY);
        const moved: IShapeAnnotation = {
            ...offPage,
            x: offPage.x + 0.25,
            y: offPage.y + 0.1,
        };

        const savedBytes = await saveWithShapes(bytes, [moved]);
        const rect = await readShapeRect(savedBytes, OFF_PAGE_SQUARE_KEY);

        expect(rect).not.toEqual(OFF_PAGE_SQUARE_RECT);
        expect(rect?.[0]).toBeCloseTo(0.25 * PAGE_WIDTH, 6);
        expect(rect?.[2]).toBeCloseTo((0.25 + moved.width) * PAGE_WIDTH, 6);
    });

    it('serializes the new geometry of a resized on-page square', async () => {
        const bytes = await createShapeFixturePdf();
        const onPage = requireShape(await importEmbeddedShapeAnnotations(bytes), ON_PAGE_SQUARE_KEY);

        const savedBytes = await saveWithShapes(bytes, [{
            ...onPage,
            width: onPage.width / 2,
        }]);
        const rect = await readShapeRect(savedBytes, ON_PAGE_SQUARE_KEY);

        expect(rect?.[0]).toBeCloseTo(ON_PAGE_SQUARE_RECT[0]!, 6);
        expect(rect?.[2]).toBeCloseTo(
            ON_PAGE_SQUARE_RECT[0]! + (ON_PAGE_SQUARE_RECT[2]! - ON_PAGE_SQUARE_RECT[0]!) / 2,
            6,
        );
    });

    it('keeps the source rect of an untouched off-page circle', async () => {
        const bytes = await createShapeFixturePdf(CIRCLE_ANNOTATIONS);
        const imported = await importEmbeddedShapeAnnotations(bytes);
        const circle = requireShape(imported, OFF_PAGE_CIRCLE_KEY);

        expect(circle.type).toBe('circle');
        // The clamp caps the marker at the right and bottom page edges.
        expect(circle.x + circle.width).toBeCloseTo(1, 6);

        const savedBytes = await saveWithShapes(bytes, [circle]);

        expect(await readShapeRect(savedBytes, OFF_PAGE_CIRCLE_KEY)).toEqual(OFF_PAGE_CIRCLE_RECT);

        const reimported = requireShape(
            await importEmbeddedShapeAnnotations(savedBytes),
            OFF_PAGE_CIRCLE_KEY,
        );
        expect(reimported.width).toBe(circle.width);
        expect(reimported.height).toBe(circle.height);
    });

    it('serializes the new geometry of an edited off-page circle', async () => {
        const bytes = await createShapeFixturePdf(CIRCLE_ANNOTATIONS);
        const circle = requireShape(
            await importEmbeddedShapeAnnotations(bytes),
            OFF_PAGE_CIRCLE_KEY,
        );

        const savedBytes = await saveWithShapes(bytes, [{
            ...circle,
            x: circle.x - 0.2,
        }]);
        const rect = await readShapeRect(savedBytes, OFF_PAGE_CIRCLE_KEY);

        expect(rect).not.toEqual(OFF_PAGE_CIRCLE_RECT);
        expect(rect?.[0]).toBeCloseTo((circle.x - 0.2) * PAGE_WIDTH, 6);
    });

    it('drops a stale Line interior color and keeps a Polygon fill', async () => {
        const bytes = await createShapeFixturePdf(INTERIOR_COLOR_ANNOTATIONS);
        const imported = await importEmbeddedShapeAnnotations(bytes);
        const line = requireShape(imported, LINE_KEY);
        const polygon = requireShape(imported, POLYGON_KEY);
        expect(polygon.fillColor).toBe('#0000ff');

        const savedBytes = await saveWithShapes(bytes, [
            line,
            polygon,
        ]);
        const dicts = await readShapeDictsByStableKey(savedBytes);

        // Without this, a Line the save dropped altogether would read the same
        // as a Line whose stale interior color was cleared.
        const lineDict = dicts.get(LINE_KEY);
        expect(lineDict, `saved shape ${LINE_KEY}`).toBeInstanceOf(PDFDict);
        expect(lineDict?.get(PDFName.of('IC'))).toBeUndefined();
        const polygonInteriorColor = dicts.get(POLYGON_KEY)?.lookupMaybe(PDFName.of('IC'), PDFArray);
        expect(polygonInteriorColor).toBeInstanceOf(PDFArray);
        expect(polygonInteriorColor?.toString()).toBe('[ 0 0 1 ]');
    });
});
