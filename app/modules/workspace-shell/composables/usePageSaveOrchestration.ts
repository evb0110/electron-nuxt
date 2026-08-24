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
import type { IScrollSnapshot } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfOptimizeOptions } from '@contracts/electronApiDocuments';
import {
    usePdfSerialization,
    resolvePdfReloadPage,
    createPdfReloadWaiter,
    resolvePdfViewerSaveTransactionFinalBytes,
    type IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import type {IWorkspaceSaveDependencies} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import type {TWorkspaceFailureSurface} from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import {useWorkspaceSaveService} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { hasViewerShapeChanges } from '@app/modules/workspace-shell/annotations/hasViewerShapeChanges';

type TPageSaveViewer = IPdfViewerExpose & {
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: {fallbackPage?: number | null},
    ) => void;
    preserveNextSourceReloadVisibleContent?: (request?: {
        scrollSnapshot?: IScrollSnapshot | null;
        pageToRestore?: number | null;
    }) => void;
};

interface IPageSaveOrchestrationDeps {
    pdfData: Ref<Uint8Array | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<TPageSaveViewer | null>;
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
    pendingEmbeddedAnnotationDeleteCount: Ref<number>;
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
    validatePdfPath: IWorkspaceSaveDependencies['persistence']['validatePdfPath'];
    saveFile: IWorkspaceSaveDependencies['persistence']['saveSerialized'];
    repairWorkingCopy?: IWorkspaceSaveDependencies['persistence']['repairWorkingCopy'];
    optimizeWorkingCopy?: IWorkspaceSaveDependencies['persistence']['optimizeWorkingCopy'];
    optimizeWorkingCopyAsCopy?: IWorkspaceSaveDependencies['persistence']['optimizeWorkingCopyAsCopy'];
    saveWorkingCopy: IWorkspaceSaveDependencies['persistence']['saveWorkingCopy'];
    trySavePdfNativeMutations?: IWorkspaceSaveDependencies['persistence']['trySavePdfNativeMutations'];
    trySaveEmbeddedNoteTextUpdates?: IWorkspaceSaveDependencies['persistence']['trySaveEmbeddedNoteTextUpdates'];
    saveWorkingCopyAs: IWorkspaceSaveDependencies['persistence']['saveAs'];
    optimizePdfOnSaveAs?: Ref<boolean>;
    persistAllAnnotationNotes: () => Promise<boolean>;
    loadRecentFiles: () => void;
    currentPage: Ref<number>;
    resetSearchCache: () => void;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
    failureSurface?: TWorkspaceFailureSurface;
}

