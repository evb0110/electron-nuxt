import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type {
    IPdfPersistResult,
    IPdfSaveResult,
    TPdfSaveMode,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/platformApi';
import { isTimeoutError } from '@contracts/timeoutError';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { withTimeout } from 'es-toolkit/promise';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useAnalytics } from '@app/composables/useAnalytics';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/composables/pdf/pdfSerializationRefs';
import { getErrorMessage } from '@app/utils/error';
import { buildPdfAnnotationSavePlan } from '@app/services/pdf-save/pdfAnnotationSavePlanner';
import { collectLivePdfJsAnnotationChangeIds } from '@app/services/pdf-save/pdfAnnotationStorageChanges';

const SLOW_SAVE_PHASE_WARN_MS = 5_000;
const SLOW_SAVE_TOTAL_WARN_MS = 10_000;

class SaveDocumentTimeoutError extends Error {
    constructor() {
        super('PDF.js saveDocument timed out');
        this.name = 'SaveDocumentTimeoutError';
    }
}

interface ISerializationBasePdfBytesOptions {
    pendingDeletes?: IAnnotationCommentSummary[] | null;
    pendingTexts?: Map<string, string> | null;
}

export interface IFileOperationsDeps {
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    annotationDirty: Ref<boolean>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    pageLabelsDirty: Ref<boolean>;
    bookmarksDirty: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    saveDocument: () => Promise<Uint8Array | null>;
    getSourcePdfData: () => Promise<Uint8Array | null>;
    readWorkingCopyBytes: () => Promise<Uint8Array | null>;
    validatePdfPath: (path: TDocumentRef) => Promise<IPdfSaveResult['validation']>;
    saveFile: (data: Uint8Array, opts?: { saveMode?: TPdfSaveMode }) => Promise<IPdfPersistResult>;
    saveWorkingCopy: (opts?: { saveMode?: TPdfSaveMode }) => Promise<IPdfPersistResult>;
    saveWorkingCopyAs: (data?: Uint8Array, opts?: { saveMode?: TPdfSaveMode }) => Promise<IPdfPersistResult>;
    markAnnotationSaved: () => void;
    markPageLabelsSaved: () => void;
    markBookmarksSaved: () => void;
    hasAnnotationChanges: () => boolean;
    hasShapeChanges?: () => boolean;
    serializePdfForSave: (
        data: Uint8Array,
        options?: {
            includeShapes?: boolean;
            rewriteShapeState?: boolean;
            pendingTexts?: Map<string, string> | null;
            pendingDeletes?: IAnnotationCommentSummary[] | null;
        },
    ) => Promise<Uint8Array>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
    restorePendingEmbeddedTextUpdates?: (updates: Map<string, string> | null | undefined) => void;
    consumePendingEmbeddedAnnotationDeletes: () => IAnnotationCommentSummary[] | null;
    restorePendingEmbeddedAnnotationDeletes?: (deletions: IAnnotationCommentSummary[] | null | undefined) => void;
    annotationNoteWindowsCount: Ref<number>;
    loadRecentFiles: () => void;
    preparePostSaveReload?: () => {
        promise: Promise<void>;
        cancel: () => void;
    };
    markShapeStateSaved?: () => void;
    preparePersistedShapeStateForSave?: (data: Uint8Array) => Promise<unknown>;
    restorePreparedPersistedShapeState?: (snapshot: unknown) => Promise<void> | void;
    adoptPersistedShapeStateForNextReload?: () => void;
    clearPendingPersistedShapeStateForNextReload?: () => void;
}

