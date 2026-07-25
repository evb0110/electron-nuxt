import type {
    AnnotationEditorUIManager,
    PDFDocumentProxy,
} from 'pdfjs-dist';
import type {
    ComputedRef,
    ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import { isTimeoutError } from '@contracts/isTimeoutError';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import type {
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import { BrowserLogger } from '@app/utils/browserLogger';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import {
    collectNewPdfJsAnnotationStorageEditorOrder,
    collectLivePdfJsAnnotationChangeIds,
    mergeLivePdfJsAnnotationChanges,
} from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';
import type {TPdfSaveRouteDecision} from '@app/modules/pdf-viewer/runtime/save/classifyPdfSaveRoute';
import { classifyPdfSaveRoute } from '@app/modules/pdf-viewer/runtime/save/classifyPdfSaveRoute';
import type {
    IPdfSaveByteRouteDecision,
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
    IPdfViewerSaveTransactionSerializedResult,
    TPdfViewerSaveTransactionSource,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import type {
    ISerializationPlan,
    ISerializationPlanInputs,
} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { buildSerializationPlan } from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { projectAnnotationBackendMutations } from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';
import type {ICanonicalAnnotationIdentityBinding} from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-annotations/applyCanonicalAnnotationIdentityBindings';
import {bindCanonicalAnnotationIdentitiesOffThread} from '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/bindCanonicalAnnotationIdentitiesOffThread';
import type {
    AnnotationApplication,
    IAnnotationSaveVerificationOptions,
} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { isPdfDocumentUsable } from '@app/utils/isPdfDocumentUsable';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';

const PDF_SAVE_TIMEOUT_QUIESCE_MS = 2_000;
const DEFAULT_TRANSACTION_SAVE_MODE = 'rewrite';
const AVAILABLE_SERIALIZATION_BACKENDS = [
    'native-append',
    'pdfjs-save-document',
    'pdf-lib-rewrite',
] as const;

interface IUsePdfViewerSaveTransactionOptions {
    materializePdfJsDocumentForInternalUse?: () => Promise<Uint8Array | null>;
    /**
     * Production sessions pass their live authorities. The callback variants
     * below remain only as narrow test/workspace-save seams.
     */
    pdfDocument?: ShallowRef<PDFDocumentProxy | null>;
    annotationUiManager?: ShallowRef<AnnotationEditorUIManager | null>;
    annotationApplication?: ShallowRef<AnnotationApplication>;
    documentRevisionToken?: ComputedRef<TDocumentRevisionToken | null>;
    flushAnnotationMutationsForSave?: () => Promise<unknown>;
    commitPdfEditorsForSave?: () => Promise<void>;
    getPdfDocument?: () => PDFDocumentProxy | null;
    getMarkupSubtypeOverrides?: () => Map<string, TMarkupSubtype> | undefined;
    getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
    getAllShapes?: () => IShapeAnnotation[];
    getDeletedEmbeddedShapeAnnotationIds?: () => string[];
    getDeletedEmbeddedShapeStableKeys?: () => string[];
    ensureManagedShapeBaselineReady?: () => Promise<void>;
    prepareAnnotationSave?: () => {
        plan?: ISerializationPlan;
        verify(bytes: Uint8Array): Promise<void>;
        verifyPath?(
            path: string,
            knownSize: number,
            options?: IAnnotationSaveVerificationOptions,
        ): Promise<void>;
        assertCurrent?(): Promise<void> | void;
        recordMaterializedIdentityBinding?(binding: ICanonicalAnnotationIdentityBinding): void;
        commit(): void;
    };
}

interface ISavePdfDocumentWithCommittedEditorsOptions {
    pdfDocument: PDFDocumentProxy | null;
    annotationUiManager: AnnotationEditorUIManager | null;
    getCurrentPdfDocument?: () => PDFDocumentProxy | null;
    isPdfDocumentCurrent?: (pdfDocument: PDFDocumentProxy) => boolean;
    commitEditors?: boolean;
}

async function waitForCommittedEditorsToSettle() {
    await nextTick();
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        return;
    }
    await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve());
        });
    });
    await nextTick();
}

function isSaveTargetCurrent(
    options: ISavePdfDocumentWithCommittedEditorsOptions,
    pdfDocument: PDFDocumentProxy,
) {
    return isPdfDocumentUsable(pdfDocument)
        && (!options.getCurrentPdfDocument || options.getCurrentPdfDocument() === pdfDocument)
        && options.isPdfDocumentCurrent?.(pdfDocument) !== false;
}

export async function commitPdfEditorsForSave(annotationUiManager: AnnotationEditorUIManager | null) {
    annotationUiManager?.commitOrRemove();
    await waitForCommittedEditorsToSettle();
}

