import {
    beforeEach,
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
import type { IShapeAnnotation } from '@app/types/annotations';
import type { IDocumentsFileIoCapability } from '@contracts/electronApiDocuments';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { useAnnotationShapes } from '@app/modules/pdf-viewer/tools/useAnnotationShapes';
import { usePdfSerialization } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization';
import { readDocumentBytes } from '@app/utils/documentBytes';
import {requireDocumentRevisionToken} from '@contracts';

vi.mock('@app/utils/documentBytes', () => ({ readDocumentBytes: vi.fn() }));

const platformMocks = vi.hoisted(() => ({
    documentFilesCapability: {},
    getDocumentsCapability: vi.fn(() => {
        throw new Error('usePdfSerialization should use getDocumentFilesCapability for native PDF mutations');
    }),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => platformMocks.documentFilesCapability,
    getDocumentsCapability: platformMocks.getDocumentsCapability,
}));

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=',
    'base64',
));
const TEST_DOCUMENT_REVISION_TOKEN = requireDocumentRevisionToken('drt1:test:serialization-base');

beforeEach(() => {
    platformMocks.documentFilesCapability = {};
    platformMocks.getDocumentsCapability.mockClear();
    vi.mocked(readDocumentBytes).mockReset();
});

function createSerializationHarness(options: {workingCopyPath?: string | null;} = {}) {
    return usePdfSerialization({
        pdfData: ref(null),
        workingCopyPath: ref(options.workingCopyPath ?? null),
        documentRevisionToken: ref(TEST_DOCUMENT_REVISION_TOKEN),
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
    return {
        bytes: new Uint8Array(await doc.save()),
        freeTextRef,
    };
}

async function createBlankPdfData() {
    const doc = await PDFDocument.create();
    doc.addPage([
        600,
        800,
    ]);
    return new Uint8Array(await doc.save());
}

async function createPdfDataWithEmbeddedShapes() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        800,
    ]);

    const squareRef = doc.context.register(doc.context.obj({
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
        IC: [
            0.9,
            0.9,
            0.9,
        ],
        Border: [
            0,
            0,
            2,
        ],
    }));
    const lineRef = doc.context.register(doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Line'),
        Rect: [
            90,
            290,
            350,
            530,
        ],
        L: [
            110,
            500,
            330,
            320,
        ],
        Border: [
            0,
            0,
            3,
        ],
        LE: [
            PDFName.of('None'),
            PDFName.of('ClosedArrow'),
        ],
    }));

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

async function createPdfDataWithSinglePage() {
    const doc = await PDFDocument.create();
    doc.addPage([
        600,
        800,
    ]);
    return new Uint8Array(await doc.save());
}

