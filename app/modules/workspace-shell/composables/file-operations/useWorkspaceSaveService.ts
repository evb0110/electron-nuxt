import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    PDFDocumentProxy,
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type {
    IPdfPersistResult,
    IPdfSaveResult,
} from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNoteTextUpdate,
    IPdfOptimizeOptions,
    IPdfSerializedCommitCallbacks,
} from '@contracts/electronApiDocuments';
import {
    getDocumentMutationErrorPayload,
    isStaleRevisionError,
} from '@contracts/documentMutationErrors';
import type {
    IPdfViewerSaveExpose,
    IPdfViewerSaveTransactionResult,
    INativePdfMutationProjection,
} from '@app/modules/pdf-viewer/public';
import { resetLivePdfJsAnnotationStorageModifiedState } from '@app/modules/pdf-viewer/public';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { toPdfDateString } from '@app/utils/pdfDate';
import { useAnalytics } from '@app/composables/useAnalytics';
import { isLargeSerializedSaveAllowedForAutomation } from '@app/utils/isLargeSerializedSaveAllowedForAutomation';
import {
    createWorkspaceSavePlan,
    type IWorkspaceSaveBaseline,
    type IWorkspaceSaveDirtyState,
    type IWorkspaceSerializedSaveBody,
    type TWorkspaceSavePlan,
    type TWorkspaceSaveRequest,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePlan';

const RENDERER_SERIALIZED_SAVE_MAX_WORKING_COPY_BYTES = 64 * 1024 * 1024;
const SLOW_SAVE_PHASE_WARN_MS = 5_000;
const SLOW_SAVE_TOTAL_WARN_MS = 10_000;
const MAX_STALE_REVISION_SAVE_RETRIES = 2;

interface IPostSaveReloadWaiter {
    promise: Promise<void>;
    cancel: () => void;
}

interface ISaveCompletionPolicy {
    allowAnnotationSaveStateRefresh?: boolean;
    allowBookmarksSaveStateRefresh?: boolean;
    allowPageLabelsSaveStateRefresh?: boolean;
    markShapeStateSaved: boolean;
    preserveLivePdfjsSession: boolean;
    resetAnnotationStorage: boolean;
}

type TWorkspaceSaveExecutionResult =
    | {
        status: 'saved';
        persisted: IPdfPersistResult;
        serializedChanges: boolean;
        reloadWaiter: IPostSaveReloadWaiter | null;
        completion: ISaveCompletionPolicy;
        annotationMaterializationBaseline?: unknown;
        commitAnnotationSave?: () => void;
    }
    | {
        status: 'not-saved';
        reloadWaiter: IPostSaveReloadWaiter | null;
    }
    | {
        status: 'failed';
        error: unknown;
        reloadWaiter: IPostSaveReloadWaiter | null;
    };

export interface IWorkspaceSaveDependencies {
    status: {
        isSaving: Ref<boolean>;
        isSavingAs: Ref<boolean>;
    };
    document: {
        workingCopyPath: Ref<TDocumentRef | null>;
        originalPath: Ref<TDocumentRef | null>;
        revisionToken: Ref<TDocumentRevisionToken | null>;
    };
    annotations: {
        dirty: Ref<boolean>;
        markSaved: (opts?: {preserveLivePdfjsSession?: boolean}) => void;
        getSaveStateToken?: () => unknown;
        hasChanges: () => boolean;
        hasLivePdfJsChanges?: () => boolean;
        hasSavedPdfJsBaselineChanges?: () => boolean;
        hasPreservedSourceChanges?: () => boolean;
        hasPendingDeletes?: () => boolean;
        openNoteCount: Ref<number>;
        persistOpenNotes: (force: boolean) => Promise<boolean>;
    };
    metadata: {
        totalPages: Ref<number>;
        pageLabelsDirty: Ref<boolean>;
        pageLabelRanges: Ref<IPdfPageLabelRange[]>;
        bookmarksDirty: Ref<boolean>;
        bookmarkItems: Ref<IPdfBookmarkEntry[]>;
        untitledBookmarkLabel: string;
        markPageLabelsSaved: () => void;
        getPageLabelsSaveStateToken?: () => unknown;
        markBookmarksSaved: () => void;
        getBookmarksSaveStateToken?: () => unknown;
    };
    pdf: {
        document: ShallowRef<PDFDocumentProxy | null>;
        runSaveTransaction: IPdfViewerSaveExpose['runSaveTransaction'];
        getSourceData: () => Promise<Uint8Array | null>;
        serializeForSave: (
            data: Uint8Array,
            options?: {
                forceRewrite?: boolean;
                includeShapes?: boolean;
                rewriteShapeState?: boolean;
            },
        ) => Promise<Uint8Array>;
    };
    shapes: {
        hasChanges: () => boolean;
        hasManagedShapes: () => boolean;
        markSaved?: () => void;
        preparePersistedState?: (data: Uint8Array) => Promise<unknown>;
        restorePreparedState?: (snapshot: unknown) => Promise<void> | void;
        adoptPersistedStateOnReload?: () => void;
        clearPendingPersistedState?: () => void;
    };
    persistence: {
        validatePdfPath: (path: TDocumentRef) => Promise<IPdfSaveResult['validation']>;
        saveSerialized: (
            data: Uint8Array,
            opts: {
                saveMode: TPdfSaveMode;
                preserveLoadedSource?: boolean;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
                changedObjectRefs?: string[];
                commitCallbacks?: IPdfSerializedCommitCallbacks;
            },
        ) => Promise<IPdfPersistResult>;
        saveWorkingCopy: (opts: {
            saveMode: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
        }) => Promise<IPdfPersistResult>;
        saveAs: (
            data: Uint8Array | undefined,
            opts: {
                saveMode: TPdfSaveMode;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
                optimizeLossless?: boolean;
                changedObjectRefs?: string[];
                commitCallbacks?: IPdfSerializedCommitCallbacks;
            },
        ) => Promise<IPdfPersistResult>;
        repairWorkingCopy?: (opts: {
            saveMode: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
        }) => Promise<IPdfPersistResult>;
        optimizeWorkingCopy?: (opts: {
            saveMode: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
        }) => Promise<IPdfPersistResult>;
        optimizeWorkingCopyAsCopy?: (
            options: IPdfOptimizeOptions,
            requestId: string | undefined,
            opts: {
                saveMode: TPdfSaveMode;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
            },
        ) => Promise<IPdfPersistResult>;
        trySavePdfNativeMutations?: (
            mutations: IPdfNativeMutationSet,
            opts: {
                saveMode: TPdfSaveMode;
                preserveLoadedSource?: boolean;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
                modifiedAt: string;
                verifyPathBeforeExpose?: (path: TDocumentRef, knownSize: number) => Promise<void>;
                assertBeforeExpose?: () => Promise<void> | void;
            },
        ) => Promise<IPdfPersistResult | null>;
        trySaveEmbeddedNoteTextUpdates?: (
            updates: IPdfNoteTextUpdate[],
            opts: {
                saveMode: TPdfSaveMode;
                preserveLoadedSource?: boolean;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
                modifiedAt: string;
                freeTextNotes?: IPdfNativeFreeTextNote[];
                deletes?: IPdfNativeAnnotationDelete[];
            },
        ) => Promise<IPdfPersistResult | null>;
        getWorkingCopySize?: (path: TDocumentRef) => Promise<number | null>;
    };
    lifecycle: {
        loadRecentFiles: () => void;
        preparePostSaveReload?: () => IPostSaveReloadWaiter;
    };
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

function nowMs() {
    return typeof performance !== 'undefined'
        ? performance.now()
        : Date.now();
}

function getSaveMode(plan: TWorkspaceSavePlan): TPdfSaveMode {
    return plan.request.kind === 'save-as' || plan.request.kind === 'optimize-copy'
        ? 'save_as_rewrite'
        : 'rewrite';
}

function getSaveFlow(plan: TWorkspaceSavePlan): 'save' | 'save_as' {
    return plan.request.kind === 'save-as' || plan.request.kind === 'optimize-copy'
        ? 'save_as'
        : 'save';
}

async function timedSavePhase<T>(
    phase: string,
    operation: () => Promise<T>,
    describeResult?: (result: T) => Record<string, unknown>,
) {
    const startedAtMs = nowMs();
    try {
        const result = await operation();
        const durationMs = Math.round(nowMs() - startedAtMs);
        const data = {
            ...describeResult?.(result),
            phase,
            durationMs,
        };
        if (durationMs >= SLOW_SAVE_PHASE_WARN_MS) {
            BrowserLogger.warn('workspace', 'Slow PDF save phase', data);
        } else {
            BrowserLogger.debug('workspace', 'Completed PDF save phase', data);
        }
        return result;
    } catch (error) {
        BrowserLogger.warn('workspace', 'PDF save phase failed', {
            error,
            phase,
            durationMs: Math.round(nowMs() - startedAtMs),
        });
        throw error;
    }
}

function isTargetCurrent(plan: TWorkspaceSavePlan, deps: IWorkspaceSaveDependencies) {
    return deps.document.originalPath.value === plan.target.expectedOriginalPath
        && deps.document.workingCopyPath.value === plan.target.expectedWorkingPath;
}

function createReloadWaiter(
    body: IWorkspaceSerializedSaveBody,
    deps: IWorkspaceSaveDependencies,
) {
    return body.preserveLoadedSource
        ? null
        : deps.lifecycle.preparePostSaveReload?.() ?? null;
}

async function validateWorkingCopy(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveDependencies,
) {
    const expectedWorkingPath = plan.target.expectedWorkingPath;
    if (!expectedWorkingPath || deps.document.workingCopyPath.value !== expectedWorkingPath) {
        return false;
    }
    const validation = await timedSavePhase(
        'validate-pdf-path',
        () => deps.persistence.validatePdfPath(expectedWorkingPath),
        result => ({
            isValid: result.isValid,
            warningCount: result.warnings.length,
            errorCount: result.errors.length,
        }),
    );
    if (!validation.isValid) {
        BrowserLogger.warn('workspace', 'Save aborted because PDF validation failed', {
            errors: validation.errors,
            warnings: validation.warnings,
        });
        return false;
    }
    return isTargetCurrent(plan, deps);
}

function armPersistedShapeState(plan: TWorkspaceSavePlan, deps: IWorkspaceSaveDependencies) {
    if (plan.baseline.shapes) {
        deps.shapes.adoptPersistedStateOnReload?.();
    }
}

async function restorePreparedShapeState(
    snapshot: unknown,
    deps: IWorkspaceSaveDependencies,
) {
    if (snapshot) {
        await deps.shapes.restorePreparedState?.(snapshot);
    }
}

async function executeWorkingCopySave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'serialized'}>,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const reloadWaiter = createReloadWaiter(plan.body, deps);
    try {
        if (!await validateWorkingCopy(plan, deps)) {
            return {
                status: 'not-saved',
                reloadWaiter,
            };
        }
        armPersistedShapeState(plan, deps);
        const opts = {
            saveMode: getSaveMode(plan),
            expectedWorkingPath: plan.target.expectedWorkingPath,
            expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
        };
        const persisted = plan.destination === 'save-as'
            ? await timedSavePhase(
                'persist-save_as-working-copy',
                () => deps.persistence.saveAs(undefined, {
                    ...opts,
                    optimizeLossless: plan.request.kind === 'save-as'
                        && plan.request.optimizeLossless,
                }),
            )
            : await timedSavePhase(
                'persist-save-working-copy',
                () => deps.persistence.saveWorkingCopy(opts),
            );
        if (!persisted.success) {
            return {
                status: 'not-saved',
                reloadWaiter,
            };
        }
        return {
            status: 'saved',
            persisted,
            serializedChanges: false,
            reloadWaiter,
            completion: {
                markShapeStateSaved: true,
                preserveLivePdfjsSession: false,
                resetAnnotationStorage: false,
            },
        };
    } catch (error) {
        reloadWaiter?.cancel();
        throw error;
    }
}