/**
 * Raw PDF.js materialization remains public for the viewer expose contract,
 * but its commit/settle/current-document fence is owned by the save
 * transaction rather than a second save adapter.
 */
export async function savePdfDocumentWithCommittedEditors(
    options: ISavePdfDocumentWithCommittedEditorsOptions,
) {
    const pdfDocument = options.pdfDocument;
    if (!pdfDocument || !isSaveTargetCurrent(options, pdfDocument)) {
        return null;
    }
    if (options.commitEditors !== false) {
        await commitPdfEditorsForSave(options.annotationUiManager);
    }
    if (!isSaveTargetCurrent(options, pdfDocument)) {
        return null;
    }
    try {
        const savedBytes = await pdfDocument.saveDocument();
        return isSaveTargetCurrent(options, pdfDocument) ? savedBytes : null;
    } catch (error) {
        if (!isSaveTargetCurrent(options, pdfDocument)) {
            return null;
        }
        throw error;
    }
}

async function collectPreexistingPdfAnnotationRefs(
    doc: PDFDocumentProxy | null | undefined,
    plan: ISerializationPlan,
) {
    if (!doc) {
        return [];
    }
    const pageIndexes = new Set(projectAnnotationBackendMutations(plan, 'pdfjs-save-document')
        .filter(mutation => mutation.operation === 'bind-identities')
        .map(mutation => mutation.fields.pageIndex)
        .filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0));
    const refs = new Set<string>();
    await Promise.all(Array.from(pageIndexes, async (pageIndex) => {
        const page = await doc.getPage(pageIndex + 1);
        const annotations = await page.getAnnotations({intent: 'display'});
        annotations.forEach((annotation: {id?: unknown}) => {
            const id = typeof annotation.id === 'string'
                ? normalizePdfJsAnnotationId(annotation.id)
                : null;
            if (id) refs.add(id);
        });
    }));
    return Array.from(refs);
}

class PdfViewerSaveDocumentTimeoutError extends Error {
    constructor(public readonly settlePromise: Promise<void>) {
        super('PDF.js saveDocument timed out');
        this.name = 'PdfViewerSaveDocumentTimeoutError';
    }
}

