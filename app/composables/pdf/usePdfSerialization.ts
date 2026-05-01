import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platform-api';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdf-image-placement';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import type {
    IPdfSerializationSavePayload,
    IPdfSerializedPlacedImagePayload,
} from '@app/composables/pdf/pdfSerializationOperations';
import { collectMarkupSubtypeHints } from '@app/composables/pdf/pdfSerializationSubtypeHints';
import {
    deleteEmbeddedAnnotationOffThread,
    serializePdfEditsOffThread,
    updateEmbeddedAnnotationTextOffThread,
} from '@app/composables/pdf/pdfSerializationWorkerClient';
import { BrowserLogger } from '@app/utils/browser-logger';
import { toTransferableUint8Array } from '@app/platform/browser-api/browser-worker-transfer';
import { decodeBrowserImageBlob } from '@app/platform/browser-api/browser-image-decode';
import { readDocumentBytes } from '@app/utils/document-bytes';
import { measureDevPerfAsync } from '@app/utils/dev-perf';

const PDF_SERIALIZATION_LOG_SECTION = 'pdf-serialization';

export interface IPdfSerializationDeps {
    pdfData: Ref<Uint8Array | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    totalPages: Ref<number>;
    pageLabelsDirty: Ref<boolean>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    bookmarksDirty?: Ref<boolean>;
    bookmarkItems?: Ref<IPdfBookmarkEntry[]>;
    untitledBookmarkLabel?: string;
    getMarkupSubtypeOverrides: () => Map<string, TMarkupSubtype> | undefined;
    getAllShapes: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
}

interface ISerializePdfForSaveOptions {
    includeShapes?: boolean;
    rewriteShapeState?: boolean;
    pendingTexts?: Map<string, string> | null;
    pendingDeletes?: IAnnotationCommentSummary[] | null;
    placedImage?: IPdfPlacedImageFinalizePayload | null;
}

