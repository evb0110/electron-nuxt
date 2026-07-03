import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IPdfOptimizeOptions } from '@contracts/electronApiDocuments';
import {
    usePdfSerialization,
    capturePdfReloadSnapshot,
    createPdfReloadWaiter,
} from '@app/modules/pdf-viewer/public';
import { useFileOperationsSaveController } from '@app/modules/workspace-shell/composables/file-operations/useFileOperationsSaveController';
import type {
    IFileOperationsSaveAdapterPorts,
    IWorkspaceSaveNativeMutationPersistencePort,
    IWorkspaceSaveNativeWorkingCopyPersistencePort,
    IWorkspaceSavePersistencePort,
    TWorkspacePdfViewerSavePort,
} from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getSearchCapability } from '@app/utils/getSearchCapability';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { getOcrCapability } from '@app/utils/getOcrCapability';
import { hasViewerShapeChanges } from '@app/modules/workspace-shell/annotations/hasViewerShapeChanges';
import type { IOcrSearchablePdfResult } from '@app/utils/ocr/ocrTypes';

interface IOcrCompletePayload extends IOcrSearchablePdfResult {
    sourceWorkingCopyPath: TDocumentRef;
    sourcePageToRestore?: number;
}

interface IOcrApplyReloadResult {
    restorePromise: Promise<void>;
    getRestoreError: () => unknown;
}