export const useFileOperations = (deps: IFileOperationsDeps) => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const toast = useToast();
    const {
        isSaving,
        isSavingAs,
        workingCopyPath,
        annotationDirty,
        annotationComments,
        pageLabelsDirty,
        bookmarksDirty,
        pdfDocument,
        saveDocument,
        getSourcePdfData,
        validatePdfPath,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        hasAnnotationChanges,
        hasShapeChanges,
        serializePdfForSave,
        persistAllAnnotationNotes,
        consumePendingEmbeddedTextUpdates,
        restorePendingEmbeddedTextUpdates,
        consumePendingEmbeddedAnnotationDeletes,
        restorePendingEmbeddedAnnotationDeletes,
        annotationNoteWindowsCount,
        loadRecentFiles,
        preparePostSaveReload,
        markShapeStateSaved,
        preparePersistedShapeStateForSave,
        restorePreparedPersistedShapeState,
        adoptPersistedShapeStateForNextReload,
        clearPendingPersistedShapeStateForNextReload,
    } = deps;

    let saveOperationInProgress = false;

    function nowMs() {
        return typeof performance !== 'undefined'
            ? performance.now()
            : Date.now();
    }

    function getSaveDebugContext() {
        return {
            hasWorkingCopyPath: Boolean(workingCopyPath.value),
            documentPages: pdfDocument.value?.numPages ?? null,
            annotationDirty: annotationDirty.value,
            pageLabelsDirty: pageLabelsDirty.value,
            bookmarksDirty: bookmarksDirty.value,
            hasAnnotationChanges: hasAnnotationChanges(),
            hasShapeChanges: hasShapeChanges?.() ?? false,
            annotationNoteWindowsCount: annotationNoteWindowsCount.value,
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

    function isReplayableEditorOnlyFreeTextNote(comment: IAnnotationCommentSummary) {
        const subtype = comment.subtype?.trim().toLowerCase();
        return comment.source === 'editor'
            && !parsePdfJsAnnotationRef(comment.annotationId)
            && Boolean(comment.hasNote)
            && Boolean(comment.markerRect)
            && (subtype === 'freetext' || subtype === 'typewriter');
    }

    function hasUnreplayableEditorOnlyAnnotationsPendingMaterialization() {
        return annotationComments.value.some(comment =>
            comment.source === 'editor'
            && !parsePdfJsAnnotationRef(comment.annotationId)
            && !isReplayableEditorOnlyFreeTextNote(comment),
        );
    }

    async function buildSerializedSaveResult(
        rawData: Uint8Array,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        opts?: {
            includeShapes?: boolean;
            rewriteShapeState?: boolean;
            saveMode?: TPdfSaveMode;
        },
    ): Promise<IPdfSaveResult | null> {
        const serializeOptions: Parameters<typeof serializePdfForSave>[1] = {
            pendingTexts,
            pendingDeletes,
        };
        if (opts?.includeShapes !== undefined) {
            serializeOptions.includeShapes = opts.includeShapes;
        }
        if (opts?.rewriteShapeState !== undefined) {
            serializeOptions.rewriteShapeState = opts.rewriteShapeState;
        }
        const data = await timedSavePhase(
            'serialize-pdf-for-save',
            () => serializePdfForSave(rawData, serializeOptions),
            result => ({
                inputBytes: rawData.byteLength,
                outputBytes: result.byteLength,
                includeShapes: Boolean(opts?.includeShapes),
                rewriteShapeState: Boolean(opts?.rewriteShapeState),
                pendingTexts: pendingTexts?.size ?? 0,
                pendingDeletes: pendingDeletes?.length ?? 0,
            }),
        );

        return {
            finalBytes: data,
            saveMode: opts?.saveMode ?? 'rewrite',
            warnings: [],
            validation: {
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            },
        };
    }

    async function validateWorkingCopySnapshot(saveMode: TPdfSaveMode) {
        const path = workingCopyPath.value;
        if (!path) {
            return null;
        }

        const validation = await timedSavePhase(
            'validate-pdf-path',
            () => validatePdfPath(path),
            result => ({
                saveMode,
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
            return null;
        }

        return {
            finalBytes: new Uint8Array(),
            saveMode,
            warnings: validation.warnings,
            validation,
        };
    }

    function finalizeSuccessfulSave(result: IPdfPersistResult, opts?: {
        resetAnnotationStorage?: boolean;
        markShapeStateSaved?: boolean;
    }) {
        if (!result.success) {
            return false;
        }

        BrowserLogger.debug('workspace', 'Finalizing successful save', () => ({
            didSaveAs: result.didSaveAs,
            outPath: result.outPath,
            saveMode: result.saveMode,
            resetAnnotationStorage: opts?.resetAnnotationStorage !== false,
            annotationDirty: annotationDirty.value,
            pageLabelsDirty: pageLabelsDirty.value,
            bookmarksDirty: bookmarksDirty.value,
            hasAnnotationChanges: hasAnnotationChanges(),
            hasShapeChanges: hasShapeChanges?.() ?? false,
        }));

        if (opts?.resetAnnotationStorage !== false) {
            pdfDocument.value?.annotationStorage?.resetModified();
        }
        markAnnotationSaved();
        markPageLabelsSaved();
        markBookmarksSaved();
        if (opts?.markShapeStateSaved !== false) {
            markShapeStateSaved?.();
        }

        if (result.outPath) {
            loadRecentFiles();
        }

        return true;
    }

    async function saveDocumentWithRetry(maxAttempts = 4, retryDelayMs = 50) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const attemptStartedAtMs = nowMs();
            try {
                const data = await withTimeout(async () => {
                    const data = await saveDocument();
                    if (!data) {
                        throw new Error('saveDocument returned no data');
                    }
                    return data;
                }, PDF_SAVE_TIMEOUT_MS);
                logSavePhase('pdfjs-save-document', attemptStartedAtMs, {
                    attempt,
                    maxAttempts,
                    bytes: data.byteLength,
                });
                return data;
            } catch (error) {
                const timedOut = isTimeoutError(error);
                const durationMs = Math.round(nowMs() - attemptStartedAtMs);
                BrowserLogger.warn(
                    'workspace',
                    timedOut
                        ? 'Save aborted because PDF.js saveDocument timed out'
                        : 'saveDocument attempt failed',
                    {
                        attempt,
                        maxAttempts,
                        timedOut,
                        durationMs,
                        error,
                    },
                );

                if (timedOut) {
                    throw new SaveDocumentTimeoutError();
                }

                if (attempt === maxAttempts) {
                    throw error;
                }

                if (retryDelayMs > 0) {
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, retryDelayMs);
                    });
                }
            }
        }

        throw new Error('saveDocument failed');
    }

    function addExistingPdfAnnotationIdFromStableKey(ids: Set<string>, stableKey: string) {
        const match = stableKey.trim().match(/^ann:\d+:(.+)$/u);
        const normalized = normalizePdfJsAnnotationId(match?.[1]);
        if (normalized) {
            ids.add(normalized);
        }
    }

    function addReplayableAnnotationId(ids: Set<string>, id: string | null | undefined) {
        const normalized = normalizePdfJsAnnotationId(id);
        if (!normalized) {
            return;
        }

        ids.add(normalized);

        const nestedEditorId = normalized.match(/^editor:\d+:(.+)$/u)?.[1];
        if (nestedEditorId && nestedEditorId !== normalized) {
            addReplayableAnnotationId(ids, nestedEditorId);
        }
    }

    function addEditorRuntimeAnnotationIdFromStableKey(ids: Set<string>, stableKey: string) {
        const trimmed = stableKey.trim();
        const match = trimmed.match(/^(?:uid|editor):\d+:(.+)$/u)
            ?? trimmed.match(/^src:editor:\d+:(.+)$/u);
        addReplayableAnnotationId(ids, match?.[1]);
    }

    function collectReplayableEmbeddedAnnotationIds(
        pendingTexts: Map<string, string> | null | undefined,
        pendingDeletes: IAnnotationCommentSummary[] | null | undefined,
        liveChanges?: ReturnType<typeof collectLivePdfJsAnnotationChangeIds>,
    ) {
        const ids = new Set<string>();
        pendingTexts?.forEach((_text, stableKey) => {
            addExistingPdfAnnotationIdFromStableKey(ids, stableKey);
            addEditorRuntimeAnnotationIdFromStableKey(ids, stableKey);
        });
        pendingDeletes?.forEach((comment) => {
            addReplayableAnnotationId(ids, comment.annotationId);
            addExistingPdfAnnotationIdFromStableKey(ids, comment.stableKey);
            addEditorRuntimeAnnotationIdFromStableKey(ids, comment.stableKey);
        });
        annotationComments.value
            .filter(isReplayableEditorOnlyFreeTextNote)
            .forEach((comment) => {
                [
                    comment.annotationId,
                    comment.uid,
                    comment.id,
                ].forEach((id) => {
                    addReplayableAnnotationId(ids, id);
                });
                addEditorRuntimeAnnotationIdFromStableKey(ids, comment.stableKey);
            });
        if (ids.size > 0) {
            liveChanges?.replayableEditorNoteIds.forEach((id) => {
                addReplayableAnnotationId(ids, id);
            });
        }
        return ids;
    }

    function canUseSourceBytesForReplayableEmbeddedChanges(opts?: ISerializationBasePdfBytesOptions) {
        const liveChanges = collectLivePdfJsAnnotationChangeIds(pdfDocument.value);
        const replayableIds = collectReplayableEmbeddedAnnotationIds(opts?.pendingTexts, opts?.pendingDeletes, liveChanges);
        const plan = buildPdfAnnotationSavePlan({
            hasPendingReplayableEmbeddedChanges: Boolean(
                opts?.pendingTexts?.size
                || opts?.pendingDeletes?.length
                || replayableIds.size > 0,
            ),
            hasEditorOnlyAnnotationsPendingMaterialization: hasUnreplayableEditorOnlyAnnotationsPendingMaterialization(),
            liveAnnotationChanges: liveChanges,
            replayableEmbeddedAnnotationIds: replayableIds,
        });
        return plan.route === 'source-replay';
    }

    async function getSerializationBasePdfBytes(opts?: ISerializationBasePdfBytesOptions) {
        const liveChanges = collectLivePdfJsAnnotationChangeIds(pdfDocument.value);
        const replayableIds = collectReplayableEmbeddedAnnotationIds(opts?.pendingTexts, opts?.pendingDeletes, liveChanges);
        const plan = buildPdfAnnotationSavePlan({
            hasPendingReplayableEmbeddedChanges: Boolean(
                opts?.pendingTexts?.size
                || opts?.pendingDeletes?.length
                || replayableIds.size > 0,
            ),
            hasEditorOnlyAnnotationsPendingMaterialization: hasUnreplayableEditorOnlyAnnotationsPendingMaterialization(),
            liveAnnotationChanges: liveChanges,
            replayableEmbeddedAnnotationIds: replayableIds,
        });

        BrowserLogger.debug('workspace', 'Planned PDF annotation save route', {
            route: plan.route,
            expectedCost: plan.expectedCost,
            reason: plan.reason,
            liveAnnotationIds: Array.from(liveChanges.ids),
            replayableLiveEditorNoteIds: Array.from(liveChanges.replayableEditorNoteIds),
            replayableAnnotationIds: Array.from(replayableIds),
            unreplayableLiveAnnotationIds: plan.unreplayableLiveAnnotationIds,
            pendingTexts: opts?.pendingTexts?.size ?? 0,
            pendingDeletes: opts?.pendingDeletes?.length ?? 0,
        });

        if (plan.route === 'source-replay' || plan.route === 'source-clean') {
            BrowserLogger.debug('workspace', 'Using source PDF bytes for planned annotation save route', {
                route: plan.route,
                reason: plan.reason,
                pendingTexts: opts?.pendingTexts?.size ?? 0,
                pendingDeletes: opts?.pendingDeletes?.length ?? 0,
            });
            return timedSavePhase(
                'read-source-pdf-bytes',
                getSourcePdfData,
                result => ({
                    route: plan.route,
                    reason: plan.reason,
                    bytes: result?.byteLength ?? null,
                }),
            );
        }

        try {
            return await saveDocumentWithRetry();
        } catch (error) {
            if (!canUseSourceBytesForReplayableEmbeddedChanges(opts)) {
                throw error;
            }
            BrowserLogger.warn('workspace', 'Falling back to source PDF bytes after PDF.js saveDocument failed', error);
            return timedSavePhase(
                'read-source-pdf-bytes-after-pdfjs-fallback',
                getSourcePdfData,
                result => ({ bytes: result?.byteLength ?? null }),
            );
        }
    }

    async function finalizeSaveReload(
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        saveSucceeded: boolean,
        opts?: { markShapeStateSavedOnSuccess?: boolean },
    ) {
        if (!saveSucceeded) {
            clearPendingPersistedShapeStateForNextReload?.();
            reloadWaiter?.cancel();
            return;
        }
        if (!reloadWaiter) {
            if (opts?.markShapeStateSavedOnSuccess) {
                markShapeStateSaved?.();
            }
            return;
        }
        await reloadWaiter.promise.then(() => true).catch((error) => {
            BrowserLogger.warn('workspace', 'Saved PDF but failed to restore the reloaded view', error);
            return false;
        }).finally(() => {
            if (opts?.markShapeStateSavedOnSuccess) {
                markShapeStateSaved?.();
            }
        });
    }

    function armPersistedShapeStateAdoption(shapeStateDirty: boolean) {
        if (!shapeStateDirty) {
            return false;
        }

        adoptPersistedShapeStateForNextReload?.();
        return true;
    }

    async function primePersistedShapeStateForSave(
        data: Uint8Array,
        shapeStateDirty: boolean,
    ) {
        if (!shapeStateDirty) {
            return null;
        }

        return preparePersistedShapeStateForSave?.(data) ?? null;
    }

    async function restorePreparedShapeState(snapshot: unknown) {
        if (!snapshot) {
            return;
        }

        await restorePreparedPersistedShapeState?.(snapshot);
    }

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

    async function persistSerializedSaveResult(
        saveResult: IPdfSaveResult,
        shapeStateDirty: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        persist: (
            data: Uint8Array,
            opts: { saveMode: TPdfSaveMode },
        ) => Promise<IPdfPersistResult>,
    ) {
        let preparedShapeStateSnapshot: unknown = null;
        try {
            preparedShapeStateSnapshot = await primePersistedShapeStateForSave(
                saveResult.finalBytes,
                shapeStateDirty,
            );
            armPersistedShapeStateAdoption(shapeStateDirty);
            const persisted = await timedSavePhase(
                `persist-${mode}`,
                () => persist(saveResult.finalBytes, { saveMode: saveResult.saveMode }),
                result => ({
                    bytes: saveResult.finalBytes.byteLength,
                    saveMode: saveResult.saveMode,
                    success: result.success,
                    didSaveAs: result.didSaveAs,
                }),
            );
            if (finalizeSuccessfulSave(persisted, { markShapeStateSaved: !reloadWaiter })) {
                preparedShapeStateSnapshot = null;
                trackSaveCompleted(mode, persisted, true);
                return true;
            }
            return false;
        } finally {
            await restorePreparedShapeState(preparedShapeStateSnapshot);
        }
    }

    async function persistOpenAnnotationNotes(abortMessage: string) {
        if (annotationNoteWindowsCount.value <= 0) {
            return true;
        }

        const savedNotes = await persistAllAnnotationNotes(true);
        if (!savedNotes) {
            BrowserLogger.warn('workspace', abortMessage);
            return false;
        }

        return true;
    }

    function consumePendingEmbeddedAnnotationChanges() {
        const pendingTexts = consumePendingEmbeddedTextUpdates();
        const pendingDeletes = consumePendingEmbeddedAnnotationDeletes();
        return {
            pendingTexts,
            pendingDeletes,
            hasPendingTexts: Boolean(pendingTexts && pendingTexts.size > 0),
            hasPendingDeletes: Boolean(pendingDeletes && pendingDeletes.length > 0),
        };
    }

    function restorePendingEmbeddedAnnotationChanges(
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
    ) {
        restorePendingEmbeddedTextUpdates?.(pendingTexts);
        restorePendingEmbeddedAnnotationDeletes?.(pendingDeletes);
    }

    function hasSaveOperationInProgress() {
        if (saveOperationInProgress || isSaving.value || isSavingAs.value) {
            return true;
        }
        return false;
    }

    async function saveSerializedChanges(
        rawData: Uint8Array | null,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        shapeStateDirty: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        saveMode: TPdfSaveMode,
        persist: (
            data: Uint8Array,
            opts: { saveMode: TPdfSaveMode },
        ) => Promise<IPdfPersistResult>,
    ) {
        if (!rawData) {
            return false;
        }

        const saveResult = await buildSerializedSaveResult(rawData, pendingTexts, pendingDeletes, {
            includeShapes: shapeStateDirty,
            rewriteShapeState: shapeStateDirty,
            saveMode,
        });
        if (!saveResult) {
            return false;
        }

        return persistSerializedSaveResult(
            saveResult,
            shapeStateDirty,
            reloadWaiter,
            mode,
            persist,
        );
    }

    async function saveUnserializedWorkingCopy(
        saveMode: TPdfSaveMode,
        shapeStateDirty: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        persist: (opts: { saveMode: TPdfSaveMode }) => Promise<IPdfPersistResult>,
    ) {
        const saveResult = await validateWorkingCopySnapshot(saveMode);
        if (!saveResult) {
            return false;
        }

        armPersistedShapeStateAdoption(shapeStateDirty);
        const persisted = await timedSavePhase(
            `persist-${mode}-working-copy`,
            () => persist({ saveMode: saveResult.saveMode }),
            result => ({
                saveMode: saveResult.saveMode,
                success: result.success,
                didSaveAs: result.didSaveAs,
            }),
        );
        if (!finalizeSuccessfulSave(persisted, {
            resetAnnotationStorage: false,
            markShapeStateSaved: !reloadWaiter,
        })) {
            return false;
        }

        trackSaveCompleted(mode, persisted, false);
        return true;
    }

    function computeShouldSerializeFlag(
        shapeStateDirty: boolean,
        hasPendingTexts: boolean,
        hasPendingDeletes: boolean,
    ) {
        return annotationDirty.value
            || hasAnnotationChanges()
            || shapeStateDirty
            || pageLabelsDirty.value
            || bookmarksDirty.value
            || hasPendingTexts
            || hasPendingDeletes;
    }

    async function runSerializedSaveFlow(
        rawData: Uint8Array | null,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        shapeStateDirty: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        saveMode: TPdfSaveMode,
        persist: (
            data: Uint8Array,
            opts: { saveMode: TPdfSaveMode },
        ) => Promise<IPdfPersistResult>,
        onPersistenceSettled?: () => void,
    ) {
        const saveSucceeded = await saveSerializedChanges(
            rawData,
            pendingTexts,
            pendingDeletes,
            shapeStateDirty,
            reloadWaiter,
            mode,
            saveMode,
            persist,
        );
        onPersistenceSettled?.();
        await finalizeSaveReload(reloadWaiter, saveSucceeded, { markShapeStateSavedOnSuccess: Boolean(reloadWaiter) });
        return saveSucceeded;
    }

    function clearSaveIndicator(mode: 'save' | 'save_as') {
        if (mode === 'save') {
            isSaving.value = false;
            return;
        }
        isSavingAs.value = false;
    }

    async function handleSave() {
        if (hasSaveOperationInProgress()) {
            return false;
        }
        const saveStartedAtMs = nowMs();
        let saveSucceededForTelemetry = false;
        saveOperationInProgress = true;
        isSaving.value = true;
        let reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null = null;
        let finalizedReloadWaiter = false;
        let pendingTexts: Map<string, string> | null = null;
        let pendingDeletes: IAnnotationCommentSummary[] | null = null;
        try {
            if (!await persistOpenAnnotationNotes('Save aborted because annotation note persistence failed')) {
                return false;
            }
            const pendingChanges = consumePendingEmbeddedAnnotationChanges();
            ({
                pendingTexts,
                pendingDeletes,
            } = pendingChanges);
            const {
                hasPendingTexts,
                hasPendingDeletes,
            } = pendingChanges;
            reloadWaiter = preparePostSaveReload?.() ?? null;
            let saveSucceeded = false;
            BrowserLogger.debug('workspace', 'Starting handleSave', () => ({
                hasWorkingCopyPath: Boolean(workingCopyPath.value),
                annotationDirty: annotationDirty.value,
                pageLabelsDirty: pageLabelsDirty.value,
                bookmarksDirty: bookmarksDirty.value,
                hasAnnotationChanges: hasAnnotationChanges(),
                hasShapeChanges: hasShapeChanges?.() ?? false,
                hasPendingTexts,
                hasPendingDeletes,
                annotationNoteWindowsCount: annotationNoteWindowsCount.value,
            }));
            if (workingCopyPath.value) {
                const shapeStateDirty = hasShapeChanges?.() ?? false;
                const shouldSerialize = computeShouldSerializeFlag(shapeStateDirty, hasPendingTexts, hasPendingDeletes);
                if (shouldSerialize) {
                    const rawData = await getSerializationBasePdfBytes({
                        pendingDeletes,
                        pendingTexts,
                    });
                    saveSucceeded = await runSerializedSaveFlow(
                        rawData,
                        pendingTexts,
                        pendingDeletes,
                        shapeStateDirty,
                        reloadWaiter,
                        'save',
                        'rewrite',
                        saveFile,
                        () => clearSaveIndicator('save'),
                    );
                    finalizedReloadWaiter = true;
                    if (!saveSucceeded) {
                        restorePendingEmbeddedAnnotationChanges(pendingTexts, pendingDeletes);
                    }
                    saveSucceededForTelemetry = saveSucceeded;
                    return saveSucceeded;
                }
                saveSucceeded = await saveUnserializedWorkingCopy(
                    'rewrite',
                    shapeStateDirty,
                    reloadWaiter,
                    'save',
                    saveWorkingCopy,
                );
                clearSaveIndicator('save');
                await finalizeSaveReload(reloadWaiter, saveSucceeded, { markShapeStateSavedOnSuccess: Boolean(reloadWaiter) });
                finalizedReloadWaiter = true;
                saveSucceededForTelemetry = saveSucceeded;
                return saveSucceeded;
            }

            const shapeStateDirty = hasShapeChanges?.() ?? false;
            const rawData = await getSerializationBasePdfBytes({
                pendingDeletes,
                pendingTexts,
            });
            saveSucceeded = await runSerializedSaveFlow(
                rawData,
                pendingTexts,
                pendingDeletes,
                shapeStateDirty,
                reloadWaiter,
                'save',
                'rewrite',
                saveFile,
                () => clearSaveIndicator('save'),
            );
            finalizedReloadWaiter = true;
            if (!saveSucceeded) {
                restorePendingEmbeddedAnnotationChanges(pendingTexts, pendingDeletes);
            }
            saveSucceededForTelemetry = saveSucceeded;
            return saveSucceeded;
        } catch (error) {
            restorePendingEmbeddedAnnotationChanges(pendingTexts, pendingDeletes);
            BrowserLogger.error('workspace', 'Save failed', error);
            toast.add({
                color: 'error',
                title: t('errors.file.save'),
                description: getErrorMessage(error),
            });
            return false;
        } finally {
            if (reloadWaiter && !finalizedReloadWaiter) {
                reloadWaiter.cancel();
            }
            logSavePhase(
                'handle-save-total',
                saveStartedAtMs,
                { success: saveSucceededForTelemetry },
                SLOW_SAVE_TOTAL_WARN_MS,
            );
            saveOperationInProgress = false;
            isSaving.value = false;
        }
    }

    async function handleSaveAs() {
        if (hasSaveOperationInProgress()) {
            return false;
        }
        const saveStartedAtMs = nowMs();
        let saveSucceededForTelemetry = false;
        saveOperationInProgress = true;
        isSavingAs.value = true;
        let reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null = null;
        let finalizedReloadWaiter = false;
        let pendingTexts: Map<string, string> | null = null;
        let pendingDeletes: IAnnotationCommentSummary[] | null = null;
        try {
            if (!await persistOpenAnnotationNotes('Save As aborted because annotation note persistence failed')) {
                return false;
            }
            const pendingChanges = consumePendingEmbeddedAnnotationChanges();
            ({
                pendingTexts,
                pendingDeletes,
            } = pendingChanges);
            const {
                hasPendingTexts,
                hasPendingDeletes,
            } = pendingChanges;
            reloadWaiter = preparePostSaveReload?.() ?? null;
            let saveSucceeded = false;
            const shapeStateDirty = hasShapeChanges?.() ?? false;
            const shouldSerialize = computeShouldSerializeFlag(shapeStateDirty, hasPendingTexts, hasPendingDeletes);
            if (shouldSerialize) {
                const rawData = await getSerializationBasePdfBytes({
                    pendingDeletes,
                    pendingTexts,
                });
                saveSucceeded = await saveSerializedChanges(
                    rawData,
                    pendingTexts,
                    pendingDeletes,
                    shapeStateDirty,
                    reloadWaiter,
                    'save_as',
                    'save_as_rewrite',
                    saveWorkingCopyAs,
                );
            } else {
                saveSucceeded = await saveUnserializedWorkingCopy(
                    'save_as_rewrite',
                    shapeStateDirty,
                    reloadWaiter,
                    'save_as',
                    opts => saveWorkingCopyAs(undefined, opts),
                );
            }
            clearSaveIndicator('save_as');
            await finalizeSaveReload(reloadWaiter, saveSucceeded, { markShapeStateSavedOnSuccess: Boolean(reloadWaiter) });
            finalizedReloadWaiter = true;
            if (!saveSucceeded) {
                restorePendingEmbeddedAnnotationChanges(pendingTexts, pendingDeletes);
            }
            saveSucceededForTelemetry = saveSucceeded;
            return saveSucceeded;
        } catch (error) {
            restorePendingEmbeddedAnnotationChanges(pendingTexts, pendingDeletes);
            BrowserLogger.error('workspace', 'Save As failed', error);
            toast.add({
                color: 'error',
                title: t('errors.file.save'),
                description: getErrorMessage(error),
            });
            return false;
        } finally {
            if (reloadWaiter && !finalizedReloadWaiter) {
                reloadWaiter.cancel();
            }
            logSavePhase(
                'handle-save-as-total',
                saveStartedAtMs,
                { success: saveSucceededForTelemetry },
                SLOW_SAVE_TOTAL_WARN_MS,
            );
            saveOperationInProgress = false;
            isSavingAs.value = false;
        }
    }

    return {
        handleSave,
        handleSaveAs,
    };
};