async function executeNativeWorkingCopySave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'native-working-copy'}>,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const reloadWaiter = deps.lifecycle.preparePostSaveReload?.() ?? null;
    try {
        if (
            !plan.target.expectedWorkingPath
            || !isTargetCurrent(plan, deps)
        ) {
            return {
                status: 'not-saved',
                reloadWaiter,
            };
        }
        const persist = plan.operation === 'repair'
            ? deps.persistence.repairWorkingCopy
            : deps.persistence.optimizeWorkingCopy;
        if (!persist) {
            return {
                status: 'not-saved',
                reloadWaiter,
            };
        }
        const persisted = await timedSavePhase(
            `persist-save-native-working-copy-${plan.operation}`,
            () => persist({
                saveMode: getSaveMode(plan),
                expectedWorkingPath: plan.target.expectedWorkingPath,
                expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
            }),
        );
        if (!persisted.success) {
            return {
                status: 'not-saved',
                reloadWaiter,
            };
        }
        return {
            status: 'saved',
            persisted,
            serializedChanges: false,
            reloadWaiter,
            completion: {
                markShapeStateSaved: true,
                preserveLivePdfjsSession: false,
                resetAnnotationStorage: false,
            },
        };
    } catch (error) {
        reloadWaiter?.cancel();
        throw error;
    }
}