interface IPageSaveOrchestrationDeps {
    pdfData: Ref<Uint8Array | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<TWorkspacePdfViewerSavePort | null>;
    requestDocxExport: (selectedLanguages?: string[]) => Promise<boolean>;
    openOcrPopup: () => void;
    isExportingDocx: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    totalPages: Ref<number>;
    pageLabelsDirty: Ref<boolean>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    annotationDirty: Ref<boolean>;
    annotationNoteWindowsCount: Ref<number>;
    hasAnnotationChanges: () => boolean;
    hasLivePdfJsAnnotationChanges?: () => boolean;
    hasSavedPdfJsAnnotationBaselineChanges?: () => boolean;
    hasPreservedAnnotationSourceChanges?: () => boolean;
    markNativeFreeTextNotesSaved?: IWorkspaceSaveNativeMutationPersistencePort['markNativeFreeTextNotesSaved'];
    markNativeFreeTextNotesDeleted?: IWorkspaceSaveNativeMutationPersistencePort['markNativeFreeTextNotesDeleted'];
    markAnnotationSaved: (opts?: { preserveLivePdfjsSession?: boolean }) => void;
    getAnnotationSaveStateToken?: () => unknown;
    markPageLabelsSaved: () => void;
    getPageLabelsSaveStateToken?: () => unknown;
    markBookmarksSaved: () => void;
    getBookmarksSaveStateToken?: () => unknown;
    preserveMetadataForNextSourceReload?: (() => void) | undefined;
    clearPreservedSourceReloadMetadata?: (() => void) | undefined;
    isDirty: Ref<boolean>;
    hasPendingUnsavedChanges?: ComputedRef<boolean>;
    validatePdfPath: IWorkspaceSavePersistencePort['validatePdfPath'];
    saveFile: IWorkspaceSavePersistencePort['saveFile'];
    repairWorkingCopy?: IWorkspaceSaveNativeWorkingCopyPersistencePort['repairWorkingCopy'];
    optimizeWorkingCopy?: IWorkspaceSaveNativeWorkingCopyPersistencePort['optimizeWorkingCopy'];
    optimizeWorkingCopyAsCopy?: IWorkspaceSaveNativeWorkingCopyPersistencePort['optimizeWorkingCopyAsCopy'];
    saveWorkingCopy: IWorkspaceSavePersistencePort['saveWorkingCopy'];
    trySavePdfNativeMutations?: IWorkspaceSaveNativeMutationPersistencePort['trySavePdfNativeMutations'];
    trySaveEmbeddedNoteTextUpdates?: IWorkspaceSaveNativeMutationPersistencePort['trySaveEmbeddedNoteTextUpdates'];
    saveWorkingCopyAs: IWorkspaceSavePersistencePort['saveWorkingCopyAs'];
    optimizePdfOnSaveAs?: IWorkspaceSaveNativeWorkingCopyPersistencePort['optimizePdfOnSaveAs'];
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
    restorePendingEmbeddedTextUpdates?: (updates: Map<string, string> | null | undefined) => void;
    consumePendingEmbeddedAnnotationDeletes: () => IAnnotationCommentSummary[] | null;
    restorePendingEmbeddedAnnotationDeletes?: (deletions: IAnnotationCommentSummary[] | null | undefined) => void;
    clearAnnotationHistory?: () => void;
    loadRecentFiles: () => void;
    clearOcrCache: (path: TDocumentRef) => void;
    reloadWorkingCopyIntoHistory: (opts?: { markDirty?: boolean }) => Promise<boolean>;
    currentPage: Ref<number>;
    waitForPdfReload: (page: number) => Promise<void>;
    resetSearchCache: () => void;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const usePageSaveOrchestration = (deps: IPageSaveOrchestrationDeps) => {
    const { t } = useTypedI18n();
    const toast = useToast();

    const {
        pdfData,
        pdfDocument,
        pdfViewerRef,
        requestDocxExport,
        openOcrPopup,
        isExportingDocx,
        workingCopyPath,
        originalPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        isSaving,
        isSavingAs,
        annotationDirty,
        annotationNoteWindowsCount,
        hasAnnotationChanges,
        hasLivePdfJsAnnotationChanges,
        hasSavedPdfJsAnnotationBaselineChanges,
        hasPreservedAnnotationSourceChanges,
        markNativeFreeTextNotesSaved,
        markNativeFreeTextNotesDeleted,
        markAnnotationSaved,
        getAnnotationSaveStateToken,
        markPageLabelsSaved,
        getPageLabelsSaveStateToken,
        markBookmarksSaved,
        getBookmarksSaveStateToken,
        preserveMetadataForNextSourceReload,
        clearPreservedSourceReloadMetadata,
        isDirty,
        hasPendingUnsavedChanges,
        validatePdfPath,
        saveFile,
        repairWorkingCopy,
        optimizeWorkingCopy,
        saveWorkingCopy,
        trySavePdfNativeMutations,
        trySaveEmbeddedNoteTextUpdates,
        saveWorkingCopyAs,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        restorePendingEmbeddedTextUpdates,
        consumePendingEmbeddedAnnotationDeletes,
        restorePendingEmbeddedAnnotationDeletes,
        clearAnnotationHistory,
        loadRecentFiles,
        clearOcrCache,
        reloadWorkingCopyIntoHistory,
        currentPage,
        waitForPdfReload,
        resetSearchCache,
        runWithDocumentOperationLease,
    } = deps;

    const {
        getSourcePdfData,
        serializePdfForSave,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        embedPlacedImageToPage,
        updateEmbeddedAnnotationByRef: updateEmbeddedByRef,
        deleteEmbeddedAnnotationByRef: deleteEmbeddedByRef,
        rewritePageLabels,
    } = usePdfSerialization({
        pdfData,
        workingCopyPath,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        untitledBookmarkLabel: t('bookmarks.untitled'),
        getMarkupSubtypeOverrides: () => pdfViewerRef.value?.getMarkupSubtypeOverrides(),
        getMarkupSubtypeHints: () => pdfViewerRef.value?.getMarkupSubtypeHints?.(),
        getAnnotationCommentsSnapshot: () => pdfViewerRef.value?.getAnnotationCommentsSnapshot?.(),
        getAllShapes: () => pdfViewerRef.value?.getAllShapes() ?? [],
        getDeletedEmbeddedShapeAnnotationIds: () => pdfViewerRef.value?.getDeletedEmbeddedShapeAnnotationIds() ?? [],
        getDeletedEmbeddedShapeStableKeys: () => pdfViewerRef.value?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
    });

    const fileOperationsSavePorts: IFileOperationsSaveAdapterPorts = {
        state: {
            status: {
                isSaving,
                isSavingAs,
            },
            documentIdentity: {
                workingCopyPath,
                originalPath,
            },
            annotations: {
                annotationDirty,
                annotationComments,
                markAnnotationSaved,
                ...(getAnnotationSaveStateToken ? { getAnnotationSaveStateToken } : {}),
                hasAnnotationChanges,
                ...(hasLivePdfJsAnnotationChanges ? { hasLivePdfJsAnnotationChanges } : {}),
                ...(hasSavedPdfJsAnnotationBaselineChanges ? { hasSavedPdfJsAnnotationBaselineChanges } : {}),
                ...(hasPreservedAnnotationSourceChanges ? { hasPreservedAnnotationSourceChanges } : {}),
            },
            metadata: {
                totalPages,
                pageLabelsDirty,
                pageLabelRanges,
                bookmarksDirty,
                bookmarkItems,
                untitledBookmarkLabel: t('bookmarks.untitled'),
            },
            metadataCompletion: {
                markPageLabelsSaved,
                ...(getPageLabelsSaveStateToken ? { getPageLabelsSaveStateToken } : {}),
                markBookmarksSaved,
                ...(getBookmarksSaveStateToken ? { getBookmarksSaveStateToken } : {}),
            },
        },
        pdf: {
            source: {
                pdfDocument,
                runSaveTransaction: request => pdfViewerRef.value?.runSaveTransaction(request) ?? Promise.reject(new Error('Missing PDF viewer save transaction')),
                saveDocument: () => pdfViewerRef.value?.saveDocument() ?? Promise.resolve(null),
                getSourcePdfData,
                commitPdfEditorsForSave: () => pdfViewerRef.value?.commitPdfEditorsForSave?.() ?? Promise.resolve(),
            },
            serialization: { serializePdfForSave },
        },
        persistence: {
            file: {
                validatePdfPath,
                saveFile,
                saveWorkingCopy,
                saveWorkingCopyAs,
            },
            nativeWorkingCopy: {
                ...(repairWorkingCopy ? { repairWorkingCopy } : {}),
                ...(optimizeWorkingCopy ? { optimizeWorkingCopy } : {}),
                ...(deps.optimizeWorkingCopyAsCopy ? { optimizeWorkingCopyAsCopy: deps.optimizeWorkingCopyAsCopy } : {}),
                ...(deps.optimizePdfOnSaveAs !== undefined ? { optimizePdfOnSaveAs: deps.optimizePdfOnSaveAs } : {}),
                getWorkingCopySize: async path => (await getDocumentFilesCapability().statFile(path)).size,
            },
            nativeMutations: {
                ...(trySavePdfNativeMutations !== undefined ? { trySavePdfNativeMutations } : {}),
                ...(trySaveEmbeddedNoteTextUpdates !== undefined ? { trySaveEmbeddedNoteTextUpdates } : {}),
                ...(markNativeFreeTextNotesSaved ? { markNativeFreeTextNotesSaved } : {}),
                ...(markNativeFreeTextNotesDeleted ? { markNativeFreeTextNotesDeleted } : {}),
            },
        },
        annotationEdits: {
            persistAllAnnotationNotes,
            consumePendingEmbeddedTextUpdates,
            ...(restorePendingEmbeddedTextUpdates !== undefined ? { restorePendingEmbeddedTextUpdates } : {}),
            consumePendingEmbeddedAnnotationDeletes,
            ...(restorePendingEmbeddedAnnotationDeletes !== undefined ? { restorePendingEmbeddedAnnotationDeletes } : {}),
            ...(clearAnnotationHistory !== undefined ? { clearAnnotationHistory } : {}),
            annotationNoteWindowsCount,
        },
        viewer: {
            markup: {
                getMarkupSubtypeOverrides: () => pdfViewerRef.value?.getMarkupSubtypeOverrides(),
                getMarkupSubtypeHints: () => pdfViewerRef.value?.getMarkupSubtypeHints?.(),
                getAnnotationCommentsSnapshot: () => pdfViewerRef.value?.getAnnotationCommentsSnapshot?.(),
                getPendingEmbeddedMutationSnapshot: () => pdfViewerRef.value?.getPendingEmbeddedMutationSnapshot?.(),
            },
            shapes: {
                hasShapeChanges: () => hasViewerShapeChanges(pdfViewerRef.value),
                hasManagedShapes: () => (pdfViewerRef.value?.getAllShapes().length ?? 0) > 0,
                getAllShapes: () => pdfViewerRef.value?.getAllShapes() ?? [],
                getDeletedEmbeddedShapeAnnotationIds: () => pdfViewerRef.value?.getDeletedEmbeddedShapeAnnotationIds() ?? [],
                getDeletedEmbeddedShapeStableKeys: () => pdfViewerRef.value?.getDeletedEmbeddedShapeStableKeys?.() ?? [],
            },
            shapeState: {
                markShapeStateSaved: () => pdfViewerRef.value?.markSavedShapeState?.(),
                preparePersistedShapeStateForSave: (data) => (
                    pdfViewerRef.value?.preparePersistedManagedShapesForSave?.(data) ?? Promise.resolve(null)
                ),
                restorePreparedPersistedShapeState: (snapshot: unknown) => (
                    pdfViewerRef.value?.restorePreparedManagedShapesAfterFailedSave?.(snapshot) ?? Promise.resolve()
                ),
                adoptPersistedShapeStateForNextReload: () => pdfViewerRef.value?.adoptPersistedManagedShapesOnNextImport?.(),
                clearPendingPersistedShapeStateForNextReload: () => pdfViewerRef.value?.clearPendingManagedShapeImportAdoption?.(),
            },
        },
        lifecycle: {
            loadRecentFiles,
            preparePostSaveReload: () => {
                const shouldPreserveMetadata = pageLabelsDirty.value || bookmarksDirty.value;
                if (shouldPreserveMetadata) {
                    preserveMetadataForNextSourceReload?.();
                }
                const capturedReloadState = capturePdfReloadSnapshot(pdfViewerRef.value, currentPage.value);
                pdfViewerRef.value?.preserveNextSourceReloadVisibleContent?.({
                    scrollSnapshot: capturedReloadState.scrollSnapshot,
                    pageToRestore: capturedReloadState.pageToRestore,
                });

                const reloadWaiter = createPdfReloadWaiter({
                    pdfDocument,
                    pdfViewerRef,
                    resetSearchCache,
                    pageToRestore: capturedReloadState.pageToRestore,
                    scrollSnapshot: capturedReloadState.scrollSnapshot,
                    restoreScroll: capturedReloadState.scrollSnapshot !== null,
                });
                return {
                    promise: reloadWaiter.promise,
                    cancel: () => {
                        if (shouldPreserveMetadata) {
                            clearPreservedSourceReloadMetadata?.();
                        }
                        reloadWaiter.cancel();
                    },
                };
            },
        },
        ...(runWithDocumentOperationLease !== undefined ? {operationLease: { runWithDocumentOperationLease }} : {}),
    };

    const {
        handleSave: handleSaveWithReload,
        handleRepairSave: handleRepairSaveWithReload,
        handleOptimizePdfForInteraction: handleOptimizePdfForInteractionWithReload,
        handleOptimizePdfAsCopy: handleOptimizePdfAsCopyWithReload,
        handleSaveAs: handleSaveAsWithReload,
    } = useFileOperationsSaveController(fileOperationsSavePorts);

    const isAnySaving = computed(() => isSaving.value || isSavingAs.value);
    const isExportingDocxState = computed(() => isExportingDocx.value);
    const canSave = computed(() => (
        hasPendingUnsavedChanges
            ? hasPendingUnsavedChanges.value
            : (
                isDirty.value
                || annotationDirty.value
                || hasAnnotationChanges()
                || (hasLivePdfJsAnnotationChanges?.() ?? false)
                || (hasSavedPdfJsAnnotationBaselineChanges?.() ?? false)
                || (hasPreservedAnnotationSourceChanges?.() ?? false)
                || pageLabelsDirty.value
                || bookmarksDirty.value
            )
    ));

    async function handleExportDocx(selectedLanguages?: string[]) {
        const result = await requestDocxExport(selectedLanguages);
        if (result === false) {
            openOcrPopup();
        }
    }

    async function handleSave() {
        return handleSaveWithReload();
    }

    async function handleRepairSave() {
        return handleRepairSaveWithReload();
    }

    async function handleOptimizePdfForInteraction() {
        if (canSave.value) {
            const saved = await handleSaveWithReload();
            if (!saved) {
                return false;
            }
        }

        return handleOptimizePdfForInteractionWithReload();
    }

    async function handleOptimizePdfAsCopy(options: IPdfOptimizeOptions, requestId?: string) {
        if (canSave.value) {
            const saved = await handleSaveWithReload();
            if (!saved) {
                return false;
            }
        }

        return handleOptimizePdfAsCopyWithReload(options, requestId);
    }

    async function handleSaveAs() {
        return handleSaveAsWithReload();
    }

    function saveForExternalRead() {
        return handleSaveWithReload();
    }

    async function acknowledgeOcrResultFile(payload: IOcrCompletePayload) {
        if (!payload.requiresCleanupAck) {
            return;
        }

        try {
            const ackResult = await getOcrCapability().acknowledgeResultFile(payload.requestId, payload.pdfPath);
            if (!ackResult.cleaned && ackResult.error) {
                BrowserLogger.warn('ocr', 'OCR cleanup acknowledgement was rejected', {
                    requestId: payload.requestId,
                    path: payload.pdfPath,
                    error: ackResult.error,
                });
            }
        } catch (ackErr) {
            BrowserLogger.warn('ocr', 'Failed to acknowledge OCR temp result file', {
                requestId: payload.requestId,
                path: payload.pdfPath,
                error: ackErr,
            });
        }
    }

    async function replaceOcrWorkingCopyForActiveDocument(
        payload: IOcrCompletePayload,
        pageToRestore: number,
    ): Promise<IOcrApplyReloadResult | null> {
        if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
            BrowserLogger.debug('ocr', 'Ignoring stale OCR result for inactive document', {
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                currentWorkingCopyPath: workingCopyPath.value,
            });
            await acknowledgeOcrResultFile(payload);
            return null;
        }

        let restoreError: unknown = null;
        let restorePromise: Promise<void> | null = null;

        clearOcrCache(payload.sourceWorkingCopyPath);
        resetSearchCache();

        let didReplaceWorkingCopy = false;
        try {
            await getDocumentFilesCapability().replaceWorkingCopyFromPath(
                payload.sourceWorkingCopyPath,
                payload.pdfPath,
            );
            didReplaceWorkingCopy = true;
            if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
                BrowserLogger.debug('ocr', 'Skipped stale OCR reload wait after document switch', {
                    sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                    currentWorkingCopyPath: workingCopyPath.value,
                });
                return null;
            }

            restorePromise = waitForPdfReload(pageToRestore).catch((error) => {
                restoreError = error;
            });
            const didReload = await reloadWorkingCopyIntoHistory({ markDirty: true });
            if (!didReload) {
                BrowserLogger.debug('ocr', 'Skipped stale OCR reload after working copy replacement', {
                    sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                    currentWorkingCopyPath: workingCopyPath.value,
                });
                void restorePromise;
                return null;
            }
        } catch (error) {
            void restorePromise;
            throw error;
        } finally {
            if (didReplaceWorkingCopy) {
                await acknowledgeOcrResultFile(payload);
            }
        }