function logSaveRouteDecision(
    request: IPdfViewerSaveTransactionRequest,
    decision: TPdfSaveRouteDecision,
) {
    const {
        canonical,
        annotationPlan,
    } = decision;
    BrowserLogger.debug('workspace', 'Planned PDF annotation save route', {
        route: decision.route,
        annotationRoute: annotationPlan.route,
        expectedCost: annotationPlan.expectedCost,
        reason: annotationPlan.reason,
        nativeRejection: decision.route === 'native-append' ? null : decision.nativeRejection,
        liveAnnotationIds: Array.from(canonical.liveAnnotationChanges.ids),
        replayableLiveEditorNoteIds: Array.from(canonical.liveAnnotationChanges.replayableEditorNoteIds),
        replayableAnnotationIds: Array.from(canonical.replayableEmbeddedAnnotationIds),
        unreplayableLiveAnnotationIds: annotationPlan.unreplayableLiveAnnotationIds,
        pendingTexts: canonical.pendingTexts.size,
        pendingDeletes: canonical.pendingDeletes.length,
        forcePdfjsMaterialize: request.forcePdfjsMaterialize === true,
    });
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
    const getPdfDocument = () => options.pdfDocument?.value ?? options.getPdfDocument?.() ?? null;
    async function materializePdfJsDocumentForInternalUse(commitEditors = true) {
        if (options.materializePdfJsDocumentForInternalUse) {
            return options.materializePdfJsDocumentForInternalUse();
        }
        return savePdfDocumentWithCommittedEditors({
            pdfDocument: getPdfDocument(),
            annotationUiManager: options.annotationUiManager?.value ?? null,
            getCurrentPdfDocument: getPdfDocument,
            commitEditors,
        });
    }

    function prepareAnnotationSave() {
        if (options.prepareAnnotationSave) {
            return options.prepareAnnotationSave();
        }
        const application = options.annotationApplication?.value;
        if (!application) {
            return undefined;
        }
        const session = application.beginSave(options.documentRevisionToken?.value ?? null);
        return {
            plan: session.plan,
            verify: (bytes: Uint8Array) => application.verifySaveBytes(session, bytes),
            verifyPath: (
                path: string,
                knownSize: number,
                verificationOptions?: IAnnotationSaveVerificationOptions,
            ) => application.verifySavePath(session, path, knownSize, verificationOptions),
            assertCurrent: () => application.assertSaveCurrent(session),
            recordMaterializedIdentityBinding: (binding: ICanonicalAnnotationIdentityBinding) =>
                application.recordMaterializedIdentityBinding(session, binding.annotationId, binding.pdfRef),
            commit: () => application.acknowledgeSave(session),
        };
    }

    async function runSaveDocumentAttemptWithTimeout() {
        const savePromise = (async () => {
            // The transaction committed and settled the editor frontier before
            // route selection. Do not commit it a second time while
            // materializing the selected PDF.js byte route.
            const data = await materializePdfJsDocumentForInternalUse(false);
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
        onIdentityBound?: ((binding: ICanonicalAnnotationIdentityBinding) => void) | undefined;
    }) {
        if (input.request.annotationSerializationPlan) {
            projectAnnotationBackendMutations(input.request.annotationSerializationPlan, 'pdfjs-save-document');
        }
        const newPdfJsAnnotationEditorOrder = collectNewPdfJsAnnotationStorageEditorOrder(
            getPdfDocument(),
        );
        const preexistingPdfAnnotationRefs = input.request.annotationSerializationPlan
            ? await collectPreexistingPdfAnnotationRefs(
                getPdfDocument(),
                input.request.annotationSerializationPlan,
            )
            : [];
        try {
            const materialized = await saveDocumentWithRetry();
            if (!materialized || !input.request.annotationSerializationPlan) {
                return materialized;
            }
            const bindingResult = await bindCanonicalAnnotationIdentitiesOffThread(
                materialized,
                [],
                projectAnnotationBackendMutations(input.request.annotationSerializationPlan, 'pdfjs-save-document'),
                {
                    newPdfJsAnnotationEditorOrder,
                    preexistingPdfAnnotationRefs,
                    ...(input.onIdentityBound ? {onIdentityBound: input.onIdentityBound} : {}),
                },
            );
            return bindingResult.data;
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
        byteRoute: IPdfSaveByteRouteDecision;
        onIdentityBound?: ((binding: ICanonicalAnnotationIdentityBinding) => void) | undefined;
    }) {
        if (input.byteRoute.baseBytes === 'loaded-source') {
            return readSourcePdfBytes(input.request);
        }

        return materializePdfJsBytesWithFallback({
            request: input.request,
            onIdentityBound: input.onIdentityBound,
            sourceFallbackAllowed: input.byteRoute.sourceFallbackAllowed,
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
        if (
            request.serializeResult === true
            || request.includeManagedShapes === true
            || request.rewriteShapeState === true
            || request.forceRewrite === true
        ) {
            await options.ensureManagedShapeBaselineReady?.();
        }
        const pdfjsLiveChangesBeforeCommit = collectLivePdfJsAnnotationChangeIds(getPdfDocument());
        if (!request.planOnly) {
            await options.flushAnnotationMutationsForSave?.();
            if (options.annotationUiManager) {
                await commitPdfEditorsForSave(options.annotationUiManager.value);
            } else {
                await options.commitPdfEditorsForSave?.();
            }
        }
        const capturedPdfjsLiveChanges = collectLivePdfJsAnnotationChangeIds(getPdfDocument());
        const canonicalSave = prepareAnnotationSave();
        // Complete the annotation frontier into the global immutable save plan
        // before route selection. From this point onward no backend is allowed to
        // sample metadata or route constraints from mutable UI state.
        const planInputs: ISerializationPlanInputs = {
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
                    : AVAILABLE_SERIALIZATION_BACKENDS,
            },
            postconditions: {expectedPageCount: request.documentStructure?.totalPages ?? null},
        };
        const frontierPlan = canonicalSave?.plan;
        const globalSerializationPlan = frontierPlan
            ? buildSerializationPlan(frontierPlan.frontier, frontierPlan.expected, frontierPlan.entities, planInputs)
            : buildSerializationPlan({
                documentRevisionToken: null,
                epoch: 0,
                entityBaselineHash: 'no-canonical-annotation-frontier',
                revisions: new Map(),
            }, [], [], planInputs);
        request = {
            ...request,
            annotationSerializationPlan: globalSerializationPlan,
        };
        let nativeVerificationOptions: IAnnotationSaveVerificationOptions | undefined;
        const canonicalSaveCallbacks = {
            verifyAnnotationSave: (bytes: Uint8Array) => canonicalSave?.verify(bytes) ?? Promise.resolve(),
            verifyAnnotationSavePath: (path: string, knownSize: number) => canonicalSave?.verifyPath?.(
                path,
                knownSize,
                nativeVerificationOptions,
            )
                ?? Promise.reject(new Error('Path-backed annotation verification is unavailable')),
            commitAnnotationSave: () => canonicalSave?.commit(),
            assertAnnotationSaveCurrent: async () => {
                await canonicalSave?.assertCurrent?.();
                const currentPdfjsLiveChanges = collectLivePdfJsAnnotationChangeIds(getPdfDocument());
                if (currentPdfjsLiveChanges.fingerprint !== capturedPdfjsLiveChanges.fingerprint) {
                    throw new Error('staleRevisionError: PDF.js annotations changed after the save frontier was captured');
                }
            },
        };
        // Routing is decided exactly once, here; every projector below consumes the result.
        const decision: TPdfSaveRouteDecision = request.routeDecision ?? classifyPdfSaveRoute(globalSerializationPlan, {
            saveFlowMode: request.saveFlowMode ?? 'save',
            availableBackends: AVAILABLE_SERIALIZATION_BACKENDS,
            nativeCapabilities: request.nativeCapabilities,
            dirtyState: request.dirtyState,
            documentStructure: request.documentStructure,
            liveAnnotationChanges: mergeLivePdfJsAnnotationChanges(
                pdfjsLiveChangesBeforeCommit,
                capturedPdfjsLiveChanges,
            ),
            hasLoadedSource: Boolean(request.source),
            forcePdfjsMaterialize: request.forcePdfjsMaterialize === true,
            includeManagedShapesForLiveSource: request.includeManagedShapes === true,
            totalPageCount: Math.max(
                request.documentStructure?.totalPages ?? 0,
                getPdfDocument()?.numPages ?? 0,
            ),
            shapes: request.dirtyState?.shapeStateDirty ? options.getAllShapes?.() ?? null : null,
            deletedEmbeddedShapeAnnotationIds: request.dirtyState?.shapeStateDirty
                ? options.getDeletedEmbeddedShapeAnnotationIds?.() ?? []
                : [],
            deletedEmbeddedShapeStableKeys: request.dirtyState?.shapeStateDirty
                ? options.getDeletedEmbeddedShapeStableKeys?.() ?? []
                : [],
            markupSubtypeOverrides: request.markupSubtypeOverrides ?? options.getMarkupSubtypeOverrides?.(),
            markupSubtypeHints: request.markupSubtypeHints ?? options.getMarkupSubtypeHints?.() ?? [],
        });
        const annotationSavePlan = decision.annotationPlan;
        logSaveRouteDecision(request, decision);
        if (decision.route === 'native-append') {
            const nativeMutationProjection = decision.nativeMutationProjection;
            if (decision.replayableAnnotationMutationsAllowed && decision.annotationRoute.route !== 'source-replay') {
                throw new Error(`Native annotation replay was granted on the ${decision.annotationRoute.route} route`);
            }
            if (Object.keys(nativeMutationProjection.mutations).length === 0) {
                throw new Error('Native append was granted without a mutation program');
            }
            if (
                !decision.replayableAnnotationMutationsAllowed
                && (
                    nativeMutationProjection.noteTextUpdates.length > 0
                    || nativeMutationProjection.freeTextNotes.length > 0
                    || nativeMutationProjection.annotationDeletes.length > 0
                )
            ) {
                throw new Error('Native annotation mutations were projected without a source-replay grant');
            }
            if (
                !decision.metadataMutationsAllowed
                && (nativeMutationProjection.hasMetadataMutations || nativeMutationProjection.hasShapeMutations)
            ) {
                throw new Error('Structured native mutations were projected without capability');
            }
            nativeVerificationOptions = {preexistingPdfAnnotationRefs: await collectPreexistingPdfAnnotationRefs(
                getPdfDocument(),
                globalSerializationPlan,
            )};
            return {
                source: 'native-mutation-projection',
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection,
                fallbackDecision: decision.fallback,
                annotationSavePlan,
                ...canonicalSaveCallbacks,
            };
        }

        const byteRoute = decision;
        if (request.planOnly) {
            return {
                source: byteRoute.route,
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection: null,
                fallbackDecision: byteRoute,
                annotationSavePlan,
                ...canonicalSaveCallbacks,
            };
        }

        const baseBytes = await selectBaseBytes({
            request,
            byteRoute,
            onIdentityBound: canonicalSave?.recordMaterializedIdentityBinding,
        });
        const serializedBytes = await serializeResultBytes({
            request,
            baseBytes,
        });
        const resultSource: TPdfViewerSaveTransactionSource = request.source
            ? serializedBytes ? 'serialized-rewrite' : byteRoute.route
            : 'pdfjs-materialize';
        const serializedResult = createSerializedResult({
            request,
            resultSource,
            serializedBytes,
        });

        return {
            source: resultSource,
            baseBytes: serializedBytes ? null : request.source ? baseBytes : null,
            serializedBytes: serializedResult ? null : serializedBytes,
            serializedResult,
            nativeMutationProjection: null,
            fallbackDecision: byteRoute,
            annotationSavePlan,
            ...canonicalSaveCallbacks,
        };
    }

    return {
        commitPdfEditorsForSave: () => commitPdfEditorsForSave(options.annotationUiManager?.value ?? null),
        materializePdfJsDocumentForInternalUse: () => materializePdfJsDocumentForInternalUse(),
        runSaveTransaction,
        saveViewerDocument: () => materializePdfJsDocumentForInternalUse(),
    };
};