function buildSaveTransactionRequest(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveDependencies,
    body: IWorkspaceSerializedSaveBody,
    options: {
        allowNativeMutationPlan: boolean;
        planOnly?: boolean;
    },
) {
    return {
        mode: 'persist' as const,
        saveMode: getSaveMode(plan),
        saveFlowMode: getSaveFlow(plan),
        forcePdfjsMaterialize: plan.dirtyState.preservedAnnotationSource
            || plan.dirtyState.savedPdfjsAnnotationBaseline,
        includeManagedShapes: body.includeManagedShapes,
        rewriteShapeState: plan.baseline.shapes,
        forceRewrite: body.forceRewrite,
        ...(options.planOnly !== undefined ? {planOnly: options.planOnly} : {}),
        dirtyState: {
            annotationDirty: plan.dirtyState.annotationDirty,
            hasAnnotationChanges: plan.dirtyState.annotationChanges,
            hasLivePdfJsAnnotationChanges: plan.dirtyState.livePdfJsAnnotations,
            savedPdfjsAnnotationBaselineDirty: plan.dirtyState.savedPdfjsAnnotationBaseline,
            shapeStateDirty: plan.dirtyState.shapes,
        },
        nativeCapabilities: {
            hasNativePdfMutationCapability: options.allowNativeMutationPlan
                && Boolean(
                    deps.persistence.trySavePdfNativeMutations
                    ?? deps.persistence.trySaveEmbeddedNoteTextUpdates,
                ),
            canPersistNativeMetadataMutations: options.allowNativeMutationPlan
                && Boolean(deps.persistence.trySavePdfNativeMutations),
        },
        documentStructure: {
            pageLabelsDirty: plan.dirtyState.pageLabels,
            pageLabelRanges: deps.metadata.pageLabelRanges.value,
            bookmarksDirty: plan.dirtyState.bookmarks,
            bookmarkItems: deps.metadata.bookmarkItems.value,
            untitledBookmarkLabel: deps.metadata.untitledBookmarkLabel,
            totalPages: deps.metadata.totalPages.value > 0
                ? deps.metadata.totalPages.value
                : deps.pdf.document.value?.numPages ?? 0,
        },
        source: {
            getSourcePdfData: deps.pdf.getSourceData,
            serializePdfForSave: deps.pdf.serializeForSave,
        },
        serializeResult: options.planOnly !== true,
    };
}