        if (restorePromise === null) {
            return null;
        }

        return {
            restorePromise,
            getRestoreError: () => restoreError,
        };
    }

    async function applyOcrCompleteResult(payload: IOcrCompletePayload) {
        const pageToRestore = payload.sourcePageToRestore ?? currentPage.value;
        const warmupWorkingPath = payload.sourceWorkingCopyPath;
        const warmupPageCountHint = totalPages.value > 0 ? totalPages.value : undefined;
        const applyReloadResult = runWithDocumentOperationLease
            ? await runWithDocumentOperationLease(
                'ocr-apply',
                () => replaceOcrWorkingCopyForActiveDocument(payload, pageToRestore),
            )
            : await replaceOcrWorkingCopyForActiveDocument(payload, pageToRestore);

        if (!applyReloadResult) {
            return;
        }

        const {
            restorePromise,
            getRestoreError,
        } = applyReloadResult;

        await restorePromise;
        if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
            BrowserLogger.debug('ocr', 'Skipped stale OCR completion after document switch', {
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                currentWorkingCopyPath: workingCopyPath.value,
            });
            return;
        }
        const restoreError = getRestoreError();
        if (restoreError) {
            BrowserLogger.warn('ocr', 'OCR result was applied but page restore failed', {
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                pageToRestore,
                error: restoreError,
            });
        }

        if (warmupWorkingPath) {
            // Prewarm search index and worker caches after OCR persistence and reload cache reset.
            void getSearchCapability().warmIndex(warmupWorkingPath, {...(warmupPageCountHint !== undefined ? { pageCount: warmupPageCountHint } : {})}).catch((error) => {
                const warmIndexError: unknown = error;
                BrowserLogger.debug('pdf-search', 'Failed to prewarm search index after OCR', {
                    path: warmupWorkingPath,
                    pageCount: warmupPageCountHint,
                    error: warmIndexError,
                });
            });
        }

        toast.add({
            color: 'success',
            title: t('ocr.complete'),
        });
    }

    async function handleOcrComplete(payload: IOcrCompletePayload) {
        try {
            await applyOcrCompleteResult(payload);
        } catch (error) {
            BrowserLogger.error('ocr', 'Failed to apply OCR result', {
                requestId: payload.requestId,
                sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                pdfPath: payload.pdfPath,
                error,
            });
            toast.add({
                color: 'error',
                title: t('errors.ocr.createSearchablePdf'),
            });
        }
    }

    async function getEmbeddedMutationBaseData() {
        if (!hasAnnotationChanges()) {
            return getSourcePdfData();
        }

        const result = await pdfViewerRef.value?.runSaveTransaction({
            mode: 'embedded-mutation',
            forcePdfjsMaterialize: true,
            serializeResult: false,
        });
        return result?.serializedBytes ?? result?.baseBytes ?? null;
    }

    return {
        getSourcePdfData,
        getEmbeddedMutationBaseData,
        serializePdfForSave,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        embedPlacedImageToPage,
        updateEmbeddedByRef,
        deleteEmbeddedByRef,
        rewritePageLabels,
        handleSave,
        handleRepairSave,
        handleOptimizePdfForInteraction,
        handleOptimizePdfAsCopy,
        handleSaveAs,
        saveForExternalRead,
        handleExportDocx,
        handleOcrComplete,
        isAnySaving,
        isExportingDocx: isExportingDocxState,
        canSave,
    };
};
