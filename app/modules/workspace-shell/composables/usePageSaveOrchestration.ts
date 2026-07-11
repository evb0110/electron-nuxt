import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {
    PDFDocumentProxy,
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfOptimizeOptions } from '@contracts/electronApiDocuments';
import { isStaleRevisionError } from '@contracts/documentMutationErrors';
import {
    usePdfSerialization,
    resolvePdfReloadPage,
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
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
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
    clearAnnotationHistory?: () => void;
    loadRecentFiles: () => void;
    clearOcrCache: (path: TDocumentRef) => void;
    ensureHistoryBaselineForExternalMutation: () => Promise<boolean>;
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
        documentRevisionToken,
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
        clearAnnotationHistory,
        loadRecentFiles,
        clearOcrCache,
        ensureHistoryBaselineForExternalMutation,
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
        documentRevisionToken,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        untitledBookmarkLabel: t('bookmarks.untitled'),
        getMarkupSubtypeOverrides: () => pdfViewerRef.value?.getMarkupSubtypeOverrides(),
        getMarkupSubtypeHints: () => pdfViewerRef.value?.getMarkupSubtypeHints?.(),
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
                documentRevisionToken,
            },
            annotations: {
                annotationDirty,
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
            },
        },
        annotationEdits: {
            persistAllAnnotationNotes,
            ...(clearAnnotationHistory !== undefined ? { clearAnnotationHistory } : {}),
            annotationNoteWindowsCount,
        },
        viewer: {
            markup: {
                getMarkupSubtypeOverrides: () => pdfViewerRef.value?.getMarkupSubtypeOverrides(),
                getMarkupSubtypeHints: () => pdfViewerRef.value?.getMarkupSubtypeHints?.(),
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
                const scrollSnapshot = pdfViewerRef.value?.captureScrollSnapshot?.() ?? null;
                const pageToRestore = resolvePdfReloadPage(scrollSnapshot?.anchorPage ?? currentPage.value);
                pdfViewerRef.value?.preserveNextSourceReloadVisibleContent?.({
                    ...(scrollSnapshot ? {scrollSnapshot} : {}),
                    pageToRestore,
                });

                const reloadWaiter = createPdfReloadWaiter({
                    pdfDocument,
                    pdfViewerRef,
                    resetSearchCache,
                    pageToRestore,
                    restoreScroll: true,
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
            const didPrimeHistory = await ensureHistoryBaselineForExternalMutation();
            if (!didPrimeHistory) {
                await acknowledgeOcrResultFile(payload);
                throw new Error('Failed to prime OCR history before applying searchable PDF result');
            }
            if (workingCopyPath.value !== payload.sourceWorkingCopyPath) {
                BrowserLogger.debug('ocr', 'Skipped stale OCR apply after history baseline setup', {
                    sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                    currentWorkingCopyPath: workingCopyPath.value,
                });
                await acknowledgeOcrResultFile(payload);
                return null;
            }

            await getDocumentFilesCapability().replaceWorkingCopyFromPath(
                payload.sourceWorkingCopyPath,
                payload.pdfPath,
                {expectedDocumentRevisionToken: payload.sourceDocumentRevisionToken},
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
            if (isStaleRevisionError(error)) {
                BrowserLogger.warn('ocr', 'Skipped OCR apply because the document changed after OCR started', {
                    requestId: payload.requestId,
                    sourceWorkingCopyPath: payload.sourceWorkingCopyPath,
                    sourceDocumentRevisionToken: payload.sourceDocumentRevisionToken,
                    pdfPath: payload.pdfPath,
                    error,
                });
                await acknowledgeOcrResultFile(payload);
                toast.add({
                    color: 'error',
                    title: t('errors.ocr.changedReload'),
                });
                return;
            }
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
