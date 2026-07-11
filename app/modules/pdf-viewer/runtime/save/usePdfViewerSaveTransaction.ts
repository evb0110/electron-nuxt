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
import { projectNativePdfMutationsForSave } from '@app/modules/pdf-viewer/runtime/save/projectNativePdfMutationsForSave';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import { isReplayableEditorOnlyFreeTextNote } from '@app/modules/pdf-viewer/runtime/save/nativeFreeTextNotes';
import {
    collectLivePdfJsAnnotationChangeIds,
    type IPdfLiveAnnotationChangeSummary,
} from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';
import type {
    IPdfViewerAnnotationSavePlan,
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
    IPdfViewerSaveTransactionSerializedResult,
    TPdfViewerSaveTransactionSource,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import type {
    INativePdfMutationProjection,
    INativePdfMutationProjectionInput,
} from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';
import type { AnnotationEntity } from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import type { ISerializationPlan } from '@app/modules/pdf-viewer/serialization/serializationPlan';
import {
    buildSerializationPlan,
    selectSerializationBackend,
    withSerializationBackendProjection,
} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import {
    assertAnnotationBackendSemanticConformance,
    projectAnnotationBackendMutations,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';
import {computeSummaryStableKey} from '@app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity';

const PDF_SAVE_TIMEOUT_QUIESCE_MS = 2_000;
const DEFAULT_TRANSACTION_SAVE_MODE = 'rewrite';

type TPdfAnnotationSavePlan = IPdfViewerAnnotationSavePlan;

interface IUsePdfViewerSaveTransactionOptions {
    materializePdfJsDocumentForInternalUse: () => Promise<Uint8Array | null>;
    flushAnnotationMutationsForSave?: () => Promise<unknown>;
    commitPdfEditorsForSave?: () => Promise<void>;
    getPdfDocument?: () => PDFDocumentProxy | null;
    getMarkupSubtypeOverrides?: () => Map<string, TMarkupSubtype> | undefined;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
    getAllShapes?: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    prepareAnnotationSave?: () => {
        plan?: ISerializationPlan;
        verify(bytes: Uint8Array): Promise<void>;
        assertCurrent?(): Promise<void> | void;
        commit(): void;
    };
}

function entitySummary(entity: AnnotationEntity): IAnnotationCommentSummary {
    const source = entity.identity.pdfRef || entity.identity.pdfName ? 'pdf' : 'editor';
    const id = entity.identity.elementId ?? entity.identity.pdfjsUid ?? entity.identity.pdfRef ?? entity.identity.id;
    const annotationId = entity.identity.pdfRef ?? null;
    const uid = entity.identity.pdfjsUid ?? null;
    const common = {
        appAnnotationId: entity.identity.id,
        id,
        stableKey: computeSummaryStableKey({
            id,
            pageIndex: entity.pageIndex,
            source,
            uid,
            annotationId,
            ...(entity.identity.pdfName ? {annotationName: entity.identity.pdfName} : {}),
        }),
        pageIndex: entity.pageIndex,
        pageNumber: entity.pageIndex + 1,
        author: entity.author,
        createdAt: entity.createdAt,
        modifiedAt: entity.modifiedAt,
        uid,
        annotationId,
        ...(entity.identity.pdfName ? {annotationName: entity.identity.pdfName} : {}),
        source,
    } as const;
    if (entity.kind === 'sticky-note') {
        return {
            ...common,
            text: entity.text,
            color: entity.color,
            hasNote: true,
            markerRect: structuredClone(entity.anchor),
        };
    }
    if (entity.kind === 'text-markup') {
        return {
            ...common,
            text: entity.text,
            subtype: entity.subtype,
            color: entity.color,
            opacity: entity.opacity,
            hasNote: Boolean(entity.text),
            markerRect: structuredClone(entity.geometry[0] ?? null),
        };
    }
    return {
        ...common,
        source: 'shape',
        id: entity.geometry.id,
        stableKey: computeSummaryStableKey({
            id: entity.geometry.id,
            pageIndex: entity.pageIndex,
            source: 'shape',
        }),
        text: '',
        color: entity.geometry.color,
        hasNote: false,
        markerRect: null,
    };
}

function projectCanonicalSaveInputs(plan: ISerializationPlan | undefined) {
    if (!plan) {
        return {
            plan,
            comments: [],
            pendingTexts: new Map<string, string>(),
            pendingDeletes: [],
        };
    }
    assertAnnotationBackendSemanticConformance(plan);
    // Once a frontier has been captured, every downstream backend is projected
    // solely from that immutable plan. Reading/merging a second live-state route
    // here made save selection depend on mutations that happened after capture.
    const comments = plan.entities
        .filter(entity => !entity.deleted)
        .map(entitySummary);
    const pendingTexts = new Map<string, string>();
    const pendingDeletes: IAnnotationCommentSummary[] = [];
    plan.expected.forEach((entity) => {
        const summary = entitySummary(entity);
        if (entity.deleted) {
            pendingDeletes.push(summary);
            return;
        }
        if (entity.kind === 'sticky-note' && (entity.identity.pdfRef || entity.identity.pdfName)) {
            pendingTexts.set(summary.stableKey, entity.text);
        }
    });
    return {
        plan,
        comments,
        pendingTexts,
        pendingDeletes,
    };
}

function summarizeCanonicalLiveChanges(plan: ISerializationPlan): IPdfLiveAnnotationChangeSummary {
    const ids = new Set<string>();
    const replayableEditorNoteIds = new Set<string>();
    plan.expected.forEach((entity) => {
        const candidates = [
            entity.identity.id,
            entity.identity.elementId,
            entity.identity.pdfjsUid,
            entity.identity.pdfRef,
        ];
        candidates.forEach((candidate) => {
            const normalized = normalizePdfJsAnnotationId(candidate);
            if (!normalized) {
                return;
            }
            ids.add(normalized);
            if (entity.kind === 'sticky-note') replayableEditorNoteIds.add(normalized);
        });
    });
    return {
        ids,
        replayableEditorNoteIds,
        hasChanges: plan.steps.length > 0,
        hasUnknownChanges: false,
        fingerprint: `frontier:${plan.frontier.epoch}:${plan.frontier.entityBaselineHash}:${Array.from(ids).sort().join(',')}`,
    };
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
    canonicalComments: IAnnotationCommentSummary[];
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
    input.canonicalComments
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

function buildAnnotationSavePlan(input: {
    request: IPdfViewerSaveTransactionRequest;
    canonicalComments: IAnnotationCommentSummary[];
    liveChanges: IPdfLiveAnnotationChangeSummary;
    pendingTexts: Map<string, string>;
    pendingDeletes: IAnnotationCommentSummary[];
}): IPdfViewerAnnotationSavePlan {
    const replayableIds = collectReplayableEmbeddedAnnotationIds(input);
    if (input.request.forcePdfjsMaterialize) {
        return {
            route: 'pdfjs-materialize',
            expectedCost: 'full-document',
            reason: input.liveChanges.hasChanges
                ? 'live-pdfjs-annotation-baseline-diverged'
                : 'saved-pdfjs-annotation-baseline-diverged',
            unreplayableLiveAnnotationIds: Array.from(input.liveChanges.ids),
        };
    }

    return buildPdfAnnotationSavePlan({
        hasPendingReplayableEmbeddedChanges: input.pendingTexts.size > 0
            || input.pendingDeletes.length > 0
            || replayableIds.size > 0,
        hasEditorOnlyAnnotationsPendingMaterialization: hasUnreplayableEditorOnlyAnnotationsPendingMaterialization(
            input.canonicalComments,
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
    nativeMutationProjection: INativePdfMutationProjection | null,
): TPdfViewerSaveTransactionSource {
    if (nativeMutationProjection) {
        return 'native-mutation-projection';
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

function createSerializedResult(input: {
    request: IPdfViewerSaveTransactionRequest;
    resultSource: TPdfViewerSaveTransactionSource;
    serializedBytes: Uint8Array | null;
}): IPdfViewerSaveTransactionSerializedResult | null {
    if (!input.request.serializeResult || !input.serializedBytes) {
        return null;
    }

    return {
        finalBytes: input.serializedBytes,
        saveMode: input.request.saveMode ?? DEFAULT_TRANSACTION_SAVE_MODE,
        source: input.resultSource,
        changedObjectRefs: input.request.annotationSerializationPlan?.changedObjectRefs ?? [],
    };
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

    function completeNativeProjectionPlan(input: {
        plan: ISerializationPlan;
        request: IPdfViewerSaveTransactionRequest;
        annotationSavePlan: TPdfAnnotationSavePlan;
        canonicalComments: IAnnotationCommentSummary[];
        pendingTexts: Map<string, string>;
        pendingDeletes: IAnnotationCommentSummary[];
    }): ISerializationPlan<INativePdfMutationProjectionInput> | null {
        if (selectSerializationBackend(input.plan, [
            'native-append',
            'pdfjs-save-document',
            'pdf-lib-rewrite',
        ]) !== 'native-append') {
            return null;
        }
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
        return withSerializationBackendProjection(input.plan, {
            canonicalAnnotationProgram: input.request.annotationSerializationPlan
                ? projectAnnotationBackendMutations(input.request.annotationSerializationPlan, 'native-append')
                : [],
            mode: input.request.saveFlowMode ?? 'save',
            pendingTexts: input.pendingTexts,
            pendingDeletes: input.pendingDeletes,
            shapeStateDirty: dirtyState.shapeStateDirty,
            forcePdfjsMaterialize: input.request.forcePdfjsMaterialize === true,
            includeManagedShapesForLiveSource: input.request.includeManagedShapes === true,
            forceRewrite: input.request.forceRewrite === true,
            pageLabelsDirty: documentStructure.pageLabelsDirty,
            bookmarksDirty: documentStructure.bookmarksDirty,
            canonicalComments: input.canonicalComments,
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
    }

    function projectNativeMutations(plan: ISerializationPlan<INativePdfMutationProjectionInput>) {
        const opts = plan.backendProjection;
        if (!opts) {
            return null;
        }
        const nativeMutationProjectionResult = projectNativePdfMutationsForSave(opts);

        nativeMutationProjectionResult.skipEvents.forEach(({
            event,
            reason,
            details,
        }) => {
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
        });
        return nativeMutationProjectionResult.projection;
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
        if (input.request.annotationSerializationPlan) {
            projectAnnotationBackendMutations(input.request.annotationSerializationPlan, 'pdfjs-save-document');
        }
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
    }) {
        if (!input.baseBytes) {
            return null;
        }
        if (!input.request.serializeResult || !input.request.source?.serializePdfForSave) {
            return input.request.source ? null : input.baseBytes;
        }

        return input.request.source.serializePdfForSave(input.baseBytes, {
            ...(input.request.annotationSerializationPlan
                ? {annotationSerializationPlan: input.request.annotationSerializationPlan}
                : {}),
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
        const canonicalSave = options.prepareAnnotationSave?.();
        // Complete the annotation frontier into the global immutable save plan
        // before route selection. From this point onward no backend is allowed to
        // sample metadata or route constraints from mutable UI state.
        const serializationPlan = canonicalSave?.plan
            ? buildSerializationPlan(
                canonicalSave.plan.frontier,
                canonicalSave.plan.expected,
                canonicalSave.plan.entities,
                {
                    metadata: {
                        pageLabels: request.documentStructure?.pageLabelsDirty
                            ? request.documentStructure.pageLabelRanges
                            : null,
                        bookmarks: request.documentStructure?.bookmarksDirty
                            ? request.documentStructure.bookmarkItems
                            : null,
                    },
                    routeConstraints: {
                        forceRewrite: request.forceRewrite === true,
                        preserveLoadedSource: request.mode !== 'persist',
                        allowedBackends: request.forceRewrite
                            ? ['pdf-lib-rewrite']
                            : [
                                'native-append',
                                'pdfjs-save-document',
                                'pdf-lib-rewrite',
                            ],
                    },
                    postconditions: {expectedPageCount: request.documentStructure?.totalPages ?? null},
                },
            )
            : undefined;
        const globalSerializationPlan = serializationPlan ?? buildSerializationPlan({
            documentRevisionToken: null,
            epoch: 0,
            entityBaselineHash: 'no-canonical-annotation-frontier',
            revisions: new Map(),
        }, [], [], {
            metadata: {
                pageLabels: request.documentStructure?.pageLabelsDirty
                    ? request.documentStructure.pageLabelRanges
                    : null,
                bookmarks: request.documentStructure?.bookmarksDirty
                    ? request.documentStructure.bookmarkItems
                    : null,
            },
            routeConstraints: {
                forceRewrite: request.forceRewrite === true,
                preserveLoadedSource: request.mode !== 'persist',
                allowedBackends: request.forceRewrite
                    ? ['pdf-lib-rewrite']
                    : [
                        'native-append',
                        'pdfjs-save-document',
                        'pdf-lib-rewrite',
                    ],
            },
            postconditions: {expectedPageCount: request.documentStructure?.totalPages ?? null},
        });
        const canonicalSaveCallbacks = {
            verifyAnnotationSave: (bytes: Uint8Array) => canonicalSave?.verify(bytes) ?? Promise.resolve(),
            commitAnnotationSave: () => canonicalSave?.commit(),
            assertAnnotationSaveCurrent: () => canonicalSave?.assertCurrent?.(),
        };
        const liveChanges = serializationPlan
            ? summarizeCanonicalLiveChanges(serializationPlan)
            : collectLivePdfJsAnnotationChangeIds(options.getPdfDocument?.());
        const canonicalInputs = projectCanonicalSaveInputs(globalSerializationPlan);
        const canonicalComments = canonicalInputs.comments;
        request = {
            ...request,
            ...(canonicalInputs.plan ? {annotationSerializationPlan: canonicalInputs.plan} : {}),
        };
        const {
            pendingTexts,
            pendingDeletes,
        } = canonicalInputs;
        const replayableIds = collectReplayableEmbeddedAnnotationIds({
            pendingTexts,
            pendingDeletes,
            canonicalComments,
            liveChanges,
        });
        const annotationSavePlan = buildAnnotationSavePlan({
            request,
            canonicalComments,
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
            canonicalComments,
            liveChanges,
            pendingTexts,
            pendingDeletes,
        });
        const nativeProjectionPlan = canonicalInputs.plan
            ? completeNativeProjectionPlan({
                plan: canonicalInputs.plan,
                request,
                annotationSavePlan: nativeAnnotationSavePlan,
                canonicalComments,
                pendingTexts,
                pendingDeletes,
            })
            : null;
        const nativeMutationProjection = nativeProjectionPlan
            ? projectNativeMutations(nativeProjectionPlan)
            : null;
        if (nativeMutationProjection) {
            return {
                source: 'native-mutation-projection',
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection,
                annotationSavePlan,
                ...canonicalSaveCallbacks,
            };
        }

        if (request.planOnly) {
            return {
                source: resolveAnnotationPlanSource(annotationSavePlan),
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection: null,
                annotationSavePlan,
                ...canonicalSaveCallbacks,
            };
        }

        const sourceFallbackPlan = buildAnnotationSavePlan({
            request: {
                ...request,
                forcePdfjsMaterialize: false,
            },
            canonicalComments,
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
        });
        const resultSource = request.source
            ? resolveResultSource(annotationSavePlan, serializedBytes, null)
            : 'pdfjs-materialize';

        return {
            source: resultSource,
            baseBytes: request.source ? baseBytes : null,
            serializedBytes,
            serializedResult: createSerializedResult({
                request,
                resultSource,
                serializedBytes,
            }),
            nativeMutationProjection,
            annotationSavePlan,
            ...canonicalSaveCallbacks,
        };
    }

    return {runSaveTransaction};
};