function formatStorageSize(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return `${bytes} bytes`;
    }
    const mib = bytes / (1024 * 1024);
    if (mib < 1024) {
        return `${Math.round(mib * 10) / 10} MiB`;
    }
    return `${Math.round((mib / 1024) * 10) / 10} GiB`;
}

async function assertRendererSerializedSaveAllowed(
    plan: TWorkspaceSavePlan,
    body: IWorkspaceSerializedSaveBody,
    deps: IWorkspaceSaveDependencies,
) {
    const expectedWorkingPath = plan.target.expectedWorkingPath;
    const getWorkingCopySize = deps.persistence.getWorkingCopySize;
    if (!body.requiresLargeFileGuard || !getWorkingCopySize || !expectedWorkingPath) {
        return;
    }
    const workingCopySize = await timedSavePhase(
        'stat-working-copy-for-serialization',
        () => getWorkingCopySize(expectedWorkingPath),
    );
    if (
        typeof workingCopySize !== 'number'
        || workingCopySize <= RENDERER_SERIALIZED_SAVE_MAX_WORKING_COPY_BYTES
        || isLargeSerializedSaveAllowedForAutomation()
    ) {
        return;
    }
    throw new Error(
        'Large PDF save requires a native save path; renderer full-PDF serialization is disabled for files '
        + `above ${formatStorageSize(RENDERER_SERIALIZED_SAVE_MAX_WORKING_COPY_BYTES)} `
        + `(working copy is ${formatStorageSize(workingCopySize)}).`,
    );
}

async function executeSerializedBytesSave(
    plan: TWorkspaceSavePlan,
    body: IWorkspaceSerializedSaveBody,
    deps: IWorkspaceSaveDependencies,
    reloadWaiter: IPostSaveReloadWaiter | null,
    frozenTransaction?: IPdfViewerSaveTransactionResult,
): Promise<TWorkspaceSaveExecutionResult> {
    await assertRendererSerializedSaveAllowed(plan, body, deps);
    const saveTransaction = frozenTransaction ?? await deps.pdf.runSaveTransaction(
        buildSaveTransactionRequest(plan, deps, body, {allowNativeMutationPlan: false}),
    );
    const finalBytes = saveTransaction.serializedResult?.finalBytes
        ?? saveTransaction.serializedBytes
        ?? saveTransaction.baseBytes;
    if (!finalBytes || !isTargetCurrent(plan, deps)) {
        return {
            status: 'not-saved',
            reloadWaiter,
        };
    }

    let preparedShapeStateSnapshot: unknown = null;
    try {
        if (plan.baseline.shapes) {
            preparedShapeStateSnapshot = await deps.shapes.preparePersistedState?.(finalBytes) ?? null;
        }
        armPersistedShapeState(plan, deps);

        const changedObjectRefs = saveTransaction.serializedResult?.changedObjectRefs;
        const commitCallbacks: IPdfSerializedCommitCallbacks = {
            ...(saveTransaction.verifyAnnotationSave
                ? {verifyBytesBeforeCommit: saveTransaction.verifyAnnotationSave}
                : {}),
            ...(saveTransaction.verifyAnnotationSavePath
                ? {verifyPathBeforeCommit: saveTransaction.verifyAnnotationSavePath}
                : {}),
            ...(saveTransaction.assertAnnotationSaveCurrent
                ? {assertBeforeCommit: saveTransaction.assertAnnotationSaveCurrent}
                : {}),
        };
        const persistOptions = {
            saveMode: saveTransaction.serializedResult?.saveMode ?? getSaveMode(plan),
            preserveLoadedSource: body.preserveLoadedSource,
            expectedWorkingPath: plan.target.expectedWorkingPath,
            expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
            ...(changedObjectRefs?.length
                ? {changedObjectRefs: [...changedObjectRefs]}
                : {}),
            ...(Object.keys(commitCallbacks).length
                ? {commitCallbacks}
                : {}),
        };
        const annotationMaterializationBaseline = body.preserveLoadedSource && !reloadWaiter
            ? deps.annotations.getSaveStateToken?.()
            : undefined;
        const persisted = plan.request.kind === 'save-as'
            ? await timedSavePhase(
                'persist-save_as',
                () => deps.persistence.saveAs(finalBytes, {
                    ...persistOptions,
                    optimizeLossless: plan.request.kind === 'save-as'
                        && plan.request.optimizeLossless,
                }),
            )
            : await timedSavePhase(
                'persist-save',
                () => deps.persistence.saveSerialized(finalBytes, persistOptions),
            );
        if (!persisted.success) {
            return {
                status: 'not-saved',
                reloadWaiter,
            };
        }
        preparedShapeStateSnapshot = null;
        return {
            status: 'saved',
            persisted,
            serializedChanges: true,
            reloadWaiter,
            completion: {
                markShapeStateSaved: true,
                preserveLivePdfjsSession: body.preserveLoadedSource && !reloadWaiter,
                resetAnnotationStorage: true,
            },
            ...(annotationMaterializationBaseline === undefined
                ? {}
                : {annotationMaterializationBaseline}),
            ...(saveTransaction.commitAnnotationSave
                ? {commitAnnotationSave: saveTransaction.commitAnnotationSave}
                : {}),
        };
    } finally {
        await restorePreparedShapeState(preparedShapeStateSnapshot, deps);
    }
}

