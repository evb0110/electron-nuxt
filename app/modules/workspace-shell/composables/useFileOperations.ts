import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    IPdfPersistResult,
    IPdfSaveResult,
    TPdfSaveMode,
} from '@app/types/pdf';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import { isTimeoutError } from '@contracts/isTimeoutError';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {delay} from 'es-toolkit/promise';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useAnalytics } from '@app/composables/useAnalytics';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import {
    buildNativePdfMutationPlanForSave,
    buildPdfAnnotationSavePlan,
    collectLivePdfJsAnnotationChangeIds,
    isReplayableEditorOnlyFreeTextNote,
    mergeAnnotationCommentSaveSnapshot,
} from '@app/modules/pdf-viewer/public';
import { getErrorMessage } from '@app/utils/error';
import { toPdfDateString } from '@app/utils/pdfDate';
import type {
    IMarkupSubtypeHint,
    INativePdfMutationPlan,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';

const SLOW_SAVE_PHASE_WARN_MS = 5_000;
const SLOW_SAVE_TOTAL_WARN_MS = 10_000;
const PDF_SAVE_TIMEOUT_QUIESCE_MS = 2_000;

interface IPersistSerializedOptions {
    saveMode: TPdfSaveMode;
    preserveLoadedSource?: boolean;
    expectedWorkingPath?: TDocumentRef | null;
}

class SaveDocumentTimeoutError extends Error {
    constructor(public readonly settlePromise: Promise<void>) {
        super('PDF.js saveDocument timed out');
        this.name = 'SaveDocumentTimeoutError';
    }
}

interface ISerializationBasePdfBytesOptions {
    forcePdfjsMaterialize?: boolean;
    pendingDeletes?: IAnnotationCommentSummary[] | null;
    pendingTexts?: Map<string, string> | null;
}

interface IDocumentDirtyState {
    annotationDirty: boolean;
    annotationChanges: boolean;
    bookmarks: boolean;
    livePdfJsAnnotations: boolean;
    pageLabels: boolean;
    pendingDeletes: boolean;
    pendingTexts: boolean;
    preservedAnnotationSource: boolean;
    savedPdfjsAnnotationBaseline: boolean;
    shapes: boolean;
}

type TDocumentDirtySource = keyof IDocumentDirtyState;

const SHOULD_SERIALIZE_DIRTY_SOURCES = {
    annotationChanges: state => state.annotationChanges,
    annotationDirty: state => state.annotationDirty,
    bookmarks: state => state.bookmarks,
    livePdfJsAnnotations: state => state.livePdfJsAnnotations,
    pageLabels: state => state.pageLabels,
    pendingDeletes: state => state.pendingDeletes,
    pendingTexts: state => state.pendingTexts,
    preservedAnnotationSource: state => state.preservedAnnotationSource,
    savedPdfjsAnnotationBaseline: state => state.savedPdfjsAnnotationBaseline,
    shapes: state => state.shapes,
} satisfies Record<TDocumentDirtySource, (state: IDocumentDirtyState) => boolean>;

export interface IFileOperationsDeps {
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    annotationDirty: Ref<boolean>;
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    totalPages?: Ref<number>;
    pageLabelsDirty: Ref<boolean>;
    pageLabelRanges?: Ref<IPdfPageLabelRange[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkItems?: Ref<IPdfBookmarkEntry[]>;
    untitledBookmarkLabel?: string;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    saveDocument: () => Promise<Uint8Array | null>;
    getSourcePdfData: () => Promise<Uint8Array | null>;
    validatePdfPath: (path: TDocumentRef) => Promise<IPdfSaveResult['validation']>;
    saveFile: (data: Uint8Array, opts?: {
        saveMode?: TPdfSaveMode;
        preserveLoadedSource?: boolean;
        expectedWorkingPath?: TDocumentRef | null;
    }) => Promise<IPdfPersistResult>;
    saveWorkingCopy: (opts?: {
        saveMode?: TPdfSaveMode;
        expectedWorkingPath?: TDocumentRef | null;
    }) => Promise<IPdfPersistResult>;
    saveWorkingCopyAs: (data?: Uint8Array, opts?: {
        saveMode?: TPdfSaveMode;
        expectedWorkingPath?: TDocumentRef | null;
    }) => Promise<IPdfPersistResult>;
    trySaveEmbeddedNoteTextUpdates?: (
        updates: IPdfNoteTextUpdate[],
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            modifiedAt: string;
            freeTextNotes?: IPdfNativeFreeTextNote[];
            deletes?: IPdfNativeAnnotationDelete[];
        },
    ) => Promise<IPdfPersistResult | null>;
    trySavePdfNativeMutations?: (
        mutations: IPdfNativeMutationSet,
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            modifiedAt: string;
        },
    ) => Promise<IPdfPersistResult | null>;
    markNativeFreeTextNotesSaved?: (notes: IPdfNativeFreeTextNote[]) => void;
    markNativeFreeTextNotesDeleted?: (deletes: IPdfNativeAnnotationDelete[]) => void;
    markAnnotationSaved: (opts?: { preserveLivePdfjsSession?: boolean }) => void;
    markPageLabelsSaved: () => void;
    markBookmarksSaved: () => void;
    hasAnnotationChanges: () => boolean;
    hasLivePdfJsAnnotationChanges?: () => boolean;
    hasSavedPdfJsAnnotationBaselineChanges?: () => boolean;
    hasPreservedAnnotationSourceChanges?: () => boolean;
    hasShapeChanges?: () => boolean;
    hasManagedShapes?: () => boolean;
    getAllShapes?: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    getMarkupSubtypeOverrides?: () => Map<string, TMarkupSubtype> | undefined;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[] | undefined;
    serializePdfForSave: (
        data: Uint8Array,
        options?: {
            forceRewrite?: boolean;
            includeShapes?: boolean;
            rewriteShapeState?: boolean;
            annotationCommentsSnapshot?: IAnnotationCommentSummary[];
            pendingTexts?: Map<string, string> | null;
            pendingDeletes?: IAnnotationCommentSummary[] | null;
        },
    ) => Promise<Uint8Array>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    consumePendingEmbeddedTextUpdates: () => Map<string, string> | null;
    restorePendingEmbeddedTextUpdates?: (updates: Map<string, string> | null | undefined) => void;
    consumePendingEmbeddedAnnotationDeletes: () => IAnnotationCommentSummary[] | null;
    restorePendingEmbeddedAnnotationDeletes?: (deletions: IAnnotationCommentSummary[] | null | undefined) => void;
    clearAnnotationHistory?: () => void;
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
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const useFileOperations = (deps: IFileOperationsDeps) => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const toast = useToast();
    const {
        isSaving,
        isSavingAs,
        workingCopyPath,
        originalPath,
        annotationDirty,
        annotationComments,
        totalPages,
        pageLabelsDirty,
        pageLabelRanges,
        bookmarksDirty,
        bookmarkItems,
        untitledBookmarkLabel = '',
        pdfDocument,
        saveDocument,
        getSourcePdfData,
        validatePdfPath,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        trySaveEmbeddedNoteTextUpdates,
        trySavePdfNativeMutations,
        markNativeFreeTextNotesSaved,
        markNativeFreeTextNotesDeleted,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        hasAnnotationChanges,
        hasLivePdfJsAnnotationChanges,
        hasSavedPdfJsAnnotationBaselineChanges,
        hasPreservedAnnotationSourceChanges,
        hasShapeChanges,
        hasManagedShapes,
        getAllShapes,
        getDeletedEmbeddedShapeAnnotationIds,
        getDeletedEmbeddedShapeStableKeys,
        getMarkupSubtypeOverrides,
        getMarkupSubtypeHints,
        getAnnotationCommentsSnapshot,
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
        runWithDocumentOperationLease = runWithoutDocumentOperationLease,
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

    function getAnnotationCommentsForSave() {
        return mergeAnnotationCommentSaveSnapshot(
            getAnnotationCommentsSnapshot?.(),
            annotationComments.value,
        );
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

    function hasUnreplayableEditorOnlyAnnotationsPendingMaterialization() {
        return getAnnotationCommentsForSave().some(comment =>
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
            forceRewrite?: boolean;
            includeShapes?: boolean;
            rewriteShapeState?: boolean;
            saveMode?: TPdfSaveMode;
            annotationCommentsSnapshot?: IAnnotationCommentSummary[];
        },
    ): Promise<IPdfSaveResult | null> {
        const serializeOptions: Parameters<typeof serializePdfForSave>[1] = {
            annotationCommentsSnapshot: opts?.annotationCommentsSnapshot ?? getAnnotationCommentsForSave(),
            pendingTexts,
            pendingDeletes,
        };
        if (opts?.includeShapes !== undefined) {
            serializeOptions.includeShapes = opts.includeShapes;
        }
        if (opts?.rewriteShapeState !== undefined) {
            serializeOptions.rewriteShapeState = opts.rewriteShapeState;
        }
        if (opts?.forceRewrite !== undefined) {
            serializeOptions.forceRewrite = opts.forceRewrite;
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
                forceRewrite: Boolean(opts?.forceRewrite),
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
        if (workingCopyPath.value !== path) {
            BrowserLogger.debug('workspace', 'Skipped stale PDF validation result', {
                validatedPath: path,
                currentWorkingPath: workingCopyPath.value,
                saveMode,
            });
            return null;
        }

        return {
            finalBytes: new Uint8Array(),
            saveMode,
            warnings: validation.warnings,
            validation,
            workingPath: path,
        };
    }

    interface ISuccessfulSaveStateCompletionOptions {
        markShapeStateSaved?: boolean | undefined;
        preserveLivePdfjsSession?: boolean | undefined;
        resetAnnotationStorage?: boolean | undefined;
    }

    function completeSuccessfulSaveState(opts?: ISuccessfulSaveStateCompletionOptions) {
        if (opts?.resetAnnotationStorage !== false) {
            pdfDocument.value?.annotationStorage?.resetModified();
        }
        markAnnotationSaved({ preserveLivePdfjsSession: opts?.preserveLivePdfjsSession === true });
        markPageLabelsSaved();
        markBookmarksSaved();
        if (opts?.markShapeStateSaved !== false) {
            markShapeStateSaved?.();
            if (opts?.preserveLivePdfjsSession !== true) {
                clearPendingPersistedShapeStateForNextReload?.();
            }
        }
    }

    function finalizeSuccessfulSave(result: IPdfPersistResult, opts?: {
        completeSaveState?: boolean;
        markShapeStateSaved?: boolean;
        preserveLivePdfjsSession?: boolean;
        resetAnnotationStorage?: boolean;
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

        if (opts?.completeSaveState !== false) {
            completeSuccessfulSaveState({
                markShapeStateSaved: opts?.markShapeStateSaved,
                preserveLivePdfjsSession: opts?.preserveLivePdfjsSession,
                resetAnnotationStorage: opts?.resetAnnotationStorage,
            });
        }

        if (result.outPath) {
            loadRecentFiles();
        }

        return true;
    }

    async function runSaveDocumentAttemptWithTimeout() {
        const savePromise = (async () => {
            const data = await saveDocument();
            if (!data) {
                throw new Error('saveDocument returned no data');
            }
            return data;
        })();
        const settlePromise = savePromise.then(() => undefined, () => undefined);
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
                timeoutHandle = null;
                reject(new SaveDocumentTimeoutError(settlePromise));
            }, PDF_SAVE_TIMEOUT_MS);
        });

        try {
            return await Promise.race([
                savePromise,
                timeoutPromise,
            ]);
        } finally {
            if (timeoutHandle !== null) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    async function waitForTimedOutSaveDocumentToQuiesce(error: SaveDocumentTimeoutError) {
        const didSettle = await Promise.race([
            error.settlePromise.then(() => true),
            delay(PDF_SAVE_TIMEOUT_QUIESCE_MS).then(() => false),
        ]);
        if (!didSettle) {
            BrowserLogger.warn('workspace', 'Skipped source-byte fallback because timed-out PDF.js saveDocument is still running', {
                timeoutMs: PDF_SAVE_TIMEOUT_MS,
                quiesceMs: PDF_SAVE_TIMEOUT_QUIESCE_MS,
            });
        }
        return didSettle;
    }

    async function saveDocumentWithRetry(maxAttempts = 4, retryDelayMs = 50) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const attemptStartedAtMs = nowMs();
            try {
                const data = await runSaveDocumentAttemptWithTimeout();
                logSavePhase('pdfjs-save-document', attemptStartedAtMs, {
                    attempt,
                    maxAttempts,
                    bytes: data.byteLength,
                });
                return data;
            } catch (error) {
                const timedOut = error instanceof SaveDocumentTimeoutError || isTimeoutError(error);
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
                    if (error instanceof SaveDocumentTimeoutError) {
                        throw error;
                    }
                    throw new SaveDocumentTimeoutError(Promise.resolve());
                }

                if (attempt === maxAttempts) {
                    throw error;
                }

                if (retryDelayMs > 0) {
                    await delay(retryDelayMs);
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
        getAnnotationCommentsForSave()
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
        const plan = buildAnnotationSavePlan(opts);
        return plan.route === 'source-replay';
    }

    function hasNativePdfMutationCapability() {
        return Boolean(trySavePdfNativeMutations) || Boolean(trySaveEmbeddedNoteTextUpdates);
    }

    function canPersistNativeMetadataMutations() {
        return Boolean(trySavePdfNativeMutations);
    }

    function logNativePdfMutationSkip(
        opts: {
            pendingTexts: Map<string, string> | null;
            pendingDeletes: IAnnotationCommentSummary[] | null;
            shapeStateDirty: boolean;
            forcePdfjsMaterialize: boolean;
            savedPdfjsAnnotationBaselineDirty?: boolean;
            includeManagedShapesForLiveSource: boolean;
            forceRewrite: boolean;
            pageLabelsDirty: boolean;
            bookmarksDirty: boolean;
        },
        event: string,
        reason: string,
        details: Record<string, unknown> = {},
    ) {
        BrowserLogger.debug('workspace', event, () => ({
            reason,
            pendingTexts: opts.pendingTexts?.size ?? 0,
            pendingDeletes: opts.pendingDeletes?.length ?? 0,
            shapeStateDirty: opts.shapeStateDirty,
            forcePdfjsMaterialize: opts.forcePdfjsMaterialize,
            savedPdfjsAnnotationBaselineDirty: opts.savedPdfjsAnnotationBaselineDirty,
            includeManagedShapesForLiveSource: opts.includeManagedShapesForLiveSource,
            forceRewrite: opts.forceRewrite,
            pageLabelsDirty: opts.pageLabelsDirty,
            bookmarksDirty: opts.bookmarksDirty,
            ...details,
        }));
    }

    function persistNativePdfMutationPlan(
        plan: INativePdfMutationPlan,
        opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource: boolean;
            expectedWorkingPath: TDocumentRef;
            modifiedAt: string;
        },
    ) {
        if (trySavePdfNativeMutations) {
            return trySavePdfNativeMutations(plan.mutations, opts);
        }
        if (plan.hasMetadataMutations || plan.hasShapeMutations || !trySaveEmbeddedNoteTextUpdates) {
            return Promise.resolve(null);
        }
        return trySaveEmbeddedNoteTextUpdates(plan.noteTextUpdates, {
            ...opts,
            ...(plan.freeTextNotes.length ? {freeTextNotes: plan.freeTextNotes} : {}),
            ...(plan.annotationDeletes.length ? {deletes: plan.annotationDeletes} : {}),
        });
    }

    function buildAnnotationSavePlan(opts?: ISerializationBasePdfBytesOptions) {
        const liveChanges = collectLivePdfJsAnnotationChangeIds(pdfDocument.value);
        const replayableIds = collectReplayableEmbeddedAnnotationIds(opts?.pendingTexts, opts?.pendingDeletes, liveChanges);
        if (opts?.forcePdfjsMaterialize) {
            return {
                route: 'pdfjs-materialize',
                expectedCost: 'full-document',
                reason: liveChanges.hasChanges
                    ? 'live-pdfjs-annotation-baseline-diverged'
                    : 'saved-pdfjs-annotation-baseline-diverged',
                unreplayableLiveAnnotationIds: Array.from(liveChanges.ids),
            } as const;
        }
        return buildPdfAnnotationSavePlan({
            hasPendingReplayableEmbeddedChanges: Boolean(opts?.pendingTexts?.size)
                || Boolean(opts?.pendingDeletes?.length)
                || replayableIds.size > 0,
            hasEditorOnlyAnnotationsPendingMaterialization: hasUnreplayableEditorOnlyAnnotationsPendingMaterialization(),
            liveAnnotationChanges: liveChanges,
            replayableEmbeddedAnnotationIds: replayableIds,
        });
    }

    async function getSerializationBasePdfBytes(opts?: ISerializationBasePdfBytesOptions) {
        const liveChanges = collectLivePdfJsAnnotationChangeIds(pdfDocument.value);
        const replayableIds = collectReplayableEmbeddedAnnotationIds(opts?.pendingTexts, opts?.pendingDeletes, liveChanges);
        const plan = buildAnnotationSavePlan(opts);

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
            forcePdfjsMaterialize: opts?.forcePdfjsMaterialize === true,
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
            if (
                error instanceof SaveDocumentTimeoutError
                && !await waitForTimedOutSaveDocumentToQuiesce(error)
            ) {
                throw error;
            }
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
        opts?: {
            completeSaveStateOnSuccess?: boolean;
            markShapeStateSavedOnSuccess?: boolean;
            preserveLivePdfjsSessionOnSuccess?: boolean;
            resetAnnotationStorageOnSuccess?: boolean;
        },
    ) {
        if (!saveSucceeded) {
            clearPendingPersistedShapeStateForNextReload?.();
            reloadWaiter?.cancel();
            return;
        }
        if (!reloadWaiter) {
            if (opts?.completeSaveStateOnSuccess) {
                completeSuccessfulSaveState({
                    markShapeStateSaved: opts.markShapeStateSavedOnSuccess,
                    preserveLivePdfjsSession: opts.preserveLivePdfjsSessionOnSuccess,
                    resetAnnotationStorage: opts.resetAnnotationStorageOnSuccess,
                });
            }
            return;
        }
        await reloadWaiter.promise.then(() => true).catch((error) => {
            BrowserLogger.warn('workspace', 'Saved PDF but failed to restore the reloaded view', error);
            return false;
        }).finally(() => {
            if (opts?.completeSaveStateOnSuccess) {
                completeSuccessfulSaveState({
                    markShapeStateSaved: opts.markShapeStateSavedOnSuccess,
                    preserveLivePdfjsSession: opts.preserveLivePdfjsSessionOnSuccess,
                    resetAnnotationStorage: opts.resetAnnotationStorageOnSuccess,
                });
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
            opts: IPersistSerializedOptions,
        ) => Promise<IPdfPersistResult>,
        preserveLoadedSource: boolean,
        expectedWorkingPath: TDocumentRef | null = null,
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
                () => persist(saveResult.finalBytes, {
                    saveMode: saveResult.saveMode,
                    preserveLoadedSource,
                    expectedWorkingPath,
                }),
                result => ({
                    bytes: saveResult.finalBytes.byteLength,
                    saveMode: saveResult.saveMode,
                    preserveLoadedSource,
                    success: result.success,
                    didSaveAs: result.didSaveAs,
                }),
            );
            if (finalizeSuccessfulSave(persisted, {
                completeSaveState: !reloadWaiter,
                markShapeStateSaved: !reloadWaiter,
                preserveLivePdfjsSession: preserveLoadedSource && !reloadWaiter,
            })) {
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

    function collectDocumentDirtyState(options: {
        hasPendingDeletes: boolean;
        hasPendingTexts: boolean;
        shapeStateDirty: boolean;
    }): IDocumentDirtyState {
        return {
            annotationChanges: hasAnnotationChanges(),
            annotationDirty: annotationDirty.value,
            bookmarks: bookmarksDirty.value,
            livePdfJsAnnotations: hasLivePdfJsAnnotationChanges?.() ?? false,
            pageLabels: pageLabelsDirty.value,
            pendingDeletes: options.hasPendingDeletes,
            pendingTexts: options.hasPendingTexts,
            preservedAnnotationSource: hasPreservedAnnotationSourceChanges?.() ?? false,
            savedPdfjsAnnotationBaseline: hasSavedPdfJsAnnotationBaselineChanges?.() ?? false,
            shapes: options.shapeStateDirty,
        };
    }

    function resolveExpectedWorkingPathForPersistence(
        initialWorkingPath: TDocumentRef | null,
        initialOriginalPath: TDocumentRef | null,
    ) {
        if (originalPath.value !== initialOriginalPath) {
            BrowserLogger.debug('workspace', 'Skipped stale serialized PDF persistence after save target changed', {
                initialOriginalPath,
                currentOriginalPath: originalPath.value,
                initialWorkingPath,
                currentWorkingPath: workingCopyPath.value,
            });
            return null;
        }

        return workingCopyPath.value ?? initialWorkingPath;
    }

    async function runSaveFlow(
        config: {
            mode: 'save' | 'save_as';
            operationKind: TDocumentOperationKind;
            saveMode: TPdfSaveMode;
            persistOpenNotesAbortMessage: string;
            totalPhase: 'handle-save-total' | 'handle-save-as-total';
            failureLogMessage: 'Save failed' | 'Save As failed' | 'Repair save failed';
            saveIndicator: Ref<boolean>;
            persistSerialized: (
                data: Uint8Array,
                opts: IPersistSerializedOptions,
            ) => Promise<IPdfPersistResult>;
            persistUnserialized: (opts: {
                saveMode: TPdfSaveMode;
                expectedWorkingPath?: TDocumentRef | null;
            }) => Promise<IPdfPersistResult>;
            shouldPreferWorkingCopy: boolean;
            forceSerialize?: boolean;
            forceRewrite?: boolean;
        },
    ) {
        if (hasSaveOperationInProgress()) {
            return false;
        }
        const saveStartedAtMs = nowMs();
        let saveSucceededForTelemetry = false;
        saveOperationInProgress = true;
        config.saveIndicator.value = true;
        let reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null = null;
        let finalizedReloadWaiter = false;
        let pendingTexts: Map<string, string> | null = null;
        let pendingDeletes: IAnnotationCommentSummary[] | null = null;
        const expectedWorkingPath = workingCopyPath.value;
        const expectedOriginalPath = originalPath.value;
        return runWithDocumentOperationLease(config.operationKind, async () => {
            try {
                if (!await persistOpenAnnotationNotes(config.persistOpenNotesAbortMessage)) {
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
                const shapeStateDirty = hasShapeChanges?.() ?? false;
                const dirtyState = collectDocumentDirtyState({
                    hasPendingTexts,
                    hasPendingDeletes,
                    shapeStateDirty,
                });
                const savedPdfjsAnnotationBaselineDirty = dirtyState.savedPdfjsAnnotationBaseline;
                const preservedAnnotationSourceDirty = dirtyState.preservedAnnotationSource;
                const shouldSerialize = computeShouldSerializeFlag(dirtyState) || config.forceSerialize === true;
                const preserveLivePdfjsAnnotationSession = shouldPreserveLiveAnnotationSession({
                    mode: config.mode,
                    shouldSerialize,
                    dirtyState,
                });
                reloadWaiter = preserveLivePdfjsAnnotationSession
                    ? null
                    : (preparePostSaveReload?.() ?? null);
                const forcePdfjsMaterialize = preservedAnnotationSourceDirty;
                const includeManagedShapesForLiveSource = forcePdfjsMaterialize && (hasManagedShapes?.() ?? false);
                const annotationCommentsSnapshot = getAnnotationCommentsForSave();

                if (config.mode === 'save') {
                    BrowserLogger.debug('workspace', 'Starting handleSave', () => ({
                        hasWorkingCopyPath: Boolean(workingCopyPath.value),
                        annotationDirty: annotationDirty.value,
                        pageLabelsDirty: pageLabelsDirty.value,
                        bookmarksDirty: bookmarksDirty.value,
                        hasAnnotationChanges: dirtyState.annotationChanges,
                        hasShapeChanges: shapeStateDirty,
                        hasPendingTexts,
                        hasPendingDeletes,
                        hasLivePdfJsAnnotationChanges: dirtyState.livePdfJsAnnotations,
                        forceSerialize: config.forceSerialize === true,
                        forceRewrite: config.forceRewrite === true,
                        preserveLivePdfjsAnnotationSession,
                        savedPdfjsAnnotationBaselineDirty,
                        preservedAnnotationSourceDirty,
                        includeManagedShapesForLiveSource,
                        annotationNoteWindowsCount: annotationNoteWindowsCount.value,
                    }));
                }

                let saveSucceeded = false;
                if (config.shouldPreferWorkingCopy && workingCopyPath.value && !shouldSerialize) {
                    saveSucceeded = await saveUnserializedWorkingCopy(
                        config.saveMode,
                        shapeStateDirty,
                        reloadWaiter,
                        config.mode,
                        config.persistUnserialized,
                        expectedWorkingPath,
                    );
                    clearSaveIndicator(config.mode);
                    await finalizeSaveReload(reloadWaiter, saveSucceeded, {
                        completeSaveStateOnSuccess: Boolean(reloadWaiter),
                        markShapeStateSavedOnSuccess: Boolean(reloadWaiter),
                        resetAnnotationStorageOnSuccess: false,
                    });
                    finalizedReloadWaiter = true;
                } else if (config.mode === 'save_as' && !shouldSerialize) {
                    saveSucceeded = await saveUnserializedWorkingCopy(
                        config.saveMode,
                        shapeStateDirty,
                        reloadWaiter,
                        config.mode,
                        config.persistUnserialized,
                        expectedWorkingPath,
                    );
                    clearSaveIndicator(config.mode);
                    await finalizeSaveReload(reloadWaiter, saveSucceeded, {
                        completeSaveStateOnSuccess: Boolean(reloadWaiter),
                        markShapeStateSavedOnSuccess: Boolean(reloadWaiter),
                        resetAnnotationStorageOnSuccess: false,
                    });
                    finalizedReloadWaiter = true;
                } else {
                    const totalPageCount = totalPages?.value ?? pdfDocument.value?.numPages ?? 0;
                    const annotationWorkDirty = dirtyState.annotationDirty || (dirtyState.annotationChanges && !dirtyState.shapes);
                    const annotationSavePlan = buildAnnotationSavePlan({
                        pendingTexts,
                        pendingDeletes,
                    });
                    const nativeMutationPlanContext = {
                        mode: config.mode,
                        pendingTexts,
                        pendingDeletes,
                        shapeStateDirty,
                        forcePdfjsMaterialize,
                        includeManagedShapesForLiveSource,
                        forceRewrite: config.forceRewrite === true,
                        savedPdfjsAnnotationBaselineDirty,
                        pageLabelsDirty: dirtyState.pageLabels,
                        bookmarksDirty: dirtyState.bookmarks,
                    };
                    const nativeMutationPlanResult = buildNativePdfMutationPlanForSave({
                        ...nativeMutationPlanContext,
                        annotationCommentsSnapshot,
                        hasNativePdfMutationCapability: hasNativePdfMutationCapability(),
                        annotationSavePlan,
                        annotationDirty: dirtyState.annotationDirty,
                        hasAnnotationChanges: dirtyState.annotationChanges,
                        hasLivePdfJsAnnotationChanges: dirtyState.livePdfJsAnnotations,
                        canPersistNativeMetadataMutations: canPersistNativeMetadataMutations(),
                        totalPageCount,
                        pageLabelRanges: pageLabelRanges?.value ?? null,
                        bookmarkItems: bookmarkItems?.value ?? null,
                        untitledBookmarkLabel,
                        shapes: shapeStateDirty ? getAllShapes?.() ?? null : null,
                        deletedEmbeddedShapeAnnotationIds: shapeStateDirty ? getDeletedEmbeddedShapeAnnotationIds?.() ?? [] : [],
                        deletedEmbeddedShapeStableKeys: shapeStateDirty ? getDeletedEmbeddedShapeStableKeys?.() ?? [] : [],
                        markupSubtypeOverrides: annotationWorkDirty ? getMarkupSubtypeOverrides?.() : undefined,
                        markupSubtypeHints: annotationWorkDirty ? getMarkupSubtypeHints?.() ?? [] : [],
                    });
                    nativeMutationPlanResult.skipEvents.forEach(({
                        event,
                        reason,
                        details,
                    }) => {
                        logNativePdfMutationSkip(nativeMutationPlanContext, event, reason, details);
                    });
                    const nativeMutationPlan = nativeMutationPlanResult.plan;
                    if (nativeMutationPlan) {
                        const persistenceExpectedWorkingPath = resolveExpectedWorkingPathForPersistence(
                            expectedWorkingPath,
                            expectedOriginalPath,
                        );
                        const preserveLiveSessionForNativeNoteChanges = true;
                        let preparedShapeStateSnapshot: unknown = null;
                        try {
                            const persisted = persistenceExpectedWorkingPath
                                ? await timedSavePhase(
                                    nativeMutationPlan.phase,
                                    () => persistNativePdfMutationPlan(nativeMutationPlan, {
                                        saveMode: config.saveMode,
                                        preserveLoadedSource: preserveLiveSessionForNativeNoteChanges,
                                        expectedWorkingPath: persistenceExpectedWorkingPath,
                                        modifiedAt: toPdfDateString(new Date()),
                                    }),
                                    result => ({
                                        applied: result !== null,
                                        success: result?.success ?? false,
                                        updateCount: nativeMutationPlan.noteTextUpdates.length,
                                        freeTextNoteCount: nativeMutationPlan.freeTextNotes.length,
                                        deleteCount: nativeMutationPlan.annotationDeletes.length,
                                        pageLabels: nativeMutationPlan.mutations.pageLabels !== undefined,
                                        bookmarks: nativeMutationPlan.mutations.bookmarks !== undefined,
                                        shapes: nativeMutationPlan.mutations.shapes?.shapes.length ?? 0,
                                        markupOverrides: nativeMutationPlan.mutations.markup?.overrides.length ?? 0,
                                        markupHints: nativeMutationPlan.mutations.markup?.hints.length ?? 0,
                                        preserveLoadedSource: preserveLiveSessionForNativeNoteChanges,
                                    }),
                                )
                                : null;
                            if (persisted) {
                                let canMarkShapeStateSaved = !nativeMutationPlan.hasShapeMutations;
                                if (nativeMutationPlan.hasShapeMutations) {
                                    const savedNativeBytes = await timedSavePhase(
                                        'read-native-shape-saved-bytes',
                                        getSourcePdfData,
                                        result => ({bytes: result?.byteLength ?? null}),
                                    );
                                    if (savedNativeBytes) {
                                        preparedShapeStateSnapshot = await primePersistedShapeStateForSave(
                                            savedNativeBytes,
                                            true,
                                        );
                                        canMarkShapeStateSaved = Boolean(preparedShapeStateSnapshot);
                                    }
                                }
                                armPersistedShapeStateAdoption(nativeMutationPlan.hasShapeMutations && canMarkShapeStateSaved);
                                if (reloadWaiter && preserveLiveSessionForNativeNoteChanges) {
                                    reloadWaiter.cancel();
                                    reloadWaiter = null;
                                }
                                clearSaveIndicator(config.mode);
                                saveSucceeded = finalizeSuccessfulSave(persisted, {
                                    completeSaveState: !reloadWaiter,
                                    markShapeStateSaved: !reloadWaiter && canMarkShapeStateSaved,
                                    preserveLivePdfjsSession: preserveLiveSessionForNativeNoteChanges && !reloadWaiter,
                                });
                                if (saveSucceeded) {
                                    preparedShapeStateSnapshot = null;
                                    if (nativeMutationPlan.freeTextNotes.length) {
                                        markNativeFreeTextNotesSaved?.(nativeMutationPlan.freeTextNotes);
                                    }
                                    if (nativeMutationPlan.annotationDeletes.length) {
                                        markNativeFreeTextNotesDeleted?.(nativeMutationPlan.annotationDeletes);
                                    }
                                    trackSaveCompleted(config.mode, persisted, true);
                                }
                                await finalizeSaveReload(reloadWaiter, saveSucceeded, {
                                    completeSaveStateOnSuccess: Boolean(reloadWaiter),
                                    markShapeStateSavedOnSuccess: Boolean(reloadWaiter) && canMarkShapeStateSaved,
                                    preserveLivePdfjsSessionOnSuccess: preserveLiveSessionForNativeNoteChanges && Boolean(reloadWaiter),
                                });
                                finalizedReloadWaiter = true;
                            }
                        } finally {
                            await restorePreparedShapeState(preparedShapeStateSnapshot);
                        }
                    }
                }

                if (!finalizedReloadWaiter) {
                    const rawData = await getSerializationBasePdfBytes({
                        forcePdfjsMaterialize: forcePdfjsMaterialize || savedPdfjsAnnotationBaselineDirty,
                        pendingDeletes,
                        pendingTexts,
                    });
                    const persistenceExpectedWorkingPath = resolveExpectedWorkingPathForPersistence(
                        expectedWorkingPath,
                        expectedOriginalPath,
                    );
                    if (persistenceExpectedWorkingPath) {
                        saveSucceeded = await runSerializedSaveFlow(
                            rawData,
                            pendingTexts,
                            pendingDeletes,
                            annotationCommentsSnapshot,
                            shapeStateDirty,
                            reloadWaiter,
                            config.mode,
                            config.saveMode,
                            config.persistSerialized,
                            preserveLivePdfjsAnnotationSession,
                            includeManagedShapesForLiveSource,
                            config.forceRewrite === true,
                            persistenceExpectedWorkingPath,
                            () => clearSaveIndicator(config.mode),
                        );
                    }
                    finalizedReloadWaiter = true;
                }

                if (!saveSucceeded) {
                    restorePendingEmbeddedAnnotationChanges(pendingTexts, pendingDeletes);
                }
                saveSucceededForTelemetry = saveSucceeded;
                return saveSucceeded;
            } catch (error) {
                restorePendingEmbeddedAnnotationChanges(pendingTexts, pendingDeletes);
                BrowserLogger.error('workspace', config.failureLogMessage, error);
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
        annotationCommentsSnapshot: IAnnotationCommentSummary[],
        shapeStateDirty: boolean,
        includeManagedShapesForLiveSource: boolean,
        forceRewrite: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        saveMode: TPdfSaveMode,
        persist: (
            data: Uint8Array,
            opts: IPersistSerializedOptions,
        ) => Promise<IPdfPersistResult>,
        preserveLoadedSource = false,
        expectedWorkingPath: TDocumentRef | null = null,
    ) {
        if (!rawData) {
            return false;
        }

        const saveResult = await buildSerializedSaveResult(rawData, pendingTexts, pendingDeletes, {
            includeShapes: shapeStateDirty || includeManagedShapesForLiveSource,
            rewriteShapeState: shapeStateDirty,
            forceRewrite,
            saveMode,
            annotationCommentsSnapshot,
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
            preserveLoadedSource,
            expectedWorkingPath,
        );
    }

    async function saveUnserializedWorkingCopy(
        saveMode: TPdfSaveMode,
        shapeStateDirty: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        persist: (opts: {
            saveMode: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
        }) => Promise<IPdfPersistResult>,
        expectedWorkingPath: TDocumentRef | null,
    ) {
        const saveResult = await validateWorkingCopySnapshot(saveMode);
        if (!saveResult) {
            return false;
        }
        if (saveResult.workingPath !== expectedWorkingPath) {
            BrowserLogger.debug('workspace', 'Skipped stale working-copy persistence after validation', {
                expectedWorkingPath,
                validatedPath: saveResult.workingPath,
                currentWorkingPath: workingCopyPath.value,
                saveMode,
            });
            return false;
        }

        armPersistedShapeStateAdoption(shapeStateDirty);
        const persisted = await timedSavePhase(
            `persist-${mode}-working-copy`,
            () => persist({
                saveMode: saveResult.saveMode,
                expectedWorkingPath,
            }),
            result => ({
                saveMode: saveResult.saveMode,
                success: result.success,
                didSaveAs: result.didSaveAs,
            }),
        );
        if (!finalizeSuccessfulSave(persisted, {
            completeSaveState: !reloadWaiter,
            markShapeStateSaved: !reloadWaiter,
            resetAnnotationStorage: false,
        })) {
            return false;
        }

        trackSaveCompleted(mode, persisted, false);
        return true;
    }

    function computeShouldSerializeFlag(dirtyState: IDocumentDirtyState) {
        return Object.values(SHOULD_SERIALIZE_DIRTY_SOURCES).some(hasDirtySource => hasDirtySource(dirtyState));
    }

    function shouldPreserveLiveAnnotationSession(options: {
        mode: 'save' | 'save_as';
        shouldSerialize: boolean;
        dirtyState: IDocumentDirtyState;
    }) {
        // Embedded deletes need the saved PDF bytes to become the live source;
        // otherwise old PDF.js annotations can outlive their persisted removal.
        return options.mode === 'save'
            && options.shouldSerialize
            && !options.dirtyState.pendingDeletes
            && !options.dirtyState.pageLabels
            && !options.dirtyState.bookmarks
            && (
                options.dirtyState.shapes
                || options.dirtyState.pendingTexts
                || options.dirtyState.livePdfJsAnnotations
                || options.dirtyState.preservedAnnotationSource
                || options.dirtyState.annotationChanges
            );
    }

    async function runSerializedSaveFlow(
        rawData: Uint8Array | null,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        annotationCommentsSnapshot: IAnnotationCommentSummary[],
        shapeStateDirty: boolean,
        reloadWaiter: ReturnType<NonNullable<IFileOperationsDeps['preparePostSaveReload']>> | null,
        mode: 'save' | 'save_as',
        saveMode: TPdfSaveMode,
        persist: (
            data: Uint8Array,
            opts: IPersistSerializedOptions,
        ) => Promise<IPdfPersistResult>,
        preserveLoadedSource = false,
        includeManagedShapesForLiveSource = false,
        forceRewrite = false,
        expectedWorkingPath: TDocumentRef | null,
        onPersistenceSettled?: () => void,
    ) {
        const saveSucceeded = await saveSerializedChanges(
            rawData,
            pendingTexts,
            pendingDeletes,
            annotationCommentsSnapshot,
            shapeStateDirty,
            includeManagedShapesForLiveSource,
            forceRewrite,
            reloadWaiter,
            mode,
            saveMode,
            persist,
            preserveLoadedSource,
            expectedWorkingPath,
        );
        onPersistenceSettled?.();
        await finalizeSaveReload(reloadWaiter, saveSucceeded, {
            completeSaveStateOnSuccess: Boolean(reloadWaiter),
            markShapeStateSavedOnSuccess: Boolean(reloadWaiter),
        });
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
        return runSaveFlow({
            mode: 'save',
            operationKind: 'save',
            saveMode: 'rewrite',
            persistOpenNotesAbortMessage: 'Save aborted because annotation note persistence failed',
            totalPhase: 'handle-save-total',
            failureLogMessage: 'Save failed',
            saveIndicator: isSaving,
            persistSerialized: saveFile,
            persistUnserialized: saveWorkingCopy,
            shouldPreferWorkingCopy: true,
        });
    }

    async function handleSaveAs() {
        return runSaveFlow({
            mode: 'save_as',
            operationKind: 'save-as',
            saveMode: 'save_as_rewrite',
            persistOpenNotesAbortMessage: 'Save As aborted because annotation note persistence failed',
            totalPhase: 'handle-save-as-total',
            failureLogMessage: 'Save As failed',
            saveIndicator: isSavingAs,
            persistSerialized: saveWorkingCopyAs,
            persistUnserialized: opts => saveWorkingCopyAs(undefined, opts),
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
            saveIndicator: isSaving,
            persistSerialized: saveFile,
            persistUnserialized: saveWorkingCopy,
            shouldPreferWorkingCopy: true,
            forceSerialize: true,
            forceRewrite: true,
        });
    }

    return {
        handleSave,
        handleRepairSave,
        handleSaveAs,
    };
};
