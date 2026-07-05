import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type { IPdfPersistResult } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfOptimizeOptions } from '@contracts/electronApiDocuments';
import {
    getDocumentMutationErrorPayload,
    isStaleRevisionError,
} from '@contracts/documentMutationErrors';
import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useAnalytics } from '@app/composables/useAnalytics';
import { getErrorMessage } from '@app/utils/error';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';
import type { IFileOperationsSaveAdapterPorts } from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';
import { createFileOperationsSaveCompletion } from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveCompletion';
import {
    createFileOperationsSaveContext,
    type IFileOperationsSaveContext,
} from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveContext';
import {
    createFileOperationsSaveExecutor,
    type IPersistSerializedOptions,
} from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveExecutor';

const SLOW_SAVE_PHASE_WARN_MS = 5_000;
const SLOW_SAVE_TOTAL_WARN_MS = 10_000;
const MAX_STALE_REVISION_SAVE_RETRIES = 2;

type TSaveFlowMode = 'save' | 'save_as';

interface ISaveFlowConfig {
    mode: TSaveFlowMode;
    operationKind: TDocumentOperationKind;
    saveMode: TPdfSaveMode;
    persistOpenNotesAbortMessage: string;
    totalPhase: 'handle-save-total' | 'handle-save-as-total' | 'handle-optimize-pdf-total';
    failureLogMessage: 'Save failed' | 'Save As failed' | 'Repair save failed' | 'PDF optimization failed';
    saveIndicator: Ref<boolean>;
    persistSerialized: (
        data: Uint8Array,
        opts: IPersistSerializedOptions,
    ) => Promise<IPdfPersistResult>;
    persistUnserialized: (opts: {
        saveMode: TPdfSaveMode;
        expectedWorkingPath?: TDocumentRef | null;
        expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    }) => Promise<IPdfPersistResult>;
    persistNativeWorkingCopy?: (opts: {
        saveMode: TPdfSaveMode;
        expectedWorkingPath?: TDocumentRef | null;
        expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    }) => Promise<IPdfPersistResult>;
    shouldPreferWorkingCopy: boolean;
    forceSerialize?: boolean;
    forceRewrite?: boolean;
}

