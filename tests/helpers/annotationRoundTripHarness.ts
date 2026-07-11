import {
    DOMMatrix,
    ImageData,
    Path2D,
    createCanvas,
} from '@napi-rs/canvas';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
    PDFHexString,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import { serializePdfEdits } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits';
import { cast } from '@tests/helpers/cast';

const MAX_NOTE_MARKER_SIZE = 0.02;

interface IPdfjsAnnotationRecord {
    annotationName?: string;
    color?: Uint8ClampedArray | number[];
    contents?: string;
    contentsObj?: { str?: string };
    id?: string;
    opacity?: number;
    popupRef?: string;
    rect?: number[];
    subtype?: string;
}

interface IPdfLibAnnotationMetadata {
    annotationName: string | null;
    opacity: number | null;
    ref: string;
}

export interface IAnnotationRoundTripTruth {
    annotationName: string | null;
    color: number[] | null;
    hasLinkedPopup: boolean;
    id: string | null;
    markerEligible: boolean;
    normalizedRect: {
        height: number;
        left: number;
        top: number;
        width: number;
    } | null;
    opacity: number | null;
    pageIndex: number;
    subtype: string;
    text: string;
}

export interface IAnnotationRoundTripResult {
    bytes: Uint8Array;
    inkPixelCount: number;
    textItems: string[];
    truth: IAnnotationRoundTripTruth[];
}

export function createAnnotationRoundTripPayload(): IPdfSerializationSavePayload {
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

export function createRoundTripNote(
    text: string,
    identity = 'annotation-round-trip-note',
): IAnnotationCommentSummary {
    return {
        id: identity,
        stableKey: `uid:0:${identity}`,
        pageIndex: 0,
        pageNumber: 1,
        text,
        subtype: 'FreeText',
        author: 'Round-trip harness',
        modifiedAt: null,
        color: 'rgba(255, 204, 0, 0.8)',
        uid: identity,
        annotationId: identity,
        source: 'editor',
        hasNote: true,
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
    };
}

async function reopenWithPdfjs(bytes: Uint8Array) {
    Object.assign(globalThis, {
        DOMMatrix,
        ImageData,
        Path2D,
    });
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument(cast<Parameters<typeof pdfjs.getDocument>[0]>({
        data: bytes.slice(),
        disableWorker: true,
        useSystemFonts: true,
    }));
    return loadingTask.promise;
}

function normalizeAnnotation(
    annotation: IPdfjsAnnotationRecord,
    pageIndex: number,
    pageView: number[],
    metadata: IPdfLibAnnotationMetadata | undefined,
): IAnnotationRoundTripTruth {
    const [
        x1 = 0,
        y1 = 0,
        x2 = 0,
        y2 = 0,
    ] = annotation.rect ?? [];
    const [
        viewX1 = 0,
        viewY1 = 0,
        viewX2 = 1,
        viewY2 = 1,
    ] = pageView;
    const pageWidth = Math.abs(viewX2 - viewX1) || 1;
    const pageHeight = Math.abs(viewY2 - viewY1) || 1;
    const normalizedRect = annotation.rect
        ? {
            left: (Math.min(x1, x2) - viewX1) / pageWidth,
            top: (viewY2 - Math.max(y1, y2)) / pageHeight,
            width: Math.abs(x2 - x1) / pageWidth,
            height: Math.abs(y2 - y1) / pageHeight,
        }
        : null;
    const subtype = annotation.subtype ?? '';
    const hasLinkedPopup = Boolean(annotation.popupRef);
    return {
        annotationName: annotation.annotationName ?? metadata?.annotationName ?? null,
        color: annotation.color ? Array.from(annotation.color) : null,
        hasLinkedPopup,
        id: annotation.id ?? null,
        markerEligible: subtype.toLowerCase() === 'freetext'
            && hasLinkedPopup
            && normalizedRect !== null
            && normalizedRect.width <= MAX_NOTE_MARKER_SIZE
            && normalizedRect.height <= MAX_NOTE_MARKER_SIZE,
        normalizedRect,
        opacity: typeof annotation.opacity === 'number' ? annotation.opacity : (metadata?.opacity ?? null),
        pageIndex,
        subtype,
        text: annotation.contentsObj?.str ?? annotation.contents ?? '',
    };
}

function getPdfString(value: unknown) {
    if (value instanceof PDFString || value instanceof PDFHexString) {
        return value.decodeText();
    }
    return null;
}

async function readPdfLibAnnotationMetadata(bytes: Uint8Array) {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    return document.getPages().map((page) => {
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            return [];
        }
        const metadata: IPdfLibAnnotationMetadata[] = [];
        for (let index = 0; index < annots.size(); index += 1) {
            const ref = annots.get(index);
            if (!(ref instanceof PDFRef)) {
                continue;
            }
            const dict = document.context.lookupMaybe(ref, PDFDict);
            if (!(dict instanceof PDFDict) || dict.get(PDFName.of('Subtype'))?.toString() === '/Popup') {
                continue;
            }
            metadata.push({
                annotationName: getPdfString(dict.get(PDFName.of('NM'))),
                opacity: dict.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber() ?? null,
                ref: `${ref.objectNumber}R${ref.generationNumber || ''}`,
            });
        }
        return metadata;
    });
}

export async function runAnnotationRoundTrip(
    sourceBytes: Uint8Array,
    payload: IPdfSerializationSavePayload,
): Promise<IAnnotationRoundTripResult> {
    const bytes = await serializePdfEdits(sourceBytes, payload);
    const pdfLibMetadata = await readPdfLibAnnotationMetadata(bytes);
    const document = await reopenWithPdfjs(bytes);
    try {
        const truth: IAnnotationRoundTripTruth[] = [];
        const textItems: string[] = [];
        let inkPixelCount = 0;
        for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
            const page = await document.getPage(pageIndex + 1);
            const annotations = cast<IPdfjsAnnotationRecord[]>(await page.getAnnotations());
            const pageMetadata = pdfLibMetadata[pageIndex] ?? [];
            truth.push(...annotations.map((annotation, annotationIndex) => {
                const normalizedId = annotation.id?.replace(/R0$/u, 'R') ?? '';
                const metadata = pageMetadata.find(candidate => candidate.ref === normalizedId)
                    ?? pageMetadata[annotationIndex];
                return normalizeAnnotation(annotation, pageIndex, page.view, metadata);
            }));

            const textContent = await page.getTextContent();
            textItems.push(...textContent.items.flatMap((item) => {
                const value = cast<{ str?: string }>(item).str;
                return typeof value === 'string' ? [value] : [];
            }));

            const viewport = page.getViewport({scale: 1});
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const context = canvas.getContext('2d');
            await page.render({
                canvas: cast<HTMLCanvasElement>(canvas),
                canvasContext: cast<CanvasRenderingContext2D>(context),
                viewport,
            }).promise;
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let offset = 0; offset < pixels.length; offset += 4) {
                const alpha = pixels[offset + 3] ?? 0;
                const red = pixels[offset] ?? 255;
                const green = pixels[offset + 1] ?? 255;
                const blue = pixels[offset + 2] ?? 255;
                if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) {
                    inkPixelCount += 1;
                }
            }
        }
        return {
            bytes,
            inkPixelCount,
            textItems,
            truth,
        };
    } finally {
        await document.destroy();
    }
}

export async function createBlankRoundTripPdf(width = 600, height = 800) {
    const document = await PDFDocument.create();
    document.addPage([
        width,
        height,
    ]);
    return new Uint8Array(await document.save());
}