async function persistNativeMutationProjection(
    plan: Extract<TWorkspaceSavePlan, {kind: 'native-mutation'}>,
    projection: INativePdfMutationProjection,
    deps: IWorkspaceSaveDependencies,
    verifyPathBeforeExpose?: (path: TDocumentRef, knownSize: number) => Promise<void>,
    assertBeforeExpose?: () => Promise<void> | void,
) {
    if (!isTargetCurrent(plan, deps) || !plan.target.expectedWorkingPath) {
        return null;
    }
    const opts = {
        saveMode: getSaveMode(plan),
        preserveLoadedSource: true,
        expectedWorkingPath: plan.target.expectedWorkingPath,
        expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
        modifiedAt: toPdfDateString(new Date()),
        ...(verifyPathBeforeExpose ? {verifyPathBeforeExpose} : {}),
        ...(assertBeforeExpose ? {assertBeforeExpose} : {}),
    };
    if (deps.persistence.trySavePdfNativeMutations) {
        return timedSavePhase(
            projection.phase,
            () => deps.persistence.trySavePdfNativeMutations!(projection.mutations, opts),
        );
    }
    if (
        projection.hasMetadataMutations
        || projection.hasShapeMutations
        || !deps.persistence.trySaveEmbeddedNoteTextUpdates
    ) {
        return null;
    }
    return timedSavePhase(
        projection.phase,
        () => deps.persistence.trySaveEmbeddedNoteTextUpdates!(
            projection.noteTextUpdates,
            {
                ...opts,
                ...(projection.freeTextNotes.length
                    ? {freeTextNotes: projection.freeTextNotes}
                    : {}),
                ...(projection.annotationDeletes.length
                    ? {deletes: projection.annotationDeletes}
                    : {}),
            },
        ),
    );
}