export const useFileOperationsSaveController = (ports: IFileOperationsSaveAdapterPorts) => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const toast = useToast();
    const state = ports.state;
    const pdf = ports.pdf;
    const persistence = ports.persistence;
    const annotationEdits = ports.annotationEdits;
    const viewer = ports.viewer;
    const lifecycle = ports.lifecycle;
    const status = state.status;
    const documentIdentity = state.documentIdentity;
    const annotations = state.annotations;
    const metadata = state.metadata;
    const metadataCompletion = state.metadataCompletion;
    const pdfSource = pdf.source;
    const serialization = pdf.serialization;
    const file = persistence.file;
    const nativeWorkingCopy = persistence.nativeWorkingCopy;
    const nativeMutations = persistence.nativeMutations;
    const markup = viewer.markup;
    const shapes = viewer.shapes;
    const shapeState = viewer.shapeState;
    const runWithDocumentOperationLease = ports.operationLease?.runWithDocumentOperationLease
        ?? runWithoutDocumentOperationLease;

    let saveOperationInProgress = false;

    function nowMs() {
        return typeof performance !== 'undefined'
            ? performance.now()
            : Date.now();
    }

    function getSaveDebugContext() {
        return {
            hasWorkingCopyPath: Boolean(documentIdentity.workingCopyPath.value),
            documentPages: pdfSource.pdfDocument.value?.numPages ?? null,
            annotationDirty: annotations.annotationDirty.value,
            pageLabelsDirty: metadata.pageLabelsDirty.value,
            bookmarksDirty: metadata.bookmarksDirty.value,
            hasAnnotationChanges: annotations.hasAnnotationChanges(),
            hasShapeChanges: shapes.hasShapeChanges?.() ?? false,
            annotationNoteWindowsCount: annotationEdits.annotationNoteWindowsCount.value,
        };
    }

    function logSavePhase(
        phase: string,
        startedAtMs: number,
        data?: Record<string, unknown>,
        slowThresholdMs = SLOW_SAVE_PHASE_WARN_MS,
    ) {
        const durationMs = Math.round(nowMs() - startedAtMs);
        const payload = () => ({
            ...getSaveDebugContext(),
            ...data,
            phase,
            durationMs,
        });
        if (durationMs >= slowThresholdMs) {
            BrowserLogger.warn('workspace', 'Slow PDF save phase', payload);
            return;
        }

        BrowserLogger.debug('workspace', 'Completed PDF save phase', payload);
    }

    async function timedSavePhase<T>(
        phase: string,
        operation: () => Promise<T>,
        describeResult?: (result: T) => Record<string, unknown>,
    ) {
        const startedAtMs = nowMs();
        try {
            const result = await operation();
            logSavePhase(phase, startedAtMs, describeResult?.(result));
            return result;
        } catch (error) {
            logSavePhase(phase, startedAtMs, {
                failed: true,
                error,
            });
            throw error;
        }
    }

    const {
        armPersistedShapeStateAdoption,
        captureSaveStateSnapshot,
        finalizeSaveReload,
        finalizeSuccessfulSave,
        primePersistedShapeStateForSave,
        refreshAnnotationSaveStateSnapshot,
        restorePreparedShapeState,
    } = createFileOperationsSaveCompletion({
        state: {
            annotations,
            metadata,
            metadataCompletion,
        },
        pdf: {source: pdfSource},
        viewer: {
            shapes,
            shapeState,
        },
        lifecycle,
    });

    const { prepareSaveContext } = createFileOperationsSaveContext({
        state: {
            documentIdentity,
            annotations,
            metadata,
        },
        pdf: {source: pdfSource},
        annotationEdits,
        viewer: {
            markup,
            shapes,
        },
        lifecycle,
    }, {
        captureSaveStateSnapshot,
        timedSavePhase,
    });

    function trackSaveCompleted(
        mode: 'save' | 'save_as',
        persisted: IPdfPersistResult,
        serializedChanges: boolean,
    ) {
        analytics.track('save_completed', {
            didSaveAs: persisted.didSaveAs,
            mode,
            saveMode: persisted.saveMode,
            serializedChanges,
        });
    }

    const saveExecutor = createFileOperationsSaveExecutor({
        state: {
            documentIdentity,
            metadata,
        },
        pdf: {
            source: pdfSource,
            serialization,
        },
        persistence: {
            file,
            ...(nativeWorkingCopy ? { nativeWorkingCopy } : {}),
            ...(nativeMutations ? { nativeMutations } : {}),
        },
        viewer: {
            markup,
            shapes,
        },
    }, {
        clearSaveIndicator,
        completion: {
            armPersistedShapeStateAdoption,
            finalizeSaveReload,
            finalizeSuccessfulSave,
            primePersistedShapeStateForSave,
            refreshAnnotationSaveStateSnapshot,
            restorePreparedShapeState,
        },
        timedSavePhase,
        trackSaveCompleted,
    });

    async function runSaveFlow(config: ISaveFlowConfig) {
        if (hasSaveOperationInProgress()) {
            return false;
        }
        const saveStartedAtMs = nowMs();
        let saveSucceededForTelemetry = false;
        saveOperationInProgress = true;
        config.saveIndicator.value = true;
        const expectedWorkingPath = documentIdentity.workingCopyPath.value;
        const expectedOriginalPath = documentIdentity.originalPath.value;
        return runWithDocumentOperationLease(config.operationKind, async () => {
            try {
                for (let attempt = 0; attempt <= MAX_STALE_REVISION_SAVE_RETRIES; attempt += 1) {
                    let context: IFileOperationsSaveContext | null = null;
                    try {
                        context = await prepareSaveContext({
                            mode: config.mode,
                            persistOpenNotesAbortMessage: config.persistOpenNotesAbortMessage,
                            shouldPreferWorkingCopy: config.shouldPreferWorkingCopy,
                            canPersistNativeWorkingCopy: Boolean(config.persistNativeWorkingCopy),
                            canAttemptNativeMutationSave: saveExecutor.hasNativePdfMutationCapability(),
                            ...(config.forceSerialize !== undefined ? {forceSerialize: config.forceSerialize} : {}),
                            ...(config.forceRewrite !== undefined ? {forceRewrite: config.forceRewrite} : {}),
                        }, expectedWorkingPath, expectedOriginalPath);
                        if (!context) {
                            return false;
                        }

                        const saveSucceeded = await saveExecutor.executeSelectedSavePath(config, context);
                        if (!saveSucceeded && context.pendingChangesSource === 'workspace-compat') {
                            restorePendingEmbeddedAnnotationChanges(context.pendingTexts, context.pendingDeletes);
                        }
                        saveSucceededForTelemetry = saveSucceeded;
                        return saveSucceeded;
                    } catch (error) {
                        if (context?.pendingChangesSource === 'workspace-compat') {
                            restorePendingEmbeddedAnnotationChanges(
                                context.pendingTexts,
                                context.pendingDeletes,
                            );
                        }
                        context?.reloadWaiter.cancelPending();
                        if (isStaleRevisionError(error) && attempt < MAX_STALE_REVISION_SAVE_RETRIES) {
                            BrowserLogger.debug('workspace', 'Retrying save after stale document revision', {
                                attempt: attempt + 1,
                                maxRetries: MAX_STALE_REVISION_SAVE_RETRIES,
                            });
                            continue;
                        }
                        BrowserLogger.error('workspace', config.failureLogMessage, error);
                        toast.add({
                            color: 'error',
                            title: t('errors.file.save'),
                            description: getDocumentMutationErrorPayload(error)?.message ?? getErrorMessage(error),
                        });
                        return false;
                    } finally {
                        context?.reloadWaiter.cancelPending();
                    }
                }
                return false;
            } finally {
                logSavePhase(
                    config.totalPhase,
                    saveStartedAtMs,
                    { success: saveSucceededForTelemetry },
                    SLOW_SAVE_TOTAL_WARN_MS,
                );
                saveOperationInProgress = false;
                config.saveIndicator.value = false;
            }
        });
    }

    function restorePendingEmbeddedAnnotationChanges(
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
    ) {
        annotationEdits.restorePendingEmbeddedTextUpdates?.(pendingTexts);
        annotationEdits.restorePendingEmbeddedAnnotationDeletes?.(pendingDeletes);
    }

    function hasSaveOperationInProgress() {
        if (saveOperationInProgress || status.isSaving.value || status.isSavingAs.value) {
            return true;
        }
        return false;
    }

    function clearSaveIndicator(mode: 'save' | 'save_as') {
        if (mode === 'save') {
            status.isSaving.value = false;
            return;
        }
        status.isSavingAs.value = false;
    }

    async function handleSave() {
        return runSaveFlow({
            mode: 'save',
            operationKind: 'save',
            saveMode: 'rewrite',
            persistOpenNotesAbortMessage: 'Save aborted because annotation note persistence failed',
            totalPhase: 'handle-save-total',
            failureLogMessage: 'Save failed',
            saveIndicator: status.isSaving,
            persistSerialized: file.saveFile,
            persistUnserialized: file.saveWorkingCopy,
            shouldPreferWorkingCopy: true,
        });
    }

    async function handleSaveAs() {
        const optimizeLossless = nativeWorkingCopy?.optimizePdfOnSaveAs?.value === true;
        return runSaveFlow({
            mode: 'save_as',
            operationKind: 'save-as',
            saveMode: 'save_as_rewrite',
            persistOpenNotesAbortMessage: 'Save As aborted because annotation note persistence failed',
            totalPhase: 'handle-save-as-total',
            failureLogMessage: 'Save As failed',
            saveIndicator: status.isSavingAs,
            persistSerialized: (data, opts) => file.saveWorkingCopyAs(data, {
                ...opts,
                optimizeLossless,
            }),
            persistUnserialized: opts => file.saveWorkingCopyAs(undefined, {
                ...opts,
                optimizeLossless,
            }),
            shouldPreferWorkingCopy: false,
        });
    }

    async function handleRepairSave() {
        return runSaveFlow({
            mode: 'save',
            operationKind: 'repair-save',
            saveMode: 'rewrite',
            persistOpenNotesAbortMessage: 'Repair save aborted because annotation note persistence failed',
            totalPhase: 'handle-save-total',
            failureLogMessage: 'Repair save failed',
            saveIndicator: status.isSaving,
            persistSerialized: file.saveFile,
            persistUnserialized: file.saveWorkingCopy,
            ...(nativeWorkingCopy?.repairWorkingCopy
                ? { persistNativeWorkingCopy: nativeWorkingCopy.repairWorkingCopy }
                : {}),
            shouldPreferWorkingCopy: true,
            forceSerialize: true,
            forceRewrite: true,
        });
    }

    async function handleOptimizePdfForInteraction() {
        return runSaveFlow({
            mode: 'save',
            operationKind: 'optimize-pdf',
            saveMode: 'rewrite',
            persistOpenNotesAbortMessage: 'PDF optimization aborted because annotation note persistence failed',
            totalPhase: 'handle-optimize-pdf-total',
            failureLogMessage: 'PDF optimization failed',
            saveIndicator: status.isSaving,
            persistSerialized: file.saveFile,
            persistUnserialized: file.saveWorkingCopy,
            ...(nativeWorkingCopy?.optimizeWorkingCopy
                ? { persistNativeWorkingCopy: nativeWorkingCopy.optimizeWorkingCopy }
                : {}),
            shouldPreferWorkingCopy: true,
            forceSerialize: true,
            forceRewrite: true,
        });
    }

    async function handleOptimizePdfAsCopy(options: IPdfOptimizeOptions, requestId?: string) {
        const optimizeWorkingCopyAsCopy = nativeWorkingCopy?.optimizeWorkingCopyAsCopy;
        if (!optimizeWorkingCopyAsCopy || hasSaveOperationInProgress()) {
            return false;
        }
        const saveStartedAtMs = nowMs();
        let saveSucceededForTelemetry = false;
        status.isSavingAs.value = true;
        saveOperationInProgress = true;
        const expectedWorkingPath = documentIdentity.workingCopyPath.value;
        const reloadWaiter = lifecycle.preparePostSaveReload?.() ?? null;

        return runWithDocumentOperationLease('optimize-pdf', async () => {
            try {
                const saveSucceeded = await saveExecutor.executeOptimizeCopySave({
                    expectedWorkingPath,
                    expectedDocumentRevisionToken: documentIdentity.documentRevisionToken.value,
                    options,
                    requestId,
                    reloadWaiter,
                });
                saveSucceededForTelemetry = saveSucceeded;
                return saveSucceeded;
            } catch (error) {
                reloadWaiter?.cancel();
                BrowserLogger.error('workspace', 'PDF optimization failed', error);
                toast.add({
                    color: 'error',
                    title: t('errors.file.save'),
                    description: getErrorMessage(error),
                });
                return false;
            } finally {
                logSavePhase(
                    'handle-optimize-pdf-total',
                    saveStartedAtMs,
                    { success: saveSucceededForTelemetry },
                    SLOW_SAVE_TOTAL_WARN_MS,
                );
                saveOperationInProgress = false;
                status.isSavingAs.value = false;
            }
        });
    }

    return {
        handleSave,
        handleRepairSave,
        handleOptimizePdfForInteraction,
        handleOptimizePdfAsCopy,
        handleSaveAs,
    };
};