describe('usePdfSerialization embedPlacedImageToPage', () => {
    it('uses the native working-copy path for JPEG placed images when available', async () => {
        const baseBytes = new Uint8Array([1]);
        const nativeBytes = new Uint8Array([
            37,
            80,
            68,
            70,
        ]);
        const nativeApply = deferred<Awaited<ReturnType<NonNullable<IDocumentsFileIoCapability['applyPdfNativeMutationsToWorkingCopy']>>>>();
        const applyPdfNativeMutationsToWorkingCopy = vi.fn<NonNullable<IDocumentsFileIoCapability['applyPdfNativeMutationsToWorkingCopy']>>(async () => nativeApply.promise);
        const releaseManagedTempFileHandle = vi.fn(async () => true);
        platformMocks.documentFilesCapability = {
            applyPdfNativeMutationsToWorkingCopy,
            releaseManagedTempFileHandle,
        };
        vi.mocked(readDocumentBytes)
            .mockResolvedValueOnce(nativeBytes);
        const serializer = createSerializationHarness({workingCopyPath: '/tmp/work.pdf'});
        const imageBytes = new Uint8Array([
            0xFF,
            0xD8,
            0xFF,
        ]);

        const resultPromise = serializer.embedPlacedImageToPage(
            baseBytes,
            {
                pageNumber: 2,
                x: 0.1,
                y: 0.25,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 12,
                fileName: 'photo.jpg',
                mimeType: 'image/jpeg',
                bytes: imageBytes,
                nativeSourceHandle: {
                    path: '/tmp/photo.jpg',
                    size: imageBytes.byteLength,
                    sha256: 'a'.repeat(64),
                    leaseId: 'photo-lease',
                    revision: null,
                },
                targetPixelWidth: 180,
                targetPixelHeight: 160,
            },
        );
        await vi.waitFor(() => {
            expect(applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledTimes(1);
        });
        expect(readDocumentBytes).not.toHaveBeenCalled();

        nativeApply.resolve({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native' as const,
                errors: [],
                warnings: [],
            },
        });
        const result = await resultPromise;
        expect(result).toEqual(nativeBytes);
        expect(applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            {placedImages: [expect.objectContaining({
                pageIndex: 1,
                x: 0.1,
                y: 0.25,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 12,
                mimeType: 'image/jpeg',
                source: expect.objectContaining({leaseId: 'photo-lease'}),
            })]},
            expect.stringMatching(/^D:\d{14}[+-]\d{2}'\d{2}'$/u),
            {
                byteLength: baseBytes.byteLength,
                sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            },
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(applyPdfNativeMutationsToWorkingCopy.mock.calls[0]?.[1].placedImages?.[0]).not.toHaveProperty('bytes');
        expect(releaseManagedTempFileHandle).toHaveBeenCalledWith('photo-lease');
        expect(readDocumentBytes).toHaveBeenNthCalledWith(1, '/tmp/work.pdf');
        expect(readDocumentBytes).toHaveBeenCalledTimes(1);
    });

    it('falls back when the main-process working-copy expectation declines the native mutation', async () => {
        const sourceDoc = await PDFDocument.create();
        sourceDoc.addPage([
            600,
            800,
        ]);
        const baseBytes = await sourceDoc.save();
        const applyPdfNativeMutationsToWorkingCopy = vi.fn<NonNullable<IDocumentsFileIoCapability['applyPdfNativeMutationsToWorkingCopy']>>(async () => ({
            applied: false,
            validation: null,
        }));
        platformMocks.documentFilesCapability = {
            applyPdfNativeMutationsToWorkingCopy,
            releaseManagedTempFileHandle: vi.fn(async () => true),
        };
        const serializer = createSerializationHarness({workingCopyPath: '/tmp/work.pdf'});

        await expect(serializer.embedPlacedImageToPage(
            baseBytes,
            {
                pageNumber: 1,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 0,
                fileName: 'photo.jpg',
                mimeType: 'image/jpeg',
                bytes: new Uint8Array([
                    0xFF,
                    0xD8,
                    0xFF,
                ]),
                nativeSourceHandle: {
                    path: '/tmp/photo.jpg',
                    size: 3,
                    sha256: 'a'.repeat(64),
                    leaseId: 'photo-lease',
                    revision: null,
                },
                targetPixelWidth: 100,
                targetPixelHeight: 80,
            },
        )).rejects.toThrow();
        expect(applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            expect.objectContaining({placedImages: expect.any(Array)}),
            expect.stringMatching(/^D:\d{14}[+-]\d{2}'\d{2}'$/u),
            {
                byteLength: baseBytes.byteLength,
                sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            },
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(readDocumentBytes).not.toHaveBeenCalled();
    });

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
        const { bytes } = await createPdfDataWithFreeTextAnnotation();
        const result = await serializer.embedPlacedImageToPage(
            bytes,
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

    it('rejects placed image finalization when the target page cannot be applied', async () => {
        const serializer = createSerializationHarness();
        const source = await createBlankPdfData();

        await expect(serializer.embedPlacedImageToPage(source, {
            pageNumber: 2,
            x: 0.1,
            y: 0.25,
            width: 0.3,
            height: 0.2,
            rotationDegrees: 0,
            fileName: 'missing-page.png',
            mimeType: 'image/png',
            bytes: ONE_PIXEL_PNG,
            targetPixelWidth: 180,
            targetPixelHeight: 160,
        })).rejects.toThrow('page 2 does not exist');
    });
});

describe('usePdfSerialization embedded shapes', () => {
    it('serializes embedded shapes in place and forwards deleted embedded annotation ids', async () => {
        const {
            bytes,
            squareRef,
            lineRef,
        } = await createPdfDataWithEmbeddedShapes();

        const shapes: IShapeAnnotation[] = [
            {
                id: 'shape-square',
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
            },
            {
                id: 'shape-polygon',
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
            },
        ];

        const serializer = usePdfSerialization({
            pdfData: ref(bytes),
            workingCopyPath: ref(null),
            totalPages: ref(1),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            getMarkupSubtypeOverrides: () => undefined,
            getAllShapes: () => shapes,
            getDeletedEmbeddedShapeAnnotationIds: () => [`${lineRef.objectNumber}R${lineRef.generationNumber}`],
        });

        const result = await serializer.serializeShapeAnnotations(bytes);
        const doc = await PDFDocument.load(result, { updateMetadata: false });
        const annotRefs = getPageAnnotRefs(doc);
        const annotTags = annotRefs.map(ref => ref.toString());

        expect(annotTags).toHaveLength(2);
        expect(annotTags).toContain(squareRef.toString());
        expect(annotTags).not.toContain(lineRef.toString());
        expect(getAnnotDict(doc, squareRef)?.get(PDFName.of('Subtype'))?.toString()).toBe('/Square');
        expect(getAnnotDict(doc, annotRefs[1]!)?.get(PDFName.of('Subtype'))?.toString()).toBe('/Polygon');
        expect(getRectNumbers(getAnnotDict(doc, squareRef)!)).toEqual(expect.arrayContaining([
            expect.closeTo(120, 6),
            expect.closeTo(440, 6),
            expect.closeTo(270, 6),
            expect.closeTo(680, 6),
        ]));
    });

    it('round-trips newly added local drawings through serializePdfForSave', async () => {
        const source = await createPdfDataWithSinglePage();
        const shapes: IShapeAnnotation[] = [
            {
                id: 'shape-rect',
                stableKey: 'evb-shape:local-rect',
                type: 'rectangle',
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                color: '#336699',
                fillColor: '#abcdef',
                opacity: 0.5,
                strokeWidth: 3,
                source: 'local',
            },
            {
                id: 'shape-arrow',
                stableKey: 'evb-shape:local-arrow',
                type: 'arrow',
                pageIndex: 0,
                x: 0.4,
                y: 0.4,
                x2: 0.7,
                y2: 0.45,
                width: 0,
                height: 0,
                color: '#000000',
                opacity: 1,
                strokeWidth: 2,
                lineEndStyle: 'openArrow',
                source: 'local',
            },
        ];
        const serializer = usePdfSerialization({
            pdfData: ref(source),
            workingCopyPath: ref(null),
            totalPages: ref(1),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            getMarkupSubtypeOverrides: () => undefined,
            getAllShapes: () => shapes,
            getDeletedEmbeddedShapeAnnotationIds: () => [],
        });

        const result = await serializer.serializePdfForSave(source, { includeShapes: true });
        const importedShapes = await importEmbeddedShapeAnnotations(result);

        expect(importedShapes).toHaveLength(2);
        expect(importedShapes[0]).toMatchObject({
            type: 'rectangle',
            source: 'embedded',
            stableKey: 'evb-shape:local-rect',
            pdfSubtype: 'Square',
            color: '#336699',
            fillColor: '#abcdef',
            opacity: 0.5,
            strokeWidth: 3,
        });
        expect(importedShapes[1]).toMatchObject({
            type: 'arrow',
            source: 'embedded',
            stableKey: 'evb-shape:local-arrow',
            pdfSubtype: 'Line',
            color: '#000000',
            opacity: 1,
            strokeWidth: 2,
            lineEndStyle: 'openArrow',
        });
    });

    it('preserves repeated draw-delete-redraw save cycles for ink shapes', async () => {
        const source = await createPdfDataWithSinglePage();
        const firstInkShape: IShapeAnnotation = {
            id: 'shape-ink-1',
            stableKey: 'evb-shape:ink-1',
            type: 'polyline',
            pageIndex: 0,
            x: 0.1,
            y: 0.2,
            width: 0.25,
            height: 0.2,
            color: '#e11d48',
            opacity: 0.9,
            strokeWidth: 2,
            source: 'local',
            pdfSubtype: 'Ink',
            points: [
                {
                    x: 0.1,
                    y: 0.2,
                },
                {
                    x: 0.2,
                    y: 0.28,
                },
                {
                    x: 0.35,
                    y: 0.4,
                },
            ],
            strokes: [[
                {
                    x: 0.1,
                    y: 0.2,
                },
                {
                    x: 0.2,
                    y: 0.28,
                },
                {
                    x: 0.35,
                    y: 0.4,
                },
            ]],
        };

        const firstSerializer = usePdfSerialization({
            pdfData: ref(source),
            workingCopyPath: ref(null),
            totalPages: ref(1),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            getMarkupSubtypeOverrides: () => undefined,
            getAllShapes: () => [firstInkShape],
            getDeletedEmbeddedShapeAnnotationIds: () => [],
        });

        const onceSaved = await firstSerializer.serializePdfForSave(source, { includeShapes: true });
        const importedOnce = await importEmbeddedShapeAnnotations(onceSaved);
        const deletedAnnotationId = importedOnce[0]?.annotationId ?? null;

        expect(importedOnce).toHaveLength(1);
        expect(importedOnce[0]).toMatchObject({
            type: 'polyline',
            stableKey: 'evb-shape:ink-1',
            pdfSubtype: 'Ink',
            color: '#e11d48',
        });
        expect(deletedAnnotationId).toBeTruthy();

        const secondInkShape: IShapeAnnotation = {
            id: 'shape-ink-2',
            stableKey: 'evb-shape:ink-2',
            type: 'polyline',
            pageIndex: 0,
            x: 0.45,
            y: 0.3,
            width: 0.2,
            height: 0.18,
            color: '#2563eb',
            opacity: 0.55,
            strokeWidth: 5,
            source: 'local',
            pdfSubtype: 'Ink',
            points: [
                {
                    x: 0.45,
                    y: 0.3,
                },
                {
                    x: 0.52,
                    y: 0.36,
                },
                {
                    x: 0.65,
                    y: 0.48,
                },
            ],
            strokes: [[
                {
                    x: 0.45,
                    y: 0.3,
                },
                {
                    x: 0.52,
                    y: 0.36,
                },
                {
                    x: 0.65,
                    y: 0.48,
                },
            ]],
        };

        const secondSerializer = usePdfSerialization({
            pdfData: ref(onceSaved),
            workingCopyPath: ref(null),
            totalPages: ref(1),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            getMarkupSubtypeOverrides: () => undefined,
            getAllShapes: () => [secondInkShape],
            getDeletedEmbeddedShapeAnnotationIds: () => deletedAnnotationId ? [deletedAnnotationId] : [],
        });

        const twiceSaved = await secondSerializer.serializePdfForSave(onceSaved, { includeShapes: true });
        const importedTwice = await importEmbeddedShapeAnnotations(twiceSaved);

        expect(importedTwice).toHaveLength(1);
        expect(importedTwice[0]).toMatchObject({
            type: 'polyline',
            stableKey: 'evb-shape:ink-2',
            pdfSubtype: 'Ink',
            color: '#2563eb',
            opacity: 0.55,
            strokeWidth: 5,
        });
        expect(importedTwice[0]?.annotationId).not.toBe(deletedAnnotationId);
    });

    it('can delete a persisted managed shape by stable key without removing unrelated managed shapes', async () => {
        const source = await createPdfDataWithSinglePage();
        const firstInkShape: IShapeAnnotation = {
            id: 'shape-ink-stable-delete',
            stableKey: 'evb-shape:stable-delete',
            type: 'polyline',
            pageIndex: 0,
            x: 0.1,
            y: 0.2,
            width: 0.25,
            height: 0.2,
            color: '#e11d48',
            opacity: 0.9,
            strokeWidth: 2,
            source: 'local',
            pdfSubtype: 'Ink',
            points: [
                {
                    x: 0.1,
                    y: 0.2,
                },
                {
                    x: 0.2,
                    y: 0.28,
                },
                {
                    x: 0.35,
                    y: 0.4,
                },
            ],
            strokes: [[
                {
                    x: 0.1,
                    y: 0.2,
                },
                {
                    x: 0.2,
                    y: 0.28,
                },
                {
                    x: 0.35,
                    y: 0.4,
                },
            ]],
        };
        const secondInkShape: IShapeAnnotation = {
            id: 'shape-ink-stable-keep',
            stableKey: 'evb-shape:stable-keep',
            type: 'polyline',
            pageIndex: 0,
            x: 0.45,
            y: 0.22,
            width: 0.2,
            height: 0.18,
            color: '#2563eb',
            opacity: 0.75,
            strokeWidth: 3,
            source: 'local',
            pdfSubtype: 'Ink',
            points: [
                {
                    x: 0.45,
                    y: 0.22,
                },
                {
                    x: 0.56,
                    y: 0.32,
                },
                {
                    x: 0.65,
                    y: 0.4,
                },
            ],
            strokes: [[
                {
                    x: 0.45,
                    y: 0.22,
                },
                {
                    x: 0.56,
                    y: 0.32,
                },
                {
                    x: 0.65,
                    y: 0.4,
                },
            ]],
        };

        const createSerializer = (bytes: Uint8Array, options?: {
            shapes?: IShapeAnnotation[];
            deletedStableKeys?: string[];
        }) => usePdfSerialization({
            pdfData: ref(bytes),
            workingCopyPath: ref(null),
            totalPages: ref(1),
            pageLabelsDirty: ref(false),
            pageLabelRanges: ref([]),
            getMarkupSubtypeOverrides: () => undefined,
            getAllShapes: () => options?.shapes ?? [],
            getDeletedEmbeddedShapeAnnotationIds: () => [],
            getDeletedEmbeddedShapeStableKeys: () => options?.deletedStableKeys ?? [],
        });

        const onceSaved = await createSerializer(source, { shapes: [
            firstInkShape,
            secondInkShape,
        ] })
            .serializePdfForSave(source, { includeShapes: true });
        const importedOnce = await importEmbeddedShapeAnnotations(onceSaved);

        expect(importedOnce).toHaveLength(2);
        expect(importedOnce.map(shape => shape.stableKey).sort()).toEqual([
            'evb-shape:stable-delete',
            'evb-shape:stable-keep',
        ]);

        const afterDelete = await createSerializer(onceSaved, {deletedStableKeys: ['evb-shape:stable-delete']}).serializePdfForSave(onceSaved, { includeShapes: true });
        const importedAfterDelete = await importEmbeddedShapeAnnotations(afterDelete);

        expect(importedAfterDelete).toHaveLength(1);
        expect(importedAfterDelete[0]).toMatchObject({
            stableKey: 'evb-shape:stable-keep',
            pdfSubtype: 'Ink',
        });
    });

    it('keeps managed draw shapes stable across repeated save, delete, and redraw reconciliation cycles', async () => {
        const shapes = useAnnotationShapes();

        async function saveAndReconcile(bytes: Uint8Array) {
            const serializer = usePdfSerialization({
                pdfData: ref(bytes),
                workingCopyPath: ref(null),
                totalPages: ref(1),
                pageLabelsDirty: ref(false),
                pageLabelRanges: ref([]),
                getMarkupSubtypeOverrides: () => undefined,
                getAllShapes: () => shapes.getAllShapes(),
                getDeletedEmbeddedShapeAnnotationIds: () => shapes.getDeletedEmbeddedAnnotationIds(),
                getDeletedEmbeddedShapeStableKeys: () => shapes.getDeletedEmbeddedShapeStableKeys(),
            });

            const saved = await serializer.serializePdfForSave(bytes, { includeShapes: true });
            const imported = await importEmbeddedShapeAnnotations(saved);
            shapes.reconcilePersistedShapes(imported);
            return saved;
        }

        let currentBytes: Uint8Array = await createPdfDataWithSinglePage();

        shapes.startDrawing(0, 'draw', 0.1, 0.2, DEFAULT_ANNOTATION_SETTINGS);
        shapes.continueDrawing(0.18, 0.28);
        shapes.continueDrawing(0.3, 0.4);
        const firstDraw = shapes.finishDrawing();

        expect(firstDraw).not.toBeNull();
        expect(shapes.getAllShapes()).toHaveLength(1);
        expect(shapes.getAllShapes()[0]?.source).toBe('local');

        currentBytes = await saveAndReconcile(currentBytes);

        const firstPersistedShape = shapes.getShapeById(firstDraw!.id);
        const firstPersistedAnnotationId = firstPersistedShape?.annotationId ?? null;

        expect(firstPersistedShape).toMatchObject({
            id: firstDraw!.id,
            stableKey: firstDraw!.stableKey,
            source: 'embedded',
            pdfSubtype: 'Ink',
        });
        expect(firstPersistedAnnotationId).toBeTruthy();
        expect(shapes.hasShapes.value).toBe(false);

        shapes.deleteShape(firstDraw!.id);
        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual([firstPersistedAnnotationId]);
        expect(shapes.getDeletedEmbeddedShapeStableKeys()).toEqual([firstDraw!.stableKey]);
        expect(shapes.hasShapes.value).toBe(true);

        currentBytes = await saveAndReconcile(currentBytes);

        expect(shapes.getAllShapes()).toEqual([]);
        expect(shapes.getDeletedEmbeddedAnnotationIds()).toEqual([]);
        expect(shapes.getDeletedEmbeddedShapeStableKeys()).toEqual([]);
        expect(shapes.hasShapes.value).toBe(false);

        shapes.startDrawing(0, 'draw', 0.45, 0.3, DEFAULT_ANNOTATION_SETTINGS);
        shapes.continueDrawing(0.54, 0.38);
        shapes.continueDrawing(0.65, 0.5);
        const secondDraw = shapes.finishDrawing();

        expect(secondDraw).not.toBeNull();

        currentBytes = await saveAndReconcile(currentBytes);

        const secondPersistedShape = shapes.getShapeById(secondDraw!.id);
        expect(secondPersistedShape).toMatchObject({
            id: secondDraw!.id,
            stableKey: secondDraw!.stableKey,
            source: 'embedded',
            pdfSubtype: 'Ink',
        });
        expect(secondPersistedShape?.annotationId).toBeTruthy();
        expect(secondPersistedShape?.annotationId).not.toBe(firstPersistedAnnotationId);
        expect(shapes.hasShapes.value).toBe(false);

        const importedFinal = await importEmbeddedShapeAnnotations(currentBytes);
        expect(importedFinal).toHaveLength(1);
        expect(importedFinal[0]).toMatchObject({
            pdfSubtype: 'Ink',
            color: DEFAULT_ANNOTATION_SETTINGS.inkColor,
        });
    });
});

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}