async function executeNativeMutationSave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'native-mutation'}>,
    deps: IWorkspaceSaveDependencies,
    getReloadWaiter: () => IPostSaveReloadWaiter | null,
): Promise<TWorkspaceSaveExecutionResult> {
    const saveTransaction = await deps.pdf.runSaveTransaction(
        buildSaveTransactionRequest(
            plan,
            deps,
            plan.serializedFallback,
            {
                allowNativeMutationPlan: true,
                planOnly: true,
            },
        ),
    );
    const projection = saveTransaction.nativeMutationProjection;
    if (!projection) {
        const fallbackTransaction = await saveTransaction.executeFallback?.();
        if (!fallbackTransaction) {
            throw new Error('Classifier-owned PDF save fallback is unavailable');
        }
        return executeSerializedBytesSave(
            plan,
            plan.serializedFallback,
            deps,
            getReloadWaiter(),
            fallbackTransaction,
        );
    }

    const persisted = await persistNativeMutationProjection(
        plan,
        projection,
        deps,
        saveTransaction.verifyAnnotationSavePath,
        saveTransaction.assertAnnotationSaveCurrent,
    );
    if (!persisted) {
        const fallbackTransaction = await saveTransaction.executeFallback?.();
        if (!fallbackTransaction) {
            throw new Error('Classifier-owned PDF save fallback is unavailable');
        }
        return executeSerializedBytesSave(
            plan,
            plan.serializedFallback,
            deps,
            getReloadWaiter(),
            fallbackTransaction,
        );
    }
    if (!persisted.success) {
        return {
            status: 'not-saved',
            reloadWaiter: null,
        };
    }

    let preparedShapeStateSnapshot: unknown = null;
    let canMarkShapeStateSaved = !projection.hasShapeMutations;
    if (projection.hasShapeMutations) {
        const savedBytes = await timedSavePhase(
            'read-native-shape-saved-bytes',
            deps.pdf.getSourceData,
        );
        if (savedBytes) {
            preparedShapeStateSnapshot = await deps.shapes.preparePersistedState?.(savedBytes) ?? null;
            canMarkShapeStateSaved = Boolean(preparedShapeStateSnapshot);
        }
    }
    if (projection.hasShapeMutations && canMarkShapeStateSaved) {
        deps.shapes.adoptPersistedStateOnReload?.();
    }
    saveTransaction.commitAnnotationSave?.();
    preparedShapeStateSnapshot = null;

    return {
        status: 'saved',
        persisted,
        serializedChanges: true,
        reloadWaiter: null,
        completion: {
            allowAnnotationSaveStateRefresh: projection.noteTextUpdates.length > 0
                || projection.freeTextNotes.length > 0
                || projection.annotationDeletes.length > 0
                || projection.hasMarkupMutations
                || projection.hasShapeMutations,
            allowBookmarksSaveStateRefresh: projection.mutations.bookmarks !== undefined,
            allowPageLabelsSaveStateRefresh: projection.mutations.pageLabels !== undefined,
            markShapeStateSaved: canMarkShapeStateSaved,
            preserveLivePdfjsSession: true,
            resetAnnotationStorage: true,
        },
    };
}

async function executeOptimizationSave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'optimization'}>,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const reloadWaiter = deps.lifecycle.preparePostSaveReload?.() ?? null;
    try {
        if (!await validateWorkingCopy(plan, deps)) {
            return {
                status: 'not-saved',
                reloadWaiter,
            };
        }
        const persist = deps.persistence.optimizeWorkingCopyAsCopy;
        if (!persist) {
            return {
                status: 'not-saved',
                reloadWaiter,
            };
        }
        const persisted = await timedSavePhase(
            'persist-optimize-copy-native-working-copy',
            () => persist(
                plan.request.options,
                plan.request.requestId,
                {
                    saveMode: getSaveMode(plan),
                    expectedWorkingPath: plan.target.expectedWorkingPath,
                    expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
                },
            ),
        );
        if (!persisted.success) {
            return {
                status: 'not-saved',
                reloadWaiter,
            };
        }
        return {
            status: 'saved',
            persisted,
            serializedChanges: false,
            reloadWaiter,
            completion: {
                markShapeStateSaved: true,
                preserveLivePdfjsSession: false,
                resetAnnotationStorage: false,
            },
        };
    } catch (error) {
        reloadWaiter?.cancel();
        throw error;
    }
}

async function executeSavePlan(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const reloadState: {current: IPostSaveReloadWaiter | null} = {current: null};
    const getReloadWaiter = () => {
        reloadState.current ??= createReloadWaiter(
            plan.kind === 'native-mutation'
                ? plan.serializedFallback
                : plan.kind === 'serialized'
                    ? plan.body
                    : {
                        source: 'working-copy',
                        forceRewrite: false,
                        includeManagedShapes: false,
                        preserveLoadedSource: false,
                        requiresLargeFileGuard: false,
                    },
            deps,
        );
        return reloadState.current;
    };
    try {
        if (plan.kind === 'optimization') {
            return await executeOptimizationSave(plan, deps);
        }
        if (plan.kind === 'native-working-copy') {
            return await executeNativeWorkingCopySave(plan, deps);
        }
        if (plan.kind === 'native-mutation') {
            return await executeNativeMutationSave(plan, deps, getReloadWaiter);
        }
        if (plan.body.source === 'working-copy') {
            return await executeWorkingCopySave(plan, deps);
        }
        return await executeSerializedBytesSave(plan, plan.body, deps, getReloadWaiter());
    } catch (error) {
        reloadState.current?.cancel();
        throw error;
    }
}

function getCompletionBaseline(
    plan: TWorkspaceSavePlan,
    result: Extract<TWorkspaceSaveExecutionResult, {status: 'saved'}>,
    deps: IWorkspaceSaveDependencies,
) {
    if (result.annotationMaterializationBaseline === undefined) {
        result.commitAnnotationSave?.();
        return plan.baseline;
    }

    const saveFrontierIsStillCurrent = !deps.annotations.getSaveStateToken
        || Object.is(
            deps.annotations.getSaveStateToken(),
            result.annotationMaterializationBaseline,
        );
    result.commitAnnotationSave?.();
    return {
        ...plan.baseline,
        annotations: saveFrontierIsStillCurrent
            ? deps.annotations.getSaveStateToken?.()
            : result.annotationMaterializationBaseline,
    };
}

