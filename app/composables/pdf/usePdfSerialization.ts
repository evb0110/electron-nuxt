import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platformApi';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import type {
    IPdfSerializationSavePayload,
    IPdfSerializedPlacedImagePayload,
} from '@app/composables/pdf/pdfSerializationOperations';
import {
    collectMarkupSubtypeHints,
    type IMarkupSubtypeHint,
} from '@app/composables/pdf/pdfSerializationSubtypeHints';
import {
    deleteEmbeddedAnnotationOffThread,
    serializePdfEditsOffThread,
    updateEmbeddedAnnotationTextOffThread,
} from '@app/composables/pdf/pdfSerializationWorkerClient';
import { BrowserLogger } from '@app/utils/browserLogger';
import { toTransferableUint8Array } from '@app/platform/browser-api/browserWorkerTransfer';
import { decodeBrowserImageBlob } from '@app/platform/browser-api/browserImageDecode';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { measureDevPerfAsync } from '@app/utils/devPerf';
import { mergeAnnotationCommentSaveSnapshot } from '@app/composables/pdf/annotationCommentSaveSnapshot';

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
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[] | undefined;
    getAllShapes: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
}

interface ISerializePdfForSaveOptions {
    forceRewrite?: boolean;
    includeShapes?: boolean;
    rewriteShapeState?: boolean;
    pendingTexts?: Map<string, string> | null;
    pendingDeletes?: IAnnotationCommentSummary[] | null;
    annotationCommentsSnapshot?: IAnnotationCommentSummary[];
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
        getMarkupSubtypeHints,
        getAnnotationCommentsSnapshot,
        getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds,
        getDeletedEmbeddedShapeStableKeys,
    } = deps;

    async function getSourcePdfData() {
        let sourceData = pdfData.value ? toTransferableUint8Array(pdfData.value) : null;
        if (!sourceData && workingCopyPath.value) {
            const path = workingCopyPath.value;
            try {
                sourceData = toTransferableUint8Array(
                    await readDocumentBytes(path),
                );
            } catch (error) {
                BrowserLogger.warn(PDF_SERIALIZATION_LOG_SECTION, 'Failed to read working copy for serialization', {
                    path,
                    error,
                });
                throw error;
            }
        }
        return sourceData;
    }

    function getAnnotationCommentsForSerialization(
        snapshotOverride?: IAnnotationCommentSummary[],
    ) {
        return mergeAnnotationCommentSaveSnapshot(
            snapshotOverride ?? getAnnotationCommentsSnapshot?.(),
            annotationComments.value,
        );
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

        try {
            const context = canvas.getContext('2d');
            if (!context) {
                return null;
            }

            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(image, 0, 0, targetPixelWidth, targetPixelHeight);

            const blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob((value) => {
                    resolve(value);
                }, 'image/png');
            });
            if (!blob) {
                return null;
            }

            return new Uint8Array(await blob.arrayBuffer());
        } finally {
            if ('close' in image && typeof image.close === 'function') {
                image.close();
            }
            canvas.width = 0;
            canvas.height = 0;
        }
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

    function getFreeTextNoteComments(
        snapshotOverride?: IAnnotationCommentSummary[],
    ) {
        return getAnnotationCommentsForSerialization(snapshotOverride)
            .filter(
                comment => comment.markerRect
                    && comment.subtype
                    && (comment.subtype.toLowerCase() === 'freetext' || comment.subtype.toLowerCase() === 'typewriter')
                    && comment.hasNote,
            );
    }

    function createEmptySavePayload(): IPdfSerializationSavePayload {
        return {
            forceRewrite: false,
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

    function applyMarkupPayload(
        payload: IPdfSerializationSavePayload,
        additionalComments: IAnnotationCommentSummary[] = [],
        annotationCommentsSnapshot?: IAnnotationCommentSummary[],
    ) {
        payload.markupSubtypeOverrides = Array.from(getMarkupSubtypeOverrides()?.entries() ?? []);
        payload.markupSubtypeHints = [
            ...collectMarkupSubtypeHints(additionalComments),
            ...(getMarkupSubtypeHints?.() ?? []),
            ...collectMarkupSubtypeHints(getAnnotationCommentsForSerialization(annotationCommentsSnapshot)),
        ];
    }

    function applyShapePayload(
        payload: IPdfSerializationSavePayload,
        options?: Pick<ISerializePdfForSaveOptions, 'includeShapes' | 'rewriteShapeState'>,
    ) {
        payload.rewriteShapeState = options?.rewriteShapeState ?? false;
        payload.shapes = (options?.includeShapes ?? true) ? getAllShapes() : [];
        payload.deletedShapeAnnotationIds = getDeletedEmbeddedShapeAnnotationIds?.() ?? [];
        payload.deletedShapeStableKeys = getDeletedEmbeddedShapeStableKeys?.() ?? [];
    }

    function applyAnnotationPayload(
        payload: IPdfSerializationSavePayload,
        options?: Pick<ISerializePdfForSaveOptions, 'pendingTexts' | 'pendingDeletes' | 'annotationCommentsSnapshot'>,
    ) {
        payload.freeTextComments = getFreeTextNoteComments(options?.annotationCommentsSnapshot);
        payload.annotationComments = getAnnotationCommentsForSerialization(options?.annotationCommentsSnapshot);
        payload.pendingEmbeddedTextUpdates = Array.from(options?.pendingTexts?.entries() ?? []);
        payload.pendingEmbeddedAnnotationDeletes = options?.pendingDeletes ?? [];
    }

    function applyDocumentStructurePayload(payload: IPdfSerializationSavePayload) {
        payload.pageLabelsDirty = pageLabelsDirty.value;
        payload.pageLabelRanges = pageLabelRanges.value;
        payload.bookmarksDirty = bookmarksDirty?.value ?? false;
        payload.bookmarkItems = bookmarkItems?.value ?? [];
    }

    function assertPdfLibResultDidNotShrinkCatastrophically(
        operation: string,
        data: Uint8Array,
        result: Uint8Array | null,
    ) {
        if (!result || result.length >= data.length * 0.5) {
            return;
        }

        BrowserLogger.error(
            PDF_SERIALIZATION_LOG_SECTION,
            `${operation}: pdf-lib re-save lost more than half the document; refusing to persist`,
            {
                inputSize: data.length,
                outputSize: result.length,
            },
        );
        throw new Error(
            `PDF serialization produced a corrupted result (input ${data.length} bytes, output ${result.length} bytes); refusing to overwrite original`,
        );
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

            assertPdfLibResultDidNotShrinkCatastrophically('serializePdfEdits', data, result);

            return result;
        }, {
            thresholdMs: 25,
            details: {
                markupOverrides: payload.markupSubtypeOverrides.length,
                markupHints: payload.markupSubtypeHints.length,
                shapes: payload.shapes.length,
                deletedShapeAnnotationIds: payload.deletedShapeAnnotationIds.length,
                freeTextComments: payload.freeTextComments.length,
                pendingEmbeddedTextUpdates: payload.pendingEmbeddedTextUpdates.length,
                pageLabelsDirty: payload.pageLabelsDirty,
                bookmarksDirty: payload.bookmarksDirty,
                hasPlacedImage: Boolean(payload.placedImage),
                forceRewrite: Boolean(payload.forceRewrite),
            },
        });
    }

    async function buildSavePayload(
        options?: ISerializePdfForSaveOptions,
    ): Promise<IPdfSerializationSavePayload> {
        const payload = createEmptySavePayload();
        applyMarkupPayload(payload, [], options?.annotationCommentsSnapshot);
        applyShapePayload(payload, options);
        applyAnnotationPayload(payload, options);
        applyDocumentStructurePayload(payload);
        payload.forceRewrite = options?.forceRewrite === true;
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

    async function rewriteMarkupSubtypes(
        data: Uint8Array,
        additionalComments: IAnnotationCommentSummary[] = [],
    ): Promise<Uint8Array> {
        const payload = createEmptySavePayload();
        applyMarkupPayload(payload, additionalComments);
        return runSerializedEdit(data, payload);
    }

    async function serializeShapeAnnotations(data: Uint8Array): Promise<Uint8Array> {
        const payload = createEmptySavePayload();
        applyShapePayload(payload, {
            includeShapes: true,
            rewriteShapeState: true,
        });
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
        payload.freeTextComments = getFreeTextNoteComments();
        payload.annotationComments = getAnnotationCommentsForSerialization();
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

        const result = await updateEmbeddedAnnotationTextOffThread(sourceData, comment, text);
        assertPdfLibResultDidNotShrinkCatastrophically('updateEmbeddedAnnotationText', sourceData, result);
        return result;
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

        const result = await deleteEmbeddedAnnotationOffThread(sourceData, comment);
        assertPdfLibResultDidNotShrinkCatastrophically('deleteEmbeddedAnnotation', sourceData, result);
        return result;
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
