import type { PDFDocumentProxy } from 'pdfjs-dist';
import { delay } from 'es-toolkit/promise';
import { isTimeoutError } from '@contracts/isTimeoutError';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { getPdfAnnotationIdFromStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/parsePdfAnnotationStableKey';
import {
    buildPdfAnnotationSavePlan,
    type IPdfAnnotationSavePlanInput,
} from '@app/modules/pdf-viewer/runtime/save/buildPdfAnnotationSavePlan';
import { buildNativePdfMutationPlanForSave } from '@app/modules/pdf-viewer/runtime/save/buildNativePdfMutationPlanForSave';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import { isReplayableEditorOnlyFreeTextNote } from '@app/modules/pdf-viewer/runtime/save/nativeFreeTextNotes';
import {
    collectLivePdfJsAnnotationChangeIds,
    type IPdfLiveAnnotationChangeSummary,
} from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';
import type {
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
    IPdfViewerConsumedPendingEmbeddedMutations,
    IPdfViewerPendingEmbeddedMutationSnapshot,
    TPdfViewerSaveTransactionSource,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import type { INativePdfMutationPlan } from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationPlanTypes';

const PDF_SAVE_TIMEOUT_QUIESCE_MS = 2_000;

type TPdfAnnotationSavePlan = ReturnType<typeof buildPdfAnnotationSavePlan>;

interface IUsePdfViewerSaveTransactionOptions {
    materializePdfJsDocumentForInternalUse: () => Promise<Uint8Array | null>;
    flushAnnotationMutationsForSave?: () => Promise<unknown>;
    consumePendingEmbeddedMutations?: () => IPdfViewerConsumedPendingEmbeddedMutations;
    getPendingEmbeddedMutationSnapshot?: () => IPdfViewerPendingEmbeddedMutationSnapshot;
    commitPdfEditorsForSave?: () => Promise<void>;
    getPdfDocument?: () => PDFDocumentProxy | null;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    getMarkupSubtypeOverrides?: () => Map<string, TMarkupSubtype> | undefined;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
    getAllShapes?: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
}

class PdfViewerSaveDocumentTimeoutError extends Error {
    constructor(public readonly settlePromise: Promise<void>) {
        super('PDF.js saveDocument timed out');
        this.name = 'PdfViewerSaveDocumentTimeoutError';
    }
}

function hasUnreplayableEditorOnlyAnnotationsPendingMaterialization(
    comments: IAnnotationCommentSummary[],
) {
    return comments.some(comment =>
        comment.source === 'editor'
        && !parsePdfJsAnnotationRef(comment.annotationId)
        && !isReplayableEditorOnlyFreeTextNote(comment),
    );
}

function addExistingPdfAnnotationIdFromStableKey(ids: Set<string>, stableKey: string) {
    const normalized = normalizePdfJsAnnotationId(getPdfAnnotationIdFromStableKey(stableKey));
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

function collectReplayableEmbeddedAnnotationIds(input: {
    pendingTexts: Map<string, string>;
    pendingDeletes: IAnnotationCommentSummary[];
    annotationCommentsSnapshot: IAnnotationCommentSummary[];
    liveChanges: IPdfLiveAnnotationChangeSummary;
}) {
    const ids = new Set<string>();
    input.pendingTexts.forEach((_text, stableKey) => {
        addExistingPdfAnnotationIdFromStableKey(ids, stableKey);
        addEditorRuntimeAnnotationIdFromStableKey(ids, stableKey);
    });
    input.pendingDeletes.forEach((comment) => {
        addReplayableAnnotationId(ids, comment.annotationId);
        addExistingPdfAnnotationIdFromStableKey(ids, comment.stableKey);
        addEditorRuntimeAnnotationIdFromStableKey(ids, comment.stableKey);
    });
    input.annotationCommentsSnapshot
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
        input.liveChanges.replayableEditorNoteIds.forEach((id) => {
            addReplayableAnnotationId(ids, id);
        });
    }
    return ids;
}

function clonePendingTexts(input: Map<string, string> | null | undefined) {
    return input ? new Map(input) : new Map<string, string>();
}

function clonePendingDeletes(input: IAnnotationCommentSummary[] | null | undefined) {
    return input ? [...input] : [];
}

function createEmptyConsumedPendingEmbeddedMutations(): IPdfViewerConsumedPendingEmbeddedMutations {
    return {
        pendingEmbeddedTextUpdates: new Map<string, string>(),
        pendingEmbeddedAnnotationDeletes: [],
        restore: () => undefined,
        commit: () => undefined,
    };
}

function resolvePendingEmbeddedMutations(
    request: IPdfViewerSaveTransactionRequest,
    options: IUsePdfViewerSaveTransactionOptions,
) {
    if (
        request.pendingEmbeddedTextUpdates !== undefined
        || request.pendingEmbeddedAnnotationDeletes !== undefined
    ) {
        return {
            pendingTexts: clonePendingTexts(request.pendingEmbeddedTextUpdates),
            pendingDeletes: clonePendingDeletes(request.pendingEmbeddedAnnotationDeletes),
            consumed: createEmptyConsumedPendingEmbeddedMutations(),
        };
    }

    if (request.consumePendingEmbeddedMutations === true) {
        const consumed = options.consumePendingEmbeddedMutations?.()
            ?? createEmptyConsumedPendingEmbeddedMutations();
        return {
            pendingTexts: clonePendingTexts(consumed.pendingEmbeddedTextUpdates),
            pendingDeletes: clonePendingDeletes(consumed.pendingEmbeddedAnnotationDeletes),
            consumed,
        };
    }

    const snapshot = options.getPendingEmbeddedMutationSnapshot?.();
    return {
        pendingTexts: clonePendingTexts(snapshot?.pendingEmbeddedTextUpdates),
        pendingDeletes: clonePendingDeletes(snapshot?.pendingEmbeddedAnnotationDeletes),
        consumed: createEmptyConsumedPendingEmbeddedMutations(),
    };
}

function resolveAnnotationCommentsSnapshot(
    request: IPdfViewerSaveTransactionRequest,
    options: IUsePdfViewerSaveTransactionOptions,
) {
    return request.annotationCommentsSnapshot
        ? [...request.annotationCommentsSnapshot]
        : options.getAnnotationCommentsSnapshot?.() ?? [];
}

function buildAnnotationSavePlan(input: {
    request: IPdfViewerSaveTransactionRequest;
    annotationCommentsSnapshot: IAnnotationCommentSummary[];
    liveChanges: IPdfLiveAnnotationChangeSummary;
    pendingTexts: Map<string, string>;
    pendingDeletes: IAnnotationCommentSummary[];
}) {
    const replayableIds = collectReplayableEmbeddedAnnotationIds(input);
    if (input.request.forcePdfjsMaterialize) {
        return {
            route: 'pdfjs-materialize',
            expectedCost: 'full-document',
            reason: input.liveChanges.hasChanges
                ? 'live-pdfjs-annotation-baseline-diverged'
                : 'saved-pdfjs-annotation-baseline-diverged',
            unreplayableLiveAnnotationIds: Array.from(input.liveChanges.ids),
        } as const;
    }

    return buildPdfAnnotationSavePlan({
        hasPendingReplayableEmbeddedChanges: input.pendingTexts.size > 0
            || input.pendingDeletes.length > 0
            || replayableIds.size > 0,
        hasEditorOnlyAnnotationsPendingMaterialization: hasUnreplayableEditorOnlyAnnotationsPendingMaterialization(
            input.annotationCommentsSnapshot,
        ),
        liveAnnotationChanges: input.liveChanges,
        replayableEmbeddedAnnotationIds: replayableIds,
    } satisfies IPdfAnnotationSavePlanInput);
}

function logAnnotationSavePlan(input: {
    request: IPdfViewerSaveTransactionRequest;
    annotationSavePlan: TPdfAnnotationSavePlan;
    liveChanges: IPdfLiveAnnotationChangeSummary;
    replayableIds: Set<string>;
    pendingTexts: Map<string, string>;
    pendingDeletes: IAnnotationCommentSummary[];
}) {
    BrowserLogger.debug('workspace', 'Planned PDF annotation save route', {
        route: input.annotationSavePlan.route,
        expectedCost: input.annotationSavePlan.expectedCost,
        reason: input.annotationSavePlan.reason,
        liveAnnotationIds: Array.from(input.liveChanges.ids),
        replayableLiveEditorNoteIds: Array.from(input.liveChanges.replayableEditorNoteIds),
        replayableAnnotationIds: Array.from(input.replayableIds),
        unreplayableLiveAnnotationIds: input.annotationSavePlan.unreplayableLiveAnnotationIds,
        pendingTexts: input.pendingTexts.size,
        pendingDeletes: input.pendingDeletes.length,
        forcePdfjsMaterialize: input.request.forcePdfjsMaterialize === true,
    });
}

function resolveResultSource(
    annotationSavePlan: TPdfAnnotationSavePlan,
    serializedBytes: Uint8Array | null,
    nativeMutationPlan: INativePdfMutationPlan | null,
): TPdfViewerSaveTransactionSource {
    if (nativeMutationPlan) {
        return 'native-mutation-plan';
    }
    if (serializedBytes) {
        return 'serialized-rewrite';
    }
    return resolveAnnotationPlanSource(annotationSavePlan);
}

function resolveAnnotationPlanSource(
    annotationSavePlan: TPdfAnnotationSavePlan,
): TPdfViewerSaveTransactionSource {
    if (
        annotationSavePlan.route === 'source-clean'
        || annotationSavePlan.route === 'source-replay'
        || annotationSavePlan.route === 'pdfjs-materialize'
    ) {
        return annotationSavePlan.route;
    }
    return 'pdfjs-materialize';
}

export const usePdfViewerSaveTransaction = (
    options: IUsePdfViewerSaveTransactionOptions,
) => {
    async function runSaveDocumentAttemptWithTimeout() {
        const savePromise = (async () => {
            const data = await options.materializePdfJsDocumentForInternalUse();
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
                reject(new PdfViewerSaveDocumentTimeoutError(settlePromise));
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

    async function waitForTimedOutSaveDocumentToQuiesce(error: PdfViewerSaveDocumentTimeoutError) {
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
            try {
                return await runSaveDocumentAttemptWithTimeout();
            } catch (error) {
                const timedOut = error instanceof PdfViewerSaveDocumentTimeoutError || isTimeoutError(error);
                BrowserLogger.warn(
                    'workspace',
                    timedOut
                        ? 'Save aborted because PDF.js saveDocument timed out'
                        : 'saveDocument attempt failed',
                    {
                        attempt,
                        maxAttempts,
                        timedOut,
                        error,
                    },
                );

                if (timedOut) {
                    if (error instanceof PdfViewerSaveDocumentTimeoutError) {
                        throw error;
                    }
                    throw new PdfViewerSaveDocumentTimeoutError(Promise.resolve());
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

    function buildNativeMutationPlan(input: {
        request: IPdfViewerSaveTransactionRequest;
        annotationSavePlan: TPdfAnnotationSavePlan;
        annotationCommentsSnapshot: IAnnotationCommentSummary[];
        pendingTexts: Map<string, string>;
        pendingDeletes: IAnnotationCommentSummary[];
    }) {
        const {
            dirtyState,
            documentStructure,
            nativeCapabilities,
        } = input.request;
        if (!dirtyState || !documentStructure || !nativeCapabilities) {
            return null;
        }

        const annotationWorkDirty = dirtyState.annotationDirty
            || (dirtyState.hasAnnotationChanges && !dirtyState.shapeStateDirty);
        const nativeMutationPlanResult = buildNativePdfMutationPlanForSave({
            mode: input.request.saveFlowMode ?? 'save',
            pendingTexts: input.pendingTexts,
            pendingDeletes: input.pendingDeletes,
            shapeStateDirty: dirtyState.shapeStateDirty,
            forcePdfjsMaterialize: input.request.forcePdfjsMaterialize === true,
            includeManagedShapesForLiveSource: input.request.includeManagedShapes === true,
            forceRewrite: input.request.forceRewrite === true,
            pageLabelsDirty: documentStructure.pageLabelsDirty,
            bookmarksDirty: documentStructure.bookmarksDirty,
            annotationCommentsSnapshot: input.annotationCommentsSnapshot,
            savedPdfjsAnnotationBaselineDirty: dirtyState.savedPdfjsAnnotationBaselineDirty,
            annotationDirty: dirtyState.annotationDirty,
            hasAnnotationChanges: dirtyState.hasAnnotationChanges,
            hasLivePdfJsAnnotationChanges: dirtyState.hasLivePdfJsAnnotationChanges,
            hasNativePdfMutationCapability: nativeCapabilities.hasNativePdfMutationCapability,
            canPersistNativeMetadataMutations: nativeCapabilities.canPersistNativeMetadataMutations,
            annotationSavePlan: input.annotationSavePlan,
            totalPageCount: Math.max(documentStructure.totalPages, options.getPdfDocument?.()?.numPages ?? 0),
            pageLabelRanges: documentStructure.pageLabelRanges,
            bookmarkItems: documentStructure.bookmarkItems,
            untitledBookmarkLabel: documentStructure.untitledBookmarkLabel,
            shapes: dirtyState.shapeStateDirty ? options.getAllShapes?.() ?? null : null,
            deletedEmbeddedShapeAnnotationIds: dirtyState.shapeStateDirty
                ? options.getDeletedEmbeddedShapeAnnotationIds?.() ?? []
                : [],
            deletedEmbeddedShapeStableKeys: dirtyState.shapeStateDirty
                ? options.getDeletedEmbeddedShapeStableKeys?.() ?? []
                : [],
            markupSubtypeOverrides: annotationWorkDirty
                ? input.request.markupSubtypeOverrides ?? options.getMarkupSubtypeOverrides?.()
                : undefined,
            markupSubtypeHints: annotationWorkDirty
                ? input.request.markupSubtypeHints ?? options.getMarkupSubtypeHints?.() ?? []
                : [],
        });

        nativeMutationPlanResult.skipEvents.forEach(({
            event,
            reason,
            details,
        }) => {
            BrowserLogger.debug('workspace', event, () => ({
                reason,
                pendingTexts: input.pendingTexts.size,
                pendingDeletes: input.pendingDeletes.length,
                shapeStateDirty: dirtyState.shapeStateDirty,
                forcePdfjsMaterialize: input.request.forcePdfjsMaterialize === true,
                savedPdfjsAnnotationBaselineDirty: dirtyState.savedPdfjsAnnotationBaselineDirty,
                includeManagedShapesForLiveSource: input.request.includeManagedShapes === true,
                forceRewrite: input.request.forceRewrite === true,
                pageLabelsDirty: documentStructure.pageLabelsDirty,
                bookmarksDirty: documentStructure.bookmarksDirty,
                ...details,
            }));
        });
        return nativeMutationPlanResult.plan;
    }

    async function readSourcePdfBytes(request: IPdfViewerSaveTransactionRequest) {
        const data = await request.source?.getSourcePdfData();
        if (!data) {
            return null;
        }
        return data;
    }

    async function materializePdfJsBytesWithFallback(input: {
        request: IPdfViewerSaveTransactionRequest;
        sourceFallbackAllowed: boolean;
    }) {
        try {
            return await saveDocumentWithRetry();
        } catch (error) {
            if (
                error instanceof PdfViewerSaveDocumentTimeoutError
                && !await waitForTimedOutSaveDocumentToQuiesce(error)
            ) {
                throw error;
            }
            if (!input.sourceFallbackAllowed) {
                throw error;
            }
            BrowserLogger.warn('workspace', 'Falling back to source PDF bytes after PDF.js saveDocument failed', error);
            return readSourcePdfBytes(input.request);
        }
    }

    async function selectBaseBytes(input: {
        request: IPdfViewerSaveTransactionRequest;
        annotationSavePlan: TPdfAnnotationSavePlan;
        sourceFallbackAllowed: boolean;
    }) {
        if (
            input.request.source
            && (
                input.annotationSavePlan.route === 'source-replay'
                || input.annotationSavePlan.route === 'source-clean'
            )
        ) {
            return readSourcePdfBytes(input.request);
        }

        return materializePdfJsBytesWithFallback({
            request: input.request,
            sourceFallbackAllowed: input.sourceFallbackAllowed,
        });
    }

    async function serializeResultBytes(input: {
        request: IPdfViewerSaveTransactionRequest;
        baseBytes: Uint8Array | null;
        annotationCommentsSnapshot: IAnnotationCommentSummary[];
        pendingTexts: Map<string, string>;
        pendingDeletes: IAnnotationCommentSummary[];
    }) {
        if (!input.baseBytes) {
            return null;
        }
        if (!input.request.serializeResult || !input.request.source?.serializePdfForSave) {
            return input.request.source ? null : input.baseBytes;
        }

        return input.request.source.serializePdfForSave(input.baseBytes, {
            annotationCommentsSnapshot: input.annotationCommentsSnapshot,
            pendingTexts: input.pendingTexts,
            pendingDeletes: input.pendingDeletes,
            ...(input.request.includeManagedShapes !== undefined ? {includeShapes: input.request.includeManagedShapes} : {}),
            ...(input.request.rewriteShapeState !== undefined ? {rewriteShapeState: input.request.rewriteShapeState} : {}),
            ...(input.request.forceRewrite !== undefined ? {forceRewrite: input.request.forceRewrite} : {}),
        });
    }

    async function runSaveTransaction(
        request: IPdfViewerSaveTransactionRequest,
    ): Promise<IPdfViewerSaveTransactionResult> {
        await options.flushAnnotationMutationsForSave?.();
        await options.commitPdfEditorsForSave?.();
        const liveChanges = collectLivePdfJsAnnotationChangeIds(options.getPdfDocument?.());
        const annotationCommentsSnapshot = resolveAnnotationCommentsSnapshot(request, options);
        const {
            pendingTexts,
            pendingDeletes,
            consumed,
        } = resolvePendingEmbeddedMutations(request, options);
        const replayableIds = collectReplayableEmbeddedAnnotationIds({
            pendingTexts,
            pendingDeletes,
            annotationCommentsSnapshot,
            liveChanges,
        });
        const annotationSavePlan = buildAnnotationSavePlan({
            request,
            annotationCommentsSnapshot,
            liveChanges,
            pendingTexts,
            pendingDeletes,
        });
        logAnnotationSavePlan({
            request,
            annotationSavePlan,
            liveChanges,
            replayableIds,
            pendingTexts,
            pendingDeletes,
        });

        const nativeAnnotationSavePlan = buildAnnotationSavePlan({
            request: {
                ...request,
                forcePdfjsMaterialize: false,
            },
            annotationCommentsSnapshot,
            liveChanges,
            pendingTexts,
            pendingDeletes,
        });
        const nativeMutationPlan = buildNativeMutationPlan({
            request,
            annotationSavePlan: nativeAnnotationSavePlan,
            annotationCommentsSnapshot,
            pendingTexts,
            pendingDeletes,
        });
        if (nativeMutationPlan) {
            return {
                source: 'native-mutation-plan',
                baseBytes: null,
                serializedBytes: null,
                nativeMutationPlan,
                annotationSavePlan,
                annotationCommentsSnapshot,
                pendingEmbeddedTextUpdates: pendingTexts,
                pendingEmbeddedAnnotationDeletes: pendingDeletes,
                restoreConsumedPendingEmbeddedMutations: consumed.restore,
                commitConsumedPendingEmbeddedMutations: consumed.commit,
            };
        }

        if (request.planOnly) {
            return {
                source: resolveAnnotationPlanSource(annotationSavePlan),
                baseBytes: null,
                serializedBytes: null,
                nativeMutationPlan: null,
                annotationSavePlan,
                annotationCommentsSnapshot,
                pendingEmbeddedTextUpdates: pendingTexts,
                pendingEmbeddedAnnotationDeletes: pendingDeletes,
                restoreConsumedPendingEmbeddedMutations: consumed.restore,
                commitConsumedPendingEmbeddedMutations: consumed.commit,
            };
        }

        const sourceFallbackPlan = buildAnnotationSavePlan({
            request: {
                ...request,
                forcePdfjsMaterialize: false,
            },
            annotationCommentsSnapshot,
            liveChanges,
            pendingTexts,
            pendingDeletes,
        });
        const baseBytes = await selectBaseBytes({
            request,
            annotationSavePlan,
            sourceFallbackAllowed: request.forcePdfjsMaterialize !== true
                && sourceFallbackPlan.route === 'source-replay',
        });
        const serializedBytes = await serializeResultBytes({
            request,
            baseBytes,
            annotationCommentsSnapshot,
            pendingTexts,
            pendingDeletes,
        });

        return {
            source: request.source
                ? resolveResultSource(annotationSavePlan, serializedBytes, null)
                : 'pdfjs-materialize',
            baseBytes: request.source ? baseBytes : null,
            serializedBytes,
            nativeMutationPlan,
            annotationSavePlan,
            annotationCommentsSnapshot,
            pendingEmbeddedTextUpdates: pendingTexts,
            pendingEmbeddedAnnotationDeletes: pendingDeletes,
            restoreConsumedPendingEmbeddedMutations: consumed.restore,
            commitConsumedPendingEmbeddedMutations: consumed.commit,
        };
    }

    return {runSaveTransaction};
};