function completeSuccessfulSaveState(
    baseline: IWorkspaceSaveBaseline,
    policy: ISaveCompletionPolicy,
    deps: IWorkspaceSaveDependencies,
) {
    const annotationUnchanged = !deps.annotations.getSaveStateToken
        || Object.is(deps.annotations.getSaveStateToken(), baseline.annotations);
    if (annotationUnchanged || policy.allowAnnotationSaveStateRefresh === true) {
        if (policy.resetAnnotationStorage) {
            resetLivePdfJsAnnotationStorageModifiedState(deps.pdf.document.value);
        }
        deps.annotations.markSaved({preserveLivePdfjsSession: policy.preserveLivePdfjsSession});
    }

    const pageLabelsUnchanged = !deps.metadata.getPageLabelsSaveStateToken
        || Object.is(deps.metadata.getPageLabelsSaveStateToken(), baseline.pageLabels);
    if (pageLabelsUnchanged || policy.allowPageLabelsSaveStateRefresh === true) {
        deps.metadata.markPageLabelsSaved();
    }

    const bookmarksUnchanged = !deps.metadata.getBookmarksSaveStateToken
        || Object.is(deps.metadata.getBookmarksSaveStateToken(), baseline.bookmarks);
    if (bookmarksUnchanged || policy.allowBookmarksSaveStateRefresh === true) {
        deps.metadata.markBookmarksSaved();
    }

    if (policy.markShapeStateSaved) {
        deps.shapes.markSaved?.();
        if (!policy.preserveLivePdfjsSession) {
            deps.shapes.clearPendingPersistedState?.();
        }
    }
}

async function completeWorkspaceSave(
    plan: TWorkspaceSavePlan | null,
    result: TWorkspaceSaveExecutionResult,
    deps: IWorkspaceSaveDependencies,
) {
    if (!plan || result.status !== 'saved') {
        result.reloadWaiter?.cancel();
        deps.shapes.clearPendingPersistedState?.();
        return false;
    }

    const baseline = getCompletionBaseline(plan, result, deps);
    if (!result.reloadWaiter) {
        completeSuccessfulSaveState(baseline, result.completion, deps);
    } else {
        await result.reloadWaiter.promise.catch((error) => {
            BrowserLogger.warn('workspace', 'Saved PDF but failed to restore the reloaded view', error);
        }).finally(() => {
            completeSuccessfulSaveState(baseline, result.completion, deps);
        });
    }
    if (result.persisted.outPath) {
        deps.lifecycle.loadRecentFiles();
    }
    return true;
}

function collectDirtyState(deps: IWorkspaceSaveDependencies): IWorkspaceSaveDirtyState {
    return {
        annotationDirty: deps.annotations.dirty.value,
        annotationChanges: deps.annotations.hasChanges(),
        bookmarks: deps.metadata.bookmarksDirty.value,
        livePdfJsAnnotations: deps.annotations.hasLivePdfJsChanges?.() ?? false,
        pageLabels: deps.metadata.pageLabelsDirty.value,
        pendingDeletes: deps.annotations.hasPendingDeletes?.() ?? false,
        preservedAnnotationSource: deps.annotations.hasPreservedSourceChanges?.() ?? false,
        savedPdfjsAnnotationBaseline: deps.annotations.hasSavedPdfJsBaselineChanges?.() ?? false,
        shapes: deps.shapes.hasChanges(),
    };
}

function captureBaseline(deps: IWorkspaceSaveDependencies): IWorkspaceSaveBaseline {
    return {
        annotations: deps.annotations.getSaveStateToken?.(),
        pageLabels: deps.metadata.getPageLabelsSaveStateToken?.(),
        bookmarks: deps.metadata.getBookmarksSaveStateToken?.(),
        shapes: deps.shapes.hasChanges(),
    };
}

function resolveOperationKind(request: TWorkspaceSaveRequest): TDocumentOperationKind {
    if (request.kind === 'save-as') {
        return 'save-as';
    }
    if (request.kind === 'repair') {
        return 'repair-save';
    }
    if (request.kind === 'optimize' || request.kind === 'optimize-copy') {
        return 'optimize-pdf';
    }
    return 'save';
}

function isSaveAsRequest(request: TWorkspaceSaveRequest) {
    return request.kind === 'save-as' || request.kind === 'optimize-copy';
}