export const usePageSaveOrchestration = (deps: IPageSaveOrchestrationDeps) => {
    const { t } = useTypedI18n();

    const {
        pdfData,
        pdfDocument,
        pdfViewerRef,
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
        pendingEmbeddedAnnotationDeleteCount,
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
        loadRecentFiles,
        currentPage,
        resetSearchCache,
        runWithDocumentOperationLease,
    } = deps;

    const {
        getSourcePdfData,
        serializePdfForSave,
        rewriteMarkupSubtypes,
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
        ensureManagedShapeBaselineReady: () => (
            pdfViewerRef.value?.ensureManagedShapeBaselineReady?.() ?? Promise.resolve(true)
        ),
    });

    const saveDependencies: IWorkspaceSaveDependencies = {
        status: {
            isSaving,
            isSavingAs,
        },
        document: {
            workingCopyPath,
            originalPath,
            revisionToken: documentRevisionToken,
        },
        annotations: {
            dirty: annotationDirty,
            markSaved: markAnnotationSaved,
            ...(getAnnotationSaveStateToken ? {getSaveStateToken: getAnnotationSaveStateToken} : {}),
            hasChanges: hasAnnotationChanges,
            ...(hasLivePdfJsAnnotationChanges ? {hasLivePdfJsChanges: hasLivePdfJsAnnotationChanges} : {}),
            ...(hasSavedPdfJsAnnotationBaselineChanges
                ? {hasSavedPdfJsBaselineChanges: hasSavedPdfJsAnnotationBaselineChanges}
                : {}),
            ...(hasPreservedAnnotationSourceChanges
                ? {hasPreservedSourceChanges: hasPreservedAnnotationSourceChanges}
                : {}),
            hasPendingDeletes: () => pendingEmbeddedAnnotationDeleteCount.value > 0,
            openNoteCount: annotationNoteWindowsCount,
            persistOpenNotes: persistAllAnnotationNotes,
        },
        metadata: {
            totalPages,
            pageLabelsDirty,
            pageLabelRanges,
            bookmarksDirty,
            bookmarkItems,
            untitledBookmarkLabel: t('bookmarks.untitled'),
            markPageLabelsSaved,
            ...(getPageLabelsSaveStateToken
                ? {getPageLabelsSaveStateToken}
                : {}),
            markBookmarksSaved,
            ...(getBookmarksSaveStateToken
                ? {getBookmarksSaveStateToken}
                : {}),
        },
        pdf: {
            document: pdfDocument,
            runSaveTransaction: request => pdfViewerRef.value?.runSaveTransaction(request)
                ?? Promise.reject(new Error('Missing PDF viewer save transaction')),
            getSourceData: getSourcePdfData,
            serializeForSave: serializePdfForSave,
        },
        persistence: {
            validatePdfPath,
            saveSerialized: saveFile,
            saveWorkingCopy,
            saveAs: saveWorkingCopyAs,
            ...(repairWorkingCopy ? {repairWorkingCopy} : {}),
            ...(optimizeWorkingCopy ? {optimizeWorkingCopy} : {}),
            ...(deps.optimizeWorkingCopyAsCopy
                ? {optimizeWorkingCopyAsCopy: deps.optimizeWorkingCopyAsCopy}
                : {}),
            ...(trySavePdfNativeMutations ? {trySavePdfNativeMutations} : {}),
            ...(trySaveEmbeddedNoteTextUpdates
                ? {trySaveEmbeddedNoteTextUpdates}
                : {}),
            getWorkingCopySize: async path => (
                await getDocumentFilesCapability().statFile(path)
            ).size,
        },
        shapes: {
            hasChanges: () => hasViewerShapeChanges(pdfViewerRef.value),
            hasManagedShapes: () => (pdfViewerRef.value?.getAllShapes().length ?? 0) > 0,
            markSaved: prepared => pdfViewerRef.value?.markSavedShapeState?.(prepared),
            preparePersistedState: data => (
                pdfViewerRef.value?.preparePersistedManagedShapesForSave?.(data)
                ?? Promise.resolve(null)
            ),
            restorePreparedState: snapshot => (
                pdfViewerRef.value?.restorePreparedManagedShapesAfterFailedSave?.(snapshot)
                ?? Promise.resolve()
            ),
            adoptPersistedStateOnReload: () => (
                pdfViewerRef.value?.adoptPersistedManagedShapesOnNextImport?.()
            ),
            clearPendingPersistedState: () => (
                pdfViewerRef.value?.clearPendingManagedShapeImportAdoption?.()
            ),
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
        ...(runWithDocumentOperationLease ? {runWithDocumentOperationLease} : {}),
        ...(deps.failureSurface ? {failureSurface: deps.failureSurface} : {}),
    };

    const {
        handleSave: handleSaveWithReload,
        handleRepairSave: handleRepairSaveWithReload,
        handleOptimizePdfForInteraction: handleOptimizePdfForInteractionWithReload,
        handleOptimizePdfAsCopy: handleOptimizePdfAsCopyWithReload,
        handleSaveAs: handleSaveAsWithReload,
        hasSaveFailure,
    } = useWorkspaceSaveService(saveDependencies);

    const isAnySaving = computed(() => isSaving.value || isSavingAs.value);
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
        return handleSaveAsWithReload(deps.optimizePdfOnSaveAs?.value === true);
    }

    function saveForExternalRead() {
        return handleSaveWithReload();
    }

    async function createRecoverySnapshotBytesUnlocked() {
        const viewer = pdfViewerRef.value;
        const capturedWorkingCopyPath = workingCopyPath.value;
        const capturedDocumentRevisionToken = documentRevisionToken.value;
        const ownsCapturedDocument = () => (
            workingCopyPath.value === capturedWorkingCopyPath
            && documentRevisionToken.value === capturedDocumentRevisionToken
        );
        if (!viewer || !capturedWorkingCopyPath || !hasPendingUnsavedChanges?.value) {
            return null;
        }
        if (!await persistAllAnnotationNotes()) {
            throw new Error('Open annotation notes could not be prepared for crash recovery.');
        }

        const shapeStateDirty = hasViewerShapeChanges(viewer);
        const result = await viewer.runSaveTransaction({
            mode: 'snapshot',
            saveMode: 'rewrite',
            saveFlowMode: 'save',
            forcePdfjsMaterialize: (hasPreservedAnnotationSourceChanges?.() ?? false)
                || (hasSavedPdfJsAnnotationBaselineChanges?.() ?? false),
            includeManagedShapes: shapeStateDirty,
            rewriteShapeState: shapeStateDirty,
            forceRewrite: pageLabelsDirty.value || bookmarksDirty.value || shapeStateDirty,
            serializeResult: true,
            dirtyState: {
                annotationDirty: annotationDirty.value,
                hasAnnotationChanges: hasAnnotationChanges(),
                hasLivePdfJsAnnotationChanges: hasLivePdfJsAnnotationChanges?.() ?? false,
                savedPdfjsAnnotationBaselineDirty: hasSavedPdfJsAnnotationBaselineChanges?.() ?? false,
                shapeStateDirty,
            },
            documentStructure: {
                pageLabelsDirty: pageLabelsDirty.value,
                pageLabelRanges: pageLabelRanges.value,
                bookmarksDirty: bookmarksDirty.value,
                bookmarkItems: bookmarkItems.value,
                untitledBookmarkLabel: t('bookmarks.untitled'),
                totalPages: totalPages.value > 0
                    ? totalPages.value
                    : (pdfDocument.value?.numPages ?? 0),
            },
            source: {
                getSourcePdfData,
                serializePdfForSave,
            },
        });
        const bytes = resolvePdfViewerSaveTransactionFinalBytes(result);
        if (!bytes || !ownsCapturedDocument()) {
            return null;
        }
        await result.assertAnnotationSaveCurrent?.();
        await result.verifyAnnotationSave?.(bytes);
        if (!ownsCapturedDocument()) {
            return null;
        }
        // This is intentionally a detached byte snapshot. Do not call the
        // transaction's commit callback: recovery must never acknowledge the
        // live dirty frontier or change the active working-copy source.
        return bytes.slice();
    }

    function createRecoverySnapshotBytes() {
        return runWithDocumentOperationLease
            ? runWithDocumentOperationLease('recovery-snapshot', createRecoverySnapshotBytesUnlocked)
            : createRecoverySnapshotBytesUnlocked();
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
        return resolvePdfViewerSaveTransactionFinalBytes(result);
    }

    return {
        getSourcePdfData,
        getEmbeddedMutationBaseData,
        serializePdfForSave,
        rewriteMarkupSubtypes,
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
        createRecoverySnapshotBytes,
        isAnySaving,
        canSave,
        hasSaveFailure,
    };
};
