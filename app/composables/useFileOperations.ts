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
    IPdfNativeMarkupSubtypeHint,
    IPdfNativeMutationSet,
    IPdfNativeShapeAnnotation,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import { isTimeoutError } from '@contracts/isTimeoutError';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    delay,
    withTimeout,
} from 'es-toolkit/promise';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useAnalytics } from '@app/composables/useAnalytics';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import { toFreeTextNoteMarkerRect } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shared/toFreeTextNoteMarkerRect';
import { mergeAnnotationCommentSaveSnapshot } from '@app/utils/pdf-viewer/annotation-comment-save-snapshot/mergeAnnotationCommentSaveSnapshot';
import { getErrorMessage } from '@app/utils/error';
import { buildPdfAnnotationSavePlan } from '@app/services/pdf-save/buildPdfAnnotationSavePlan';
import { collectLivePdfJsAnnotationChangeIds } from '@app/services/pdf-save/pdfAnnotationStorageChanges';
import { normalizeAnnotationSubtypeToken } from '@app/utils/textNormalization';
import { toPdfDateString } from '@app/utils/pdfDate';
import { normalizePageLabelRanges } from '@app/utils/pdfPageLabels';
import { collectMarkupSubtypeHints } from '@app/utils/pdf-viewer/pdf-serialization-subtype-hints/collectMarkupSubtypeHints';
import type { IMarkupSubtypeHint } from '@app/utils/pdf-viewer/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';

const SLOW_SAVE_PHASE_WARN_MS = 5_000;
const SLOW_SAVE_TOTAL_WARN_MS = 10_000;
const NATIVE_NOTE_TEXT_UPDATE_SUBTYPES = new Set([
    'text',
    'popup',
    'note',
    'freetext',
    'highlight',
    'underline',
    'strikeout',
    'squiggly',
]);
const NATIVE_SHAPE_TYPES = new Set([
    'rectangle',
    'circle',
    'line',
    'arrow',
    'polyline',
    'polygon',
]);
const NATIVE_SHAPE_PDF_SUBTYPES = new Set([
    'Square',
    'Circle',
    'Line',
    'PolyLine',
    'Polygon',
    'Ink',
]);
const NATIVE_SHAPE_LINE_END_STYLES = new Set([
    'none',
    'openArrow',
    'closedArrow',
]);
const NATIVE_MARKUP_SUBTYPES = new Set<TMarkupSubtype>([
    'Highlight',
    'Underline',
    'StrikeOut',
    'Squiggly',
]);

interface IPersistSerializedOptions {
    saveMode: TPdfSaveMode;
    preserveLoadedSource?: boolean;
    expectedWorkingPath?: TDocumentRef | null;
}

class SaveDocumentTimeoutError extends Error {
    constructor() {
        super('PDF.js saveDocument timed out');
        this.name = 'SaveDocumentTimeoutError';
    }
}

