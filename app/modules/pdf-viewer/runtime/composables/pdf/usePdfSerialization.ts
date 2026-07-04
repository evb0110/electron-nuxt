import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { parsePageIndex } from '@contracts/pageNumbers';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import type { IPdfSerializedPlacedImagePayload } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-placed-images/pdfSerializedPlacedImagePayload';
import { collectMarkupSubtypeHints } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/collectMarkupSubtypeHints';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import { deleteEmbeddedAnnotationOffThread } from '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/deleteEmbeddedAnnotationOffThread';
import { serializePdfEditsOffThread } from '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread';
import { updateEmbeddedAnnotationTextOffThread } from '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/updateEmbeddedAnnotationTextOffThread';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    decodeBrowserImageBlob,
    toTransferableUint8Array,
} from '@app/platform/browser-api/public';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { measureDevPerfAsync } from '@app/utils/devPerf';
import { mergeAnnotationCommentSaveSnapshot } from '@app/modules/pdf-viewer/engine/annotation-comment-save-snapshot/mergeAnnotationCommentSaveSnapshot';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { toPdfDateString } from '@app/utils/pdfDate';
import { getErrorMessage } from '@app/utils/error';

const PDF_SERIALIZATION_LOG_SECTION = 'pdf-serialization';

export interface IPdfSerializationDeps {
    pdfData: Ref<Uint8Array | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
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
        documentRevisionToken,
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
    ) {
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
            BrowserLogger.error(PDF_SERIALIZATION_LOG_SECTION, 'Failed to rasterize placed image for worker serialization', {
                pageNumber: payload.pageNumber,
                fileName: payload.fileName,
                mimeType: payload.mimeType,
                targetPixelWidth: payload.targetPixelWidth,
                targetPixelHeight: payload.targetPixelHeight,
            });
            throw new Error('Failed to rasterize placed image for PDF embedding');
        }

        return {
            ...payload,
            bytes: rasterizedBytes,
            mimeType: 'image/png',
        };
    }

    function toNativePlacedImagePayload(payload: IPdfSerializedPlacedImagePayload) {
        if (
            payload.mimeType !== 'image/jpeg'
            || payload.bytes.length === 0
            || !Number.isSafeInteger(payload.pageNumber)
            || payload.pageNumber < 1
        ) {
            return null;
        }

        const pageIndex = parsePageIndex(payload.pageNumber - 1);
        if (pageIndex === null) {
            return null;
        }

        return {
            pageIndex,
            x: payload.x,
            y: payload.y,
            width: payload.width,
            height: payload.height,
            rotationDegrees: payload.rotationDegrees,
            mimeType: 'image/jpeg' as const,
            bytes: payload.bytes,
        };
    }

    function bytesToHex(bytes: Uint8Array) {
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function createWorkingCopyExpectation(baseData: Uint8Array) {
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            return null;
        }
        const hashInput = new Uint8Array(baseData.byteLength);
        hashInput.set(baseData);
        const digest = await crypto.subtle.digest('SHA-256', hashInput);
        return {
            byteLength: baseData.byteLength,
            sha256: bytesToHex(new Uint8Array(digest)),
        };
    }

    async function tryEmbedPlacedImageNative(
        baseData: Uint8Array,
        payload: IPdfSerializedPlacedImagePayload,
    ) {
        const workingPath = workingCopyPath.value;
        const nativeImage = toNativePlacedImagePayload(payload);
        const documentFiles = getDocumentFilesCapability();
        if (
            !workingPath
            || !nativeImage
            || typeof documentFiles.applyPdfNativeMutationsToWorkingCopy !== 'function'
        ) {
            return null;
        }

        try {
            const expectedBase = await createWorkingCopyExpectation(baseData);
            if (!expectedBase) {
                BrowserLogger.debug(PDF_SERIALIZATION_LOG_SECTION, 'Native placed image mutation skipped because base hashing is unavailable', {pageNumber: payload.pageNumber});
                return null;
            }
            const result = await documentFiles.applyPdfNativeMutationsToWorkingCopy(
                workingPath,
                {placedImages: [nativeImage]},
                toPdfDateString(),
                expectedBase,
                {expectedDocumentRevisionToken: documentRevisionToken?.value ?? null},
            );
            if (!result.applied || !result.validation?.isValid) {
                BrowserLogger.debug(PDF_SERIALIZATION_LOG_SECTION, 'Native placed image mutation was not applied', {
                    pageNumber: payload.pageNumber,
                    validation: result.validation,
                });
                return null;
            }
            if (workingCopyPath.value !== workingPath) {
                BrowserLogger.debug(PDF_SERIALIZATION_LOG_SECTION, 'Skipped stale native placed image result', {
                    workingPath,
                    currentWorkingPath: workingCopyPath.value,
                });
                return null;
            }
            return toTransferableUint8Array(await readDocumentBytes(workingPath));
        } catch (error) {
            BrowserLogger.debug(PDF_SERIALIZATION_LOG_SECTION, 'Native placed image mutation failed; falling back to pdf-lib', {
                pageNumber: payload.pageNumber,
                error: getErrorMessage(error),
            });
            return null;
        }
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
    ) {
        const payload = await buildSavePayload(options);
        return runSerializedEdit(data, payload);
    }

    async function rewriteMarkupSubtypes(
        data: Uint8Array,
        additionalComments: IAnnotationCommentSummary[] = [],
    ) {
        const payload = createEmptySavePayload();
        applyMarkupPayload(payload, additionalComments);
        return runSerializedEdit(data, payload);
    }

    async function serializeShapeAnnotations(data: Uint8Array) {
        const payload = createEmptySavePayload();
        applyShapePayload(payload, {
            includeShapes: true,
            rewriteShapeState: true,
        });
        return runSerializedEdit(data, payload);
    }

    async function rewriteFreeTextNoteRects(data: Uint8Array) {
        const payload = createEmptySavePayload();
        payload.freeTextComments = getFreeTextNoteComments();
        return runSerializedEdit(data, payload);
    }

    async function rewriteEmbeddedNoteTexts(
        data: Uint8Array,
        pendingTexts: Map<string, string>,
    ) {
        const payload = createEmptySavePayload();
        payload.freeTextComments = getFreeTextNoteComments();
        payload.annotationComments = getAnnotationCommentsForSerialization();
        payload.pendingEmbeddedTextUpdates = Array.from(pendingTexts.entries());
        return runSerializedEdit(data, payload);
    }

    async function rewritePageLabels(data: Uint8Array) {
        const payload = createEmptySavePayload();
        payload.pageLabelsDirty = pageLabelsDirty.value;
        payload.pageLabelRanges = pageLabelRanges.value;
        return runSerializedEdit(data, payload);
    }

    async function embedPlacedImageToPage(
        data: Uint8Array,
        placement: IPdfPlacedImageFinalizePayload,
    ) {
        const serializedPlacement = await toSerializedPlacedImagePayload(placement);
        if (serializedPlacement) {
            const nativeResult = await tryEmbedPlacedImageNative(data, serializedPlacement);
            if (nativeResult) {
                return nativeResult;
            }
        }
        if (!serializedPlacement) {
            throw new Error('Failed to prepare placed image for PDF embedding');
        }
        const payload = createEmptySavePayload();
        payload.placedImage = serializedPlacement;
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