export const usePdfSerialization = (deps: IPdfSerializationDeps) => {
    const {
        pdfData,
        workingCopyPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        untitledBookmarkLabel = '',
        getMarkupSubtypeOverrides,
        getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds,
        getDeletedEmbeddedShapeStableKeys,
    } = deps;

    async function getSourcePdfData() {
        let sourceData = pdfData.value ? toTransferableUint8Array(pdfData.value) : null;
        if (!sourceData && workingCopyPath.value) {
            try {
                sourceData = toTransferableUint8Array(
                    await readDocumentBytes(workingCopyPath.value),
                );
            } catch (error) {
                BrowserLogger.debug(PDF_SERIALIZATION_LOG_SECTION, 'Failed to read working copy for serialization', {
                    path: workingCopyPath.value,
                    error,
                });
                sourceData = null;
            }
        }
        return sourceData;
    }

    async function decodePlacedImageSource(payload: IPdfPlacedImageFinalizePayload) {
        const imageBlob = new Blob(
            [toTransferableUint8Array(payload.bytes)],
            { type: payload.mimeType || 'image/png' },
        );

        return decodeBrowserImageBlob(imageBlob, { fallbackErrorMessage: 'Failed to decode image for PDF embedding' });
    }

    async function rasterizePlacedImage(
        payload: IPdfPlacedImageFinalizePayload,
    ): Promise<Uint8Array | null> {
        const targetPixelWidth = Math.max(1, Math.round(payload.targetPixelWidth));
        const targetPixelHeight = Math.max(1, Math.round(payload.targetPixelHeight));
        const image = await decodePlacedImageSource(payload);

        const canvas = document.createElement('canvas');
        canvas.width = targetPixelWidth;
        canvas.height = targetPixelHeight;

        const context = canvas.getContext('2d');
        if (!context) {
            return null;
        }

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, targetPixelWidth, targetPixelHeight);

        if ('close' in image && typeof image.close === 'function') {
            image.close();
        }

        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob((value) => {
                resolve(value);
            }, 'image/png');
        });
        if (!blob) {
            return null;
        }

        return new Uint8Array(await blob.arrayBuffer());
    }

    async function toSerializedPlacedImagePayload(
        payload: IPdfPlacedImageFinalizePayload | null | undefined,
    ): Promise<IPdfSerializedPlacedImagePayload | null> {
        if (!payload || payload.bytes.length === 0) {
            return null;
        }

        if (payload.mimeType === 'image/png' || payload.mimeType === 'image/jpeg') {
            return {
                ...payload,
                mimeType: payload.mimeType,
            };
        }

        const rasterizedBytes = await rasterizePlacedImage(payload);
        if (!rasterizedBytes) {
            BrowserLogger.warn(PDF_SERIALIZATION_LOG_SECTION, 'Failed to rasterize placed image for worker serialization', {
                pageNumber: payload.pageNumber,
                fileName: payload.fileName,
                mimeType: payload.mimeType,
                targetPixelWidth: payload.targetPixelWidth,
                targetPixelHeight: payload.targetPixelHeight,
            });
            return null;
        }

        return {
            ...payload,
            bytes: rasterizedBytes,
            mimeType: 'image/png',
        };
    }

    function getFreeTextNoteComments() {
        return annotationComments.value.filter(
            comment => comment.markerRect
                && comment.subtype
                && (comment.subtype.toLowerCase() === 'freetext' || comment.subtype.toLowerCase() === 'typewriter')
                && comment.hasNote,
        );
    }

    function createEmptySavePayload(): IPdfSerializationSavePayload {
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
            totalPages: totalPages.value,
            bookmarksDirty: false,
            bookmarkItems: [],
            untitledBookmarkLabel,
            placedImage: null,
        };
    }

    async function runSerializedEdit(
        data: Uint8Array,
        payload: IPdfSerializationSavePayload,
    ) {
        return measureDevPerfAsync('pdf:serialize-edits', async () => {
            const result = await serializePdfEditsOffThread(data, payload);
            if (!result) {
                return data;
            }

            if (
                payload.freeTextComments.length > 0
                && result.length < data.length * 0.5
            ) {
                BrowserLogger.warn(
                    PDF_SERIALIZATION_LOG_SECTION,
                    'serializePdfEdits: pdf-lib re-save lost data, falling back to original',
                    {
                        inputSize: data.length,
                        outputSize: result.length,
                    },
                );
                return data;
            }

            return result;
        }, {
            thresholdMs: 25,
            details: {
                markupOverrides: payload.markupSubtypeOverrides.length,
                shapes: payload.shapes.length,
                deletedShapeAnnotationIds: payload.deletedShapeAnnotationIds.length,
                freeTextComments: payload.freeTextComments.length,
                pendingEmbeddedTextUpdates: payload.pendingEmbeddedTextUpdates.length,
                pageLabelsDirty: payload.pageLabelsDirty,
                bookmarksDirty: payload.bookmarksDirty,
                hasPlacedImage: Boolean(payload.placedImage),
            },
        });
    }

    async function buildSavePayload(
        options?: ISerializePdfForSaveOptions,
    ): Promise<IPdfSerializationSavePayload> {
        const payload = createEmptySavePayload();
        payload.markupSubtypeOverrides = Array.from(getMarkupSubtypeOverrides()?.entries() ?? []);
        payload.markupSubtypeHints = collectMarkupSubtypeHints(annotationComments.value);
        payload.rewriteShapeState = options?.rewriteShapeState ?? false;
        payload.shapes = (options?.includeShapes ?? true) ? getAllShapes() : [];
        payload.deletedShapeAnnotationIds = getDeletedEmbeddedShapeAnnotationIds?.() ?? [];
        payload.deletedShapeStableKeys = getDeletedEmbeddedShapeStableKeys?.() ?? [];
        payload.freeTextComments = getFreeTextNoteComments();
        payload.annotationComments = annotationComments.value;
        payload.pendingEmbeddedTextUpdates = Array.from(options?.pendingTexts?.entries() ?? []);
        payload.pendingEmbeddedAnnotationDeletes = options?.pendingDeletes ?? [];
        payload.pageLabelsDirty = pageLabelsDirty.value;
        payload.pageLabelRanges = pageLabelRanges.value;
        payload.bookmarksDirty = bookmarksDirty?.value ?? false;
        payload.bookmarkItems = bookmarkItems?.value ?? [];
        payload.placedImage = await toSerializedPlacedImagePayload(options?.placedImage);
        return payload;
    }

    async function serializePdfForSave(
        data: Uint8Array,
        options?: ISerializePdfForSaveOptions,
    ): Promise<Uint8Array> {
        const payload = await buildSavePayload(options);
        return runSerializedEdit(data, payload);
    }

    async function rewriteMarkupSubtypes(data: Uint8Array): Promise<Uint8Array> {
        const payload = createEmptySavePayload();
        payload.markupSubtypeOverrides = Array.from(getMarkupSubtypeOverrides()?.entries() ?? []);
        payload.markupSubtypeHints = collectMarkupSubtypeHints(annotationComments.value);
        return runSerializedEdit(data, payload);
    }

    async function serializeShapeAnnotations(data: Uint8Array): Promise<Uint8Array> {
        const payload = createEmptySavePayload();
        payload.rewriteShapeState = true;
        payload.shapes = getAllShapes();
        payload.deletedShapeAnnotationIds = getDeletedEmbeddedShapeAnnotationIds?.() ?? [];
        payload.deletedShapeStableKeys = getDeletedEmbeddedShapeStableKeys?.() ?? [];
        return runSerializedEdit(data, payload);
    }

    async function rewriteFreeTextNoteRects(data: Uint8Array): Promise<Uint8Array> {
        const payload = createEmptySavePayload();
        payload.freeTextComments = getFreeTextNoteComments();
        return runSerializedEdit(data, payload);
    }

    async function rewriteEmbeddedNoteTexts(
        data: Uint8Array,
        pendingTexts: Map<string, string>,
    ): Promise<Uint8Array> {
        const payload = createEmptySavePayload();
        payload.annotationComments = annotationComments.value;
        payload.pendingEmbeddedTextUpdates = Array.from(pendingTexts.entries());
        return runSerializedEdit(data, payload);
    }

    async function rewritePageLabels(data: Uint8Array): Promise<Uint8Array> {
        const payload = createEmptySavePayload();
        payload.pageLabelsDirty = pageLabelsDirty.value;
        payload.pageLabelRanges = pageLabelRanges.value;
        return runSerializedEdit(data, payload);
    }

    async function embedPlacedImageToPage(
        data: Uint8Array,
        placement: IPdfPlacedImageFinalizePayload,
    ): Promise<Uint8Array> {
        const payload = createEmptySavePayload();
        payload.placedImage = await toSerializedPlacedImagePayload(placement);
        return runSerializedEdit(data, payload);
    }

    async function updateEmbeddedAnnotationByRef(comment: IAnnotationCommentSummary, text: string) {
        // Keep this path paired with rewriteFreeTextNoteRects in save flows.
        // PDF.js reads Popup text from the parent FreeText /Contents, so text
        // updates are safe only after the visible FreeText AP stream has been
        // neutralized by the rect rewrite pass.
        const sourceData = await getSourcePdfData();
        if (!sourceData) {
            return false;
        }

        return updateEmbeddedAnnotationTextOffThread(sourceData, comment, text);
    }

    async function deleteEmbeddedAnnotationByRef(comment: IAnnotationCommentSummary) {
        const sourceData = await getSourcePdfData();
        if (!sourceData) {
            BrowserLogger.warn(PDF_SERIALIZATION_LOG_SECTION, 'deleteEmbeddedByRef: no source data', {
                hasPdfData: Boolean(pdfData.value),
                hasWorkingCopy: Boolean(workingCopyPath.value),
            });
            return null;
        }

        return deleteEmbeddedAnnotationOffThread(sourceData, comment);
    }

    return {
        getSourcePdfData,
        serializePdfForSave,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        rewriteFreeTextNoteRects,
        rewriteEmbeddedNoteTexts,
        embedPlacedImageToPage,
        updateEmbeddedAnnotationByRef,
        deleteEmbeddedAnnotationByRef,
        rewritePageLabels,
    };
};