interface ISerializationBasePdfBytesOptions {
    forcePdfjsMaterialize?: boolean;
    pendingDeletes?: IAnnotationCommentSummary[] | null;
    pendingTexts?: Map<string, string> | null;
}

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

    function isReplayableEditorOnlyFreeTextNote(comment: IAnnotationCommentSummary) {
        const subtype = comment.subtype?.trim().toLowerCase();
        return comment.source === 'editor'
            && !parsePdfJsAnnotationRef(comment.annotationId)
            && Boolean(comment.hasNote)
            && Boolean(normalizeMarkerRect(comment.markerRect))
            && (subtype === 'freetext' || subtype === 'typewriter');
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

    function parseAnnotationRefFromStableKey(stableKey: string) {
        const match = stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/iu);
        return parsePdfJsAnnotationRef(match?.[1]);
    }

    function resolveNativeNoteTextUpdateRef(stableKey: string, comment: IAnnotationCommentSummary) {
        return parseAnnotationRefFromStableKey(stableKey)
            ?? parseAnnotationRefFromStableKey(comment.stableKey)
            ?? parsePdfJsAnnotationRef(comment.annotationId);
    }

    function resolveNativeAnnotationDeleteRef(comment: IAnnotationCommentSummary) {
        return parseAnnotationRefFromStableKey(comment.stableKey)
            ?? parsePdfJsAnnotationRef(comment.annotationId)
            ?? parsePdfJsAnnotationRef(comment.uid)
            ?? parsePdfJsAnnotationRef(comment.id);
    }

    function buildNativeNoteTextCommentLookup(comments: IAnnotationCommentSummary[]) {
        const commentsByKey = new Map<string, IAnnotationCommentSummary>();
        const addCommentKey = (key: string | null | undefined, comment: IAnnotationCommentSummary) => {
            const normalized = key?.trim();
            if (normalized && !commentsByKey.has(normalized)) {
                commentsByKey.set(normalized, comment);
            }
        };

        comments.forEach((comment) => {
            addCommentKey(comment.stableKey, comment);
            const normalizedAnnotationId = normalizePdfJsAnnotationId(comment.annotationId);
            addCommentKey(normalizedAnnotationId, comment);
            if (normalizedAnnotationId) {
                addCommentKey(`ann:${comment.pageIndex}:${normalizedAnnotationId}`, comment);
            }
        });

        return commentsByKey;
    }

    function isNativeNoteTextUpdateSubtype(comment: IAnnotationCommentSummary) {
        const normalizedSubtype = normalizeAnnotationSubtypeToken(comment.subtype);
        return NATIVE_NOTE_TEXT_UPDATE_SUBTYPES.has(normalizedSubtype);
    }

    function hasNativePdfMutationCapability() {
        return Boolean(trySavePdfNativeMutations || trySaveEmbeddedNoteTextUpdates);
    }

    function canPersistNativeMetadataMutations() {
        return Boolean(trySavePdfNativeMutations);
    }

    function buildNativeNoteTextUpdatesForSave(opts: {
        mode: 'save' | 'save_as';
        pendingTexts: Map<string, string> | null;
        pendingDeletes: IAnnotationCommentSummary[] | null;
        annotationCommentsSnapshot: IAnnotationCommentSummary[];
        shapeStateDirty: boolean;
        forcePdfjsMaterialize: boolean;
        includeManagedShapesForLiveSource: boolean;
        forceRewrite: boolean;
    }) {
        const skip = (reason: string, details: Record<string, unknown> = {}) => {
            BrowserLogger.debug('workspace', 'Skipped native note-text save fast path', () => ({
                reason,
                pendingTexts: opts.pendingTexts?.size ?? 0,
                pendingDeletes: opts.pendingDeletes?.length ?? 0,
                shapeStateDirty: opts.shapeStateDirty,
                forcePdfjsMaterialize: opts.forcePdfjsMaterialize,
                includeManagedShapesForLiveSource: opts.includeManagedShapesForLiveSource,
                forceRewrite: opts.forceRewrite,
                pageLabelsDirty: pageLabelsDirty.value,
                bookmarksDirty: bookmarksDirty.value,
                ...details,
            }));
            return null;
        };

        if (opts.mode !== 'save') {
            return skip('not-save-mode', { mode: opts.mode });
        }
        if (!hasNativePdfMutationCapability()) {
            return skip('native-save-capability-unavailable');
        }
        if (!opts.pendingTexts?.size) {
            return skip('no-pending-text-updates');
        }
        if (opts.forcePdfjsMaterialize) {
            return skip('pdfjs-materialize-required');
        }
        if (opts.includeManagedShapesForLiveSource) {
            return skip('managed-shapes-require-materialization');
        }
        if (opts.forceRewrite) {
            return skip('rewrite-forced');
        }
        const plan = buildAnnotationSavePlan({
            pendingTexts: opts.pendingTexts,
            pendingDeletes: opts.pendingDeletes,
        });
        if (plan.route !== 'source-replay') {
            return skip('annotation-save-route-not-source-replay', {
                route: plan.route,
                reason: plan.reason,
            });
        }

        const commentsByStableKey = buildNativeNoteTextCommentLookup(opts.annotationCommentsSnapshot);
        const updatesByRef = new Map<string, IPdfNoteTextUpdate>();
        const updates: IPdfNoteTextUpdate[] = [];
        for (const [
            stableKey,
            text,
        ] of opts.pendingTexts.entries()) {
            const comment = commentsByStableKey.get(stableKey);
            const targetRef = comment ? resolveNativeNoteTextUpdateRef(stableKey, comment) : null;
            if (
                !comment
                || comment.source !== 'pdf'
                || !isNativeNoteTextUpdateSubtype(comment)
                || !targetRef
                || targetRef.generationNumber > 65_535
            ) {
                return skip('pending-text-not-native-eligible', {
                    stableKey,
                    hasComment: Boolean(comment),
                    source: comment?.source ?? null,
                    subtype: comment?.subtype ?? null,
                    targetRef,
                });
            }
            const refKey = `${targetRef.objectNumber}R${targetRef.generationNumber}`;
            const existing = updatesByRef.get(refKey);
            if (existing) {
                if (existing.text !== text) {
                    return skip('conflicting-native-note-text-aliases', {
                        stableKey,
                        objectNumber: targetRef.objectNumber,
                        generationNumber: targetRef.generationNumber,
                    });
                }
                continue;
            }
            const update = {
                objectNumber: targetRef.objectNumber,
                generationNumber: targetRef.generationNumber,
                text,
            };
            updatesByRef.set(refKey, update);
            updates.push(update);
        }

        return updates.length > 0 ? updates : null;
    }

    function toNativeFreeTextNote(comment: IAnnotationCommentSummary): IPdfNativeFreeTextNote | null {
        const markerRect = toFreeTextNoteMarkerRect(comment.markerRect);
        const stableKey = comment.stableKey?.trim();
        if (!markerRect || !stableKey) {
            return null;
        }

        return {
            pageIndex: comment.pageIndex,
            stableKey,
            text: comment.text ?? '',
            markerRect,
            author: comment.author ?? null,
            color: comment.color ?? null,
            createdAt: typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
                ? Math.trunc(comment.createdAt)
                : null,
        };
    }

    function buildNativeFreeTextNotesForSave(opts: {
        mode: 'save' | 'save_as';
        pendingTexts: Map<string, string> | null;
        pendingDeletes: IAnnotationCommentSummary[] | null;
        annotationCommentsSnapshot: IAnnotationCommentSummary[];
        shapeStateDirty: boolean;
        forcePdfjsMaterialize: boolean;
        includeManagedShapesForLiveSource: boolean;
        forceRewrite: boolean;
    }) {
        const skip = (reason: string, details: Record<string, unknown> = {}) => {
            BrowserLogger.debug('workspace', 'Skipped native FreeText note save fast path', () => ({
                reason,
                pendingTexts: opts.pendingTexts?.size ?? 0,
                pendingDeletes: opts.pendingDeletes?.length ?? 0,
                shapeStateDirty: opts.shapeStateDirty,
                forcePdfjsMaterialize: opts.forcePdfjsMaterialize,
                includeManagedShapesForLiveSource: opts.includeManagedShapesForLiveSource,
                forceRewrite: opts.forceRewrite,
                pageLabelsDirty: pageLabelsDirty.value,
                bookmarksDirty: bookmarksDirty.value,
                ...details,
            }));
            return null;
        };

        if (opts.mode !== 'save') {
            return skip('not-save-mode', {mode: opts.mode});
        }
        if (!hasNativePdfMutationCapability()) {
            return skip('native-save-capability-unavailable');
        }
        if (opts.forcePdfjsMaterialize) {
            return skip('pdfjs-materialize-required');
        }
        if (opts.includeManagedShapesForLiveSource) {
            return skip('managed-shapes-require-materialization');
        }
        if (opts.forceRewrite) {
            return skip('rewrite-forced');
        }
        const candidates = opts.annotationCommentsSnapshot
            .filter(isReplayableEditorOnlyFreeTextNote)
            .map(toNativeFreeTextNote)
            .filter((note): note is IPdfNativeFreeTextNote => note !== null);
        if (candidates.length === 0) {
            return skip('no-replayable-editor-free-text-notes');
        }

        const plan = buildAnnotationSavePlan({
            pendingTexts: opts.pendingTexts,
            pendingDeletes: opts.pendingDeletes,
        });
        if (plan.route !== 'source-replay') {
            return skip('annotation-save-route-not-source-replay', {
                route: plan.route,
                reason: plan.reason,
            });
        }

        const notesByStableKey = new Map<string, IPdfNativeFreeTextNote>();
        for (const note of candidates) {
            const existing = notesByStableKey.get(note.stableKey);
            if (existing) {
                if (
                    existing.text !== note.text
                    || existing.pageIndex !== note.pageIndex
                    || existing.createdAt !== note.createdAt
                ) {
                    return skip('conflicting-native-free-text-note-aliases', {stableKey: note.stableKey});
                }
                continue;
            }
            notesByStableKey.set(note.stableKey, note);
        }

        return Array.from(notesByStableKey.values());
    }

    function buildNativeAnnotationDeletesForSave(opts: {
        mode: 'save' | 'save_as';
        pendingTexts: Map<string, string> | null;
        pendingDeletes: IAnnotationCommentSummary[] | null;
        shapeStateDirty: boolean;
        forcePdfjsMaterialize: boolean;
        includeManagedShapesForLiveSource: boolean;
        forceRewrite: boolean;
    }) {
        const skip = (reason: string, details: Record<string, unknown> = {}) => {
            BrowserLogger.debug('workspace', 'Skipped native annotation delete fast path', () => ({
                reason,
                pendingTexts: opts.pendingTexts?.size ?? 0,
                pendingDeletes: opts.pendingDeletes?.length ?? 0,
                shapeStateDirty: opts.shapeStateDirty,
                forcePdfjsMaterialize: opts.forcePdfjsMaterialize,
                includeManagedShapesForLiveSource: opts.includeManagedShapesForLiveSource,
                forceRewrite: opts.forceRewrite,
                pageLabelsDirty: pageLabelsDirty.value,
                bookmarksDirty: bookmarksDirty.value,
                ...details,
            }));
            return null;
        };

        if (!opts.pendingDeletes?.length) {
            return [];
        }
        if (opts.mode !== 'save') {
            return skip('not-save-mode', {mode: opts.mode});
        }
        if (!hasNativePdfMutationCapability()) {
            return skip('native-save-capability-unavailable');
        }
        if (opts.forcePdfjsMaterialize) {
            return skip('pdfjs-materialize-required');
        }
        if (opts.includeManagedShapesForLiveSource) {
            return skip('managed-shapes-require-materialization');
        }
        if (opts.forceRewrite) {
            return skip('rewrite-forced');
        }
        const plan = buildAnnotationSavePlan({
            pendingTexts: opts.pendingTexts,
            pendingDeletes: opts.pendingDeletes,
        });
        if (plan.route !== 'source-replay') {
            return skip('annotation-save-route-not-source-replay', {
                route: plan.route,
                reason: plan.reason,
            });
        }

        const deletesByRef = new Map<string, IPdfNativeAnnotationDelete>();
        const deletesByStableKey = new Map<string, IPdfNativeAnnotationDelete>();
        for (const comment of opts.pendingDeletes) {
            const targetRef = resolveNativeAnnotationDeleteRef(comment);
            const stableKey = comment.stableKey?.trim();
            if (
                !targetRef
                && stableKey
                && isReplayableEditorOnlyFreeTextNote(comment)
            ) {
                const existing = deletesByStableKey.get(stableKey);
                if (existing) {
                    if (existing.pageIndex !== comment.pageIndex) {
                        return skip('conflicting-native-delete-pages', {stableKey});
                    }
                    continue;
                }
                deletesByStableKey.set(stableKey, {
                    pageIndex: comment.pageIndex,
                    stableKey,
                    createdAt: typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
                        ? Math.trunc(comment.createdAt)
                        : null,
                });
                continue;
            }
            if (
                !targetRef
                || targetRef.generationNumber > 65_535
                || !Number.isSafeInteger(comment.pageIndex)
                || comment.pageIndex < 0
            ) {
                return skip('pending-delete-not-native-eligible', {
                    stableKey: comment.stableKey,
                    source: comment.source,
                    subtype: comment.subtype ?? null,
                    annotationId: comment.annotationId ?? null,
                    targetRef,
                });
            }

            const refKey = `${targetRef.objectNumber}R${targetRef.generationNumber}`;
            const deleteRequest = {
                pageIndex: comment.pageIndex,
                objectNumber: targetRef.objectNumber,
                generationNumber: targetRef.generationNumber,
            };
            const existing = deletesByRef.get(refKey);
            if (existing) {
                if (existing.pageIndex !== deleteRequest.pageIndex) {
                    return skip('conflicting-native-delete-pages', {
                        stableKey: comment.stableKey,
                        objectNumber: targetRef.objectNumber,
                        generationNumber: targetRef.generationNumber,
                    });
                }
                continue;
            }
            deletesByRef.set(refKey, deleteRequest);
        }

        return [
            ...Array.from(deletesByRef.values()),
            ...Array.from(deletesByStableKey.values()),
        ];
    }

    function arePendingTextsCoveredByNativeChanges(opts: {
        pendingTexts: Map<string, string> | null;
        annotationCommentsSnapshot: IAnnotationCommentSummary[];
        nativeNoteTextUpdates: IPdfNoteTextUpdate[] | null;
        nativeFreeTextNotes: IPdfNativeFreeTextNote[] | null;
    }) {
        if (!opts.pendingTexts?.size) {
            return true;
        }

        const freeTextNotesByStableKey = new Map(
            (opts.nativeFreeTextNotes ?? []).map(note => [
                note.stableKey,
                note,
            ]),
        );
        const updateRefs = new Set(
            (opts.nativeNoteTextUpdates ?? []).map(update =>
                `${update.objectNumber}R${update.generationNumber}`,
            ),
        );
        const commentsByStableKey = buildNativeNoteTextCommentLookup(opts.annotationCommentsSnapshot);

        for (const [
            stableKey,
            text,
        ] of opts.pendingTexts.entries()) {
            const freeTextNote = freeTextNotesByStableKey.get(stableKey.trim());
            if (freeTextNote?.text === text) {
                continue;
            }

            const comment = commentsByStableKey.get(stableKey);
            const targetRef = comment ? resolveNativeNoteTextUpdateRef(stableKey, comment) : null;
            if (
                targetRef
                && updateRefs.has(`${targetRef.objectNumber}R${targetRef.generationNumber}`)
            ) {
                continue;
            }

            return false;
        }

        return true;
    }

    interface INativePdfMutationPlan {
        mutations: IPdfNativeMutationSet;
        noteTextUpdates: IPdfNoteTextUpdate[];
        freeTextNotes: IPdfNativeFreeTextNote[];
        annotationDeletes: IPdfNativeAnnotationDelete[];
        hasMetadataMutations: boolean;
        hasShapeMutations: boolean;
        hasMarkupMutations: boolean;
        phase: string;
    }

    function buildNativePageLabelsMutationForSave() {
        if (!pageLabelsDirty.value) {
            return null;
        }
        const totalPageCount = totalPages?.value ?? pdfDocument.value?.numPages ?? 0;
        if (!pageLabelRanges || totalPageCount <= 0) {
            return null;
        }
        return {
            totalPages: totalPageCount,
            ranges: normalizePageLabelRanges(pageLabelRanges.value, totalPageCount),
        };
    }

    function buildNativeBookmarksMutationForSave() {
        if (!bookmarksDirty.value) {
            return null;
        }
        const totalPageCount = totalPages?.value ?? pdfDocument.value?.numPages ?? 0;
        if (!bookmarkItems || totalPageCount <= 0) {
            return null;
        }
        return {
            totalPages: totalPageCount,
            untitledLabel: untitledBookmarkLabel,
            items: bookmarkItems.value,
        };
    }

    function isFiniteUnitNumber(value: unknown) {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    }

    function isFiniteNonNegativeNumber(value: unknown) {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    }

    function areNativeShapePointsEligible(points: IShapeAnnotation['points']) {
        return Array.isArray(points)
            && points.length >= 2
            && points.every(point => isFiniteUnitNumber(point.x) && isFiniteUnitNumber(point.y));
    }

    function areNativeShapeStrokesEligible(strokes: IShapeAnnotation['strokes']) {
        return Array.isArray(strokes)
            && strokes.length > 0
            && strokes.every(points => areNativeShapePointsEligible(points));
    }

    function hasNativeShapeRectGeometry(shape: IShapeAnnotation) {
        return isFiniteUnitNumber(shape.x)
            && isFiniteUnitNumber(shape.y)
            && isFiniteNonNegativeNumber(shape.width)
            && isFiniteNonNegativeNumber(shape.height)
            && shape.width > 0
            && shape.height > 0
            && shape.x + shape.width <= 1
            && shape.y + shape.height <= 1;
    }

    function hasNativeShapeLineGeometry(shape: IShapeAnnotation) {
        return isFiniteUnitNumber(shape.x)
            && isFiniteUnitNumber(shape.y)
            && isFiniteUnitNumber(shape.x2)
            && isFiniteUnitNumber(shape.y2);
    }

    function isNativeShapeEligible(shape: IShapeAnnotation, totalPageCount: number) {
        if (
            !NATIVE_SHAPE_TYPES.has(shape.type)
            || !Number.isSafeInteger(shape.pageIndex)
            || shape.pageIndex < 0
            || shape.pageIndex >= totalPageCount
            || typeof shape.color !== 'string'
            || !isFiniteNonNegativeNumber(shape.strokeWidth)
            || !isFiniteUnitNumber(shape.opacity)
            || (
                shape.pdfSubtype !== undefined
                && shape.pdfSubtype !== null
                && !NATIVE_SHAPE_PDF_SUBTYPES.has(shape.pdfSubtype)
            )
            || (
                shape.lineStartStyle !== undefined
                && !NATIVE_SHAPE_LINE_END_STYLES.has(shape.lineStartStyle)
            )
            || (
                shape.lineEndStyle !== undefined
                && !NATIVE_SHAPE_LINE_END_STYLES.has(shape.lineEndStyle)
            )
        ) {
            return false;
        }

        if (shape.type === 'rectangle' || shape.type === 'circle') {
            return hasNativeShapeRectGeometry(shape);
        }
        if (shape.type === 'line' || shape.type === 'arrow') {
            return hasNativeShapeLineGeometry(shape);
        }
        if (shape.pdfSubtype === 'Ink') {
            return areNativeShapeStrokesEligible(shape.strokes)
                || areNativeShapePointsEligible(shape.points);
        }
        return areNativeShapePointsEligible(shape.points);
    }

    function toNativeShapeAnnotation(shape: IShapeAnnotation): IPdfNativeShapeAnnotation {
        const nativeShape: IPdfNativeShapeAnnotation = {
            id: shape.id,
            type: shape.type,
            pageIndex: shape.pageIndex,
            x: shape.x,
            y: shape.y,
            width: shape.width,
            height: shape.height,
            x2: shape.x2 ?? null,
            y2: shape.y2 ?? null,
            color: shape.color,
            fillColor: shape.fillColor ?? null,
            opacity: shape.opacity,
            strokeWidth: shape.strokeWidth,
            annotationId: normalizePdfJsAnnotationId(shape.annotationId) ?? null,
            stableKey: shape.stableKey ?? null,
            pdfSubtype: shape.pdfSubtype ?? null,
            lineStartStyle: shape.lineStartStyle ?? null,
            lineEndStyle: shape.lineEndStyle ?? null,
            createdAt: typeof shape.createdAt === 'number' && Number.isFinite(shape.createdAt)
                ? Math.trunc(shape.createdAt)
                : null,
            modifiedAt: typeof shape.modifiedAt === 'number' && Number.isFinite(shape.modifiedAt)
                ? Math.trunc(shape.modifiedAt)
                : null,
        };
        if (shape.points) {
            nativeShape.points = shape.points.map(point => ({...point}));
        }
        if (shape.strokes) {
            nativeShape.strokes = shape.strokes.map(points => points.map(point => ({...point})));
        }
        return nativeShape;
    }

    function buildNativeShapesMutationForSave(shapeStateDirty: boolean) {
        if (!shapeStateDirty) {
            return null;
        }
        const totalPageCount = totalPages?.value ?? pdfDocument.value?.numPages ?? 0;
        const shapes = getAllShapes?.() ?? null;
        if (!shapes || totalPageCount <= 0) {
            return null;
        }
        if (!shapes.every(shape => isNativeShapeEligible(shape, totalPageCount))) {
            return null;
        }

        return {
            totalPages: totalPageCount,
            rewriteShapeState: true,
            shapes: shapes.map(toNativeShapeAnnotation),
            deletedAnnotationIds: getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
            deletedStableKeys: getDeletedEmbeddedShapeStableKeys?.() ?? [],
        };
    }

    function isNativeMarkupSubtype(value: unknown): value is TMarkupSubtype {
        return typeof value === 'string' && NATIVE_MARKUP_SUBTYPES.has(value as TMarkupSubtype);
    }

    function isNativeMarkupHintEligible(hint: IMarkupSubtypeHint) {
        return isNativeMarkupSubtype(hint.subtype)
            && Number.isSafeInteger(hint.pageIndex)
            && hint.pageIndex >= 0
            && Boolean(normalizeMarkerRect(hint.markerRect));
    }

    function toNativeMarkupHint(hint: IMarkupSubtypeHint): IPdfNativeMarkupSubtypeHint | null {
        if (!isNativeMarkupHintEligible(hint)) {
            return null;
        }
        const markerRect = normalizeMarkerRect(hint.markerRect);
        if (!markerRect) {
            return null;
        }
        return {
            subtype: hint.subtype,
            pageIndex: hint.pageIndex,
            markerRect,
            annotationId: hint.annotationId ?? null,
            color: hint.color ?? null,
            id: hint.id ?? null,
            pageMarkupIndex: typeof hint.pageMarkupIndex === 'number' && Number.isSafeInteger(hint.pageMarkupIndex)
                ? hint.pageMarkupIndex
                : null,
            source: hint.source ?? null,
        };
    }

    function buildNativeMarkupMutationForSave(
        annotationCommentsSnapshot: IAnnotationCommentSummary[],
        annotationWorkDirty: boolean,
    ) {
        if (!annotationWorkDirty) {
            return null;
        }
        const overrides = Array.from(getMarkupSubtypeOverrides?.()?.entries() ?? [])
            .filter((entry): entry is [string, TMarkupSubtype] =>
                typeof entry[0] === 'string'
                && entry[0].trim().length > 0
                && isNativeMarkupSubtype(entry[1]))
            .map(([
                id,
                subtype,
            ]) => [
                id.trim(),
                subtype,
            ] as const);
        const liveHints = (getMarkupSubtypeHints?.() ?? [])
            .map(toNativeMarkupHint)
            .filter((hint): hint is IPdfNativeMarkupSubtypeHint => hint !== null);
        const editedCommentHints = collectMarkupSubtypeHints(annotationCommentsSnapshot)
            // Full rewrites need all preservation hints; incremental native markup should touch
            // only hints that represent a user-visible markup edit.
            .filter(hint => hint.color !== null || hint.source === 'editor')
            .map(toNativeMarkupHint)
            .filter((hint): hint is IPdfNativeMarkupSubtypeHint => hint !== null);
        if (overrides.length + liveHints.length + editedCommentHints.length === 0) {
            return null;
        }
        return {
            overrides,
            hints: [
                ...liveHints,
                ...editedCommentHints,
            ],
        };
    }

    function buildNativePdfMutationPlanForSave(opts: {
        mode: 'save' | 'save_as';
        pendingTexts: Map<string, string> | null;
        pendingDeletes: IAnnotationCommentSummary[] | null;
        annotationCommentsSnapshot: IAnnotationCommentSummary[];
        shapeStateDirty: boolean;
        forcePdfjsMaterialize: boolean;
        savedPdfjsAnnotationBaselineDirty: boolean;
        includeManagedShapesForLiveSource: boolean;
        forceRewrite: boolean;
    }): INativePdfMutationPlan | null {
        const skip = (reason: string, details: Record<string, unknown> = {}) => {
            BrowserLogger.debug('workspace', 'Skipped native PDF mutation save fast path', () => ({
                reason,
                pendingTexts: opts.pendingTexts?.size ?? 0,
                pendingDeletes: opts.pendingDeletes?.length ?? 0,
                shapeStateDirty: opts.shapeStateDirty,
                forcePdfjsMaterialize: opts.forcePdfjsMaterialize,
                savedPdfjsAnnotationBaselineDirty: opts.savedPdfjsAnnotationBaselineDirty,
                includeManagedShapesForLiveSource: opts.includeManagedShapesForLiveSource,
                forceRewrite: opts.forceRewrite,
                pageLabelsDirty: pageLabelsDirty.value,
                bookmarksDirty: bookmarksDirty.value,
                ...details,
            }));
            return null;
        };

        if (opts.mode !== 'save') {
            return skip('not-save-mode', {mode: opts.mode});
        }
        if (!hasNativePdfMutationCapability()) {
            return skip('native-save-capability-unavailable');
        }
        if (opts.includeManagedShapesForLiveSource) {
            return skip('managed-shapes-require-materialization');
        }

        const nativeNoteTextUpdates = opts.pendingTexts?.size
            ? buildNativeNoteTextUpdatesForSave(opts)
            : null;
        const nativeFreeTextNotes = buildNativeFreeTextNotesForSave(opts);
        const nativeAnnotationDeletes = buildNativeAnnotationDeletesForSave(opts);
        const pendingTextsCoveredByNativeChanges = arePendingTextsCoveredByNativeChanges({
            pendingTexts: opts.pendingTexts,
            annotationCommentsSnapshot: opts.annotationCommentsSnapshot,
            nativeNoteTextUpdates,
            nativeFreeTextNotes,
        });
        const noteTextUpdates = nativeNoteTextUpdates ?? [];
        const freeTextNotes = nativeFreeTextNotes ?? [];
        const annotationDeletes = nativeAnnotationDeletes ?? [];
        const nativeNoteMutationCount = noteTextUpdates.length + freeTextNotes.length + annotationDeletes.length;
        if (opts.savedPdfjsAnnotationBaselineDirty && nativeNoteMutationCount === 0) {
            // A preserved live PDF.js session can hide deleted/undone existing
            // markup outside annotationStorage until PDF.js serializes it.
            // Native markup hints only rewrite visible annotations, so do not
            // let them mask a deletion that must be materialized by PDF.js.
            return skip('saved-pdfjs-baseline-dirty-requires-materialization');
        }
        const annotationWorkDirty = annotationDirty.value || (hasAnnotationChanges() && !opts.shapeStateDirty);
        const markup = buildNativeMarkupMutationForSave(opts.annotationCommentsSnapshot, annotationWorkDirty);
        const hasMarkupMutations = Boolean(markup);
        const hasUncoveredLivePdfJsAnnotationChanges = hasLivePdfJsAnnotationChanges?.() ?? false;
        if (opts.forcePdfjsMaterialize && !hasMarkupMutations) {
            return skip('pdfjs-materialize-required');
        }
        if (opts.forceRewrite) {
            return skip('rewrite-forced');
        }
        if (!pendingTextsCoveredByNativeChanges) {
            return skip('pending-texts-not-covered-by-native-mutations');
        }
        if (opts.pendingDeletes?.length && annotationDeletes.length !== opts.pendingDeletes.length) {
            return skip('pending-deletes-not-covered-by-native-mutations', {
                requestedDeletes: opts.pendingDeletes.length,
                nativeDeletes: annotationDeletes.length,
            });
        }
        if (hasUncoveredLivePdfJsAnnotationChanges && nativeNoteMutationCount === 0) {
            return skip('live-pdfjs-annotation-work-not-covered-by-native-mutations');
        }
        if (
            (
                annotationDirty.value
                || (hasAnnotationChanges() && !opts.shapeStateDirty)
            )
            && nativeNoteMutationCount === 0
            && !hasMarkupMutations
        ) {
            return skip('annotation-work-not-covered-by-native-mutations');
        }

        const shapes = buildNativeShapesMutationForSave(opts.shapeStateDirty);
        const hasShapeMutations = Boolean(shapes);
        if (opts.shapeStateDirty && !hasShapeMutations) {
            return skip('shape-payload-unavailable');
        }
        const pageLabels = buildNativePageLabelsMutationForSave();
        const bookmarks = buildNativeBookmarksMutationForSave();
        const hasMetadataMutations = Boolean(pageLabels || bookmarks);
        if ((pageLabelsDirty.value || bookmarksDirty.value) && !hasMetadataMutations) {
            return skip('metadata-payload-unavailable');
        }
        if ((hasMetadataMutations || hasShapeMutations) && !canPersistNativeMetadataMutations()) {
            return skip('native-structured-save-capability-unavailable');
        }
        if (nativeNoteMutationCount === 0 && !hasMetadataMutations && !hasShapeMutations && !hasMarkupMutations) {
            return null;
        }

        return {
            mutations: {
                ...(noteTextUpdates.length > 0 ? {updates: noteTextUpdates} : {}),
                ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
                ...(annotationDeletes.length > 0 ? {deletes: annotationDeletes} : {}),
                ...(pageLabels ? {pageLabels} : {}),
                ...(bookmarks ? {bookmarks} : {}),
                ...(shapes ? {shapes} : {}),
                ...(markup ? {markup} : {}),
            },
            noteTextUpdates,
            freeTextNotes,
            annotationDeletes,
            hasMetadataMutations,
            hasShapeMutations,
            hasMarkupMutations,
            phase: hasMetadataMutations || hasShapeMutations || hasMarkupMutations
                ? 'persist-native-pdf-mutations'
                : annotationDeletes.length
                    ? 'persist-native-annotation-changes'
                    : freeTextNotes.length
                        ? 'persist-native-note-changes'
                        : 'persist-native-note-text-updates',
        };
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
            hasPendingReplayableEmbeddedChanges: Boolean(
                opts?.pendingTexts?.size
                || opts?.pendingDeletes?.length
                || replayableIds.size > 0,
            ),
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
            const savedPdfjsAnnotationBaselineDirty = hasSavedPdfJsAnnotationBaselineChanges?.() ?? false;
            const preservedAnnotationSourceDirty = hasPreservedAnnotationSourceChanges?.() ?? false;
            const shouldSerialize = computeShouldSerializeFlag(
                shapeStateDirty,
                hasPendingTexts,
                hasPendingDeletes,
                preservedAnnotationSourceDirty,
            ) || config.forceSerialize === true;
            const preserveLivePdfjsAnnotationSession = shouldPreserveLiveAnnotationSession({
                mode: config.mode,
                shouldSerialize,
                shapeStateDirty,
                hasPendingTexts,
                hasPendingDeletes,
                hasLivePdfJsAnnotationChanges: hasLivePdfJsAnnotationChanges?.() ?? false,
                hasPreservedAnnotationSourceChanges: preservedAnnotationSourceDirty,
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
                    hasAnnotationChanges: hasAnnotationChanges(),
                    hasShapeChanges: shapeStateDirty,
                    hasPendingTexts,
                    hasPendingDeletes,
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
                const nativeMutationPlan = buildNativePdfMutationPlanForSave({
                    mode: config.mode,
                    pendingTexts,
                    pendingDeletes,
                    annotationCommentsSnapshot,
                    shapeStateDirty,
                    forcePdfjsMaterialize,
                    includeManagedShapesForLiveSource,
                    forceRewrite: config.forceRewrite === true,
                    savedPdfjsAnnotationBaselineDirty,
                });
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

    function computeShouldSerializeFlag(
        shapeStateDirty: boolean,
        hasPendingTexts: boolean,
        hasPendingDeletes: boolean,
        preservedAnnotationSourceDirty: boolean,
    ) {
        return annotationDirty.value
            || hasAnnotationChanges()
            || shapeStateDirty
            || pageLabelsDirty.value
            || bookmarksDirty.value
            || hasPendingTexts
            || hasPendingDeletes
            || preservedAnnotationSourceDirty;
    }

    function shouldPreserveLiveAnnotationSession(options: {
        mode: 'save' | 'save_as';
        shouldSerialize: boolean;
        shapeStateDirty: boolean;
        hasPendingTexts: boolean;
        hasPendingDeletes: boolean;
        hasLivePdfJsAnnotationChanges: boolean;
        hasPreservedAnnotationSourceChanges: boolean;
    }) {
        // Embedded deletes need the saved PDF bytes to become the live source;
        // otherwise old PDF.js annotations can outlive their persisted removal.
        return options.mode === 'save'
            && options.shouldSerialize
            && !options.hasPendingDeletes
            && !pageLabelsDirty.value
            && !bookmarksDirty.value
            && (
                options.shapeStateDirty
                || options.hasPendingTexts
                || options.hasLivePdfJsAnnotationChanges
                || options.hasPreservedAnnotationSourceChanges
                || hasAnnotationChanges()
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