export const useWorkspaceSaveService = (deps: IWorkspaceSaveDependencies) => {
    const analytics = useAnalytics();
    const {t} = useTypedI18n();
    const toast = useToast();
    const runWithDocumentOperationLease = deps.runWithDocumentOperationLease
        ?? runWithoutDocumentOperationLease;
    let saveOperationInProgress = false;

    function hasSaveOperationInProgress() {
        return saveOperationInProgress
            || deps.status.isSaving.value
            || deps.status.isSavingAs.value;
    }

    async function save(request: TWorkspaceSaveRequest) {
        if (hasSaveOperationInProgress()) {
            return false;
        }
        const startedAtMs = nowMs();
        const saveAs = isSaveAsRequest(request);
        const indicator = saveAs
            ? deps.status.isSavingAs
            : deps.status.isSaving;
        const expectedOriginalPath = deps.document.originalPath.value;
        const expectedWorkingPath = deps.document.workingCopyPath.value;
        let saveSucceeded = false;
        saveOperationInProgress = true;
        indicator.value = true;

        return runWithDocumentOperationLease(resolveOperationKind(request), async () => {
            let lastPlan: TWorkspaceSavePlan | null = null;
            try {
                for (let attempt = 0; attempt <= MAX_STALE_REVISION_SAVE_RETRIES; attempt += 1) {
                    if (
                        deps.annotations.openNoteCount.value > 0
                        && !await deps.annotations.persistOpenNotes(true)
                    ) {
                        BrowserLogger.warn('workspace', 'Save aborted because annotation note persistence failed');
                        return await completeWorkspaceSave(
                            null,
                            {
                                status: 'not-saved',
                                reloadWaiter: null,
                            },
                            deps,
                        );
                    }

                    const baseline = captureBaseline(deps);
                    lastPlan = createWorkspaceSavePlan({
                        request,
                        target: {
                            expectedOriginalPath,
                            expectedWorkingPath,
                            expectedRevisionToken: deps.document.revisionToken.value,
                        },
                        baseline,
                        dirtyState: collectDirtyState(deps),
                        hasManagedShapes: deps.shapes.hasManagedShapes(),
                        canPersistNativeWorkingCopy: request.kind === 'repair'
                            ? Boolean(deps.persistence.repairWorkingCopy)
                            : request.kind === 'optimize'
                                ? Boolean(deps.persistence.optimizeWorkingCopy)
                                : false,
                        canPersistNativeMutations: Boolean(
                            deps.persistence.trySavePdfNativeMutations
                            ?? deps.persistence.trySaveEmbeddedNoteTextUpdates,
                        ),
                    });

                    try {
                        const result = await executeSavePlan(lastPlan, deps);
                        indicator.value = false;
                        saveSucceeded = await completeWorkspaceSave(lastPlan, result, deps);
                        if (saveSucceeded && result.status === 'saved') {
                            analytics.track('save_completed', {
                                didSaveAs: result.persisted.didSaveAs,
                                mode: getSaveFlow(lastPlan),
                                saveMode: result.persisted.saveMode,
                                serializedChanges: result.serializedChanges,
                            });
                        }
                        return saveSucceeded;
                    } catch (error) {
                        if (
                            isStaleRevisionError(error)
                            && attempt < MAX_STALE_REVISION_SAVE_RETRIES
                        ) {
                            BrowserLogger.debug(
                                'workspace',
                                'Retrying save after stale document revision',
                                {
                                    attempt: attempt + 1,
                                    maxRetries: MAX_STALE_REVISION_SAVE_RETRIES,
                                },
                            );
                            continue;
                        }
                        await completeWorkspaceSave(
                            lastPlan,
                            {
                                status: 'failed',
                                error,
                                reloadWaiter: null,
                            },
                            deps,
                        );
                        BrowserLogger.error('workspace', 'Save failed', error);
                        toast.add({
                            color: 'error',
                            title: t('errors.file.save'),
                            description: getDocumentMutationErrorPayload(error)?.message
                                ?? getErrorMessage(error),
                        });
                        return false;
                    }
                }
                return false;
            } finally {
                const durationMs = Math.round(nowMs() - startedAtMs);
                const log = durationMs >= SLOW_SAVE_TOTAL_WARN_MS
                    ? BrowserLogger.warn
                    : BrowserLogger.debug;
                log('workspace', 'Completed PDF save request', {
                    durationMs,
                    request: request.kind,
                    success: saveSucceeded,
                });
                saveOperationInProgress = false;
                indicator.value = false;
            }
        });
    }

    return {
        save,
        handleSave: () => save({kind: 'save'}),
        handleSaveAs: (optimizeLossless = false) => save({
            kind: 'save-as',
            optimizeLossless,
        }),
        handleRepairSave: () => save({kind: 'repair'}),
        handleOptimizePdfForInteraction: () => save({kind: 'optimize'}),
        handleOptimizePdfAsCopy: (
            options: IPdfOptimizeOptions,
            requestId?: string,
        ) => save({
            kind: 'optimize-copy',
            options,
            ...(requestId === undefined ? {} : {requestId}),
        }),
    };
};
