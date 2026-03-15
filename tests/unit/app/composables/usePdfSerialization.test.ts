import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRef,
} from 'pdf-lib';
import { usePdfSerialization } from '@app/composables/pdf/usePdfSerialization';

vi.mock('@app/composables/pdf/pdfAnnotationUtils', () => ({ markerRectIoU: () => 0 }));

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=',
    'base64',
));

function createSerializationHarness() {
    return usePdfSerialization({
        pdfData: ref(null),
        workingCopyPath: ref(null),
        annotationComments: ref([]),
        totalPages: ref(1),
        pageLabelsDirty: ref(false),
        pageLabelRanges: ref([]),
        getMarkupSubtypeOverrides: () => undefined,
        getAllShapes: () => [],
    });
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

async function createPdfDataWithFreeTextAnnotation() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);
    const freeTextDict = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('FreeText'),
        Rect: [
            PDFNumber.of(72),
            PDFNumber.of(640),
            PDFNumber.of(220),
            PDFNumber.of(700),
        ],
        Contents: 'existing text',
    });
    const freeTextRef = doc.context.register(freeTextDict);
    page.node.set(PDFName.of('Annots'), doc.context.obj([freeTextRef]));
    return new Uint8Array(await doc.save());
}

describe('usePdfSerialization embedPlacedImageToPage', () => {
    it('persists a placed image as a stamp annotation with an appearance stream', async () => {
        const serializer = createSerializationHarness();
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([
            600,
            800,
        ]);

        const result = await serializer.embedPlacedImageToPage(
            new Uint8Array(await sourceDoc.save()),
            {
                pageNumber: 1,
                x: 0.1,
                y: 0.25,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 0,
                fileName: 'cover.png',
                mimeType: 'image/png',
                bytes: ONE_PIXEL_PNG,
                targetPixelWidth: 180,
                targetPixelHeight: 160,
            },
        );

        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(doc);
        expect(annotRefs).toHaveLength(1);

        const stampDict = getAnnotDict(doc, annotRefs[0]!);
        expect(stampDict?.get(PDFName.of('Subtype'))?.toString()).toBe('/Stamp');
        expect(getRectNumbers(stampDict!)).toEqual(expect.arrayContaining([
            expect.closeTo(60, 6),
            expect.closeTo(440, 6),
            expect.closeTo(240, 6),
            expect.closeTo(600, 6),
        ]));

        const appearanceDict = stampDict?.lookupMaybe(PDFName.of('AP'), PDFDict);
        expect(appearanceDict).toBeInstanceOf(PDFDict);
        const normalAppearance = appearanceDict?.get(PDFName.of('N'));
        expect(normalAppearance instanceof PDFRef || normalAppearance instanceof PDFDict).toBe(true);
    });

    it('appends the placed image stamp after existing annotations so it stays topmost', async () => {
        const serializer = createSerializationHarness();
        const result = await serializer.embedPlacedImageToPage(
            await createPdfDataWithFreeTextAnnotation(),
            {
                pageNumber: 1,
                x: 0.12,
                y: 0.18,
                width: 0.24,
                height: 0.12,
                rotationDegrees: 0,
                fileName: 'overlay.png',
                mimeType: 'image/png',
                bytes: ONE_PIXEL_PNG,
                targetPixelWidth: 144,
                targetPixelHeight: 96,
            },
        );

        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(doc);
        expect(annotRefs).toHaveLength(2);

        const firstAnnot = getAnnotDict(doc, annotRefs[0]!);
        const lastAnnot = getAnnotDict(doc, annotRefs[1]!);
        expect(firstAnnot?.get(PDFName.of('Subtype'))?.toString()).toBe('/FreeText');
        expect(lastAnnot?.get(PDFName.of('Subtype'))?.toString()).toBe('/Stamp');
    });
});
