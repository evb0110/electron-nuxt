import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { TPdfSaveMode } from '@app/types/pdfContracts';
import type { IPdfSaveResult } from '@app/types/pdfUi';
import { isTimeoutError } from '@contracts/isTimeoutError';
import { delay } from 'es-toolkit/promise';
import { PDF_SAVE_TIMEOUT_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    buildPdfAnnotationSavePlan,
    collectLivePdfJsAnnotationChangeIds,
    getPdfAnnotationIdFromStableKey,
    isReplayableEditorOnlyFreeTextNote,
} from '@app/modules/pdf-viewer/public';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import type { IFileOperationsSavePdfPorts } from '@app/modules/workspace-shell/composables/file-operations/saveRolePorts';

const PDF_SAVE_TIMEOUT_QUIESCE_MS = 2_000;

export interface ISerializationBasePdfBytesOptions {
    forcePdfjsMaterialize?: boolean;
    pendingDeletes?: IAnnotationCommentSummary[] | null;
    pendingTexts?: Map<string, string> | null;
}

export interface IBuildSerializedSaveResultOptions {
    forceRewrite?: boolean;
    includeShapes?: boolean;
    rewriteShapeState?: boolean;
    saveMode?: TPdfSaveMode;
    annotationCommentsSnapshot?: IAnnotationCommentSummary[];
}

export interface IFileOperationsSaveSourcePorts {pdf: IFileOperationsSavePdfPorts;}

export interface IFileOperationsSaveSourceServices {
    getAnnotationCommentsForSave: () => IAnnotationCommentSummary[];
    logSavePhase: (
        phase: string,
        startedAtMs: number,
        data?: Record<string, unknown>,
        slowThresholdMs?: number,
    ) => void;
    nowMs: () => number;
    timedSavePhase: <T>(
        phase: string,
        operation: () => Promise<T>,
        describeResult?: (result: T) => Record<string, unknown>,
    ) => Promise<T>;
}

class SaveDocumentTimeoutError extends Error {
    constructor(public readonly settlePromise: Promise<void>) {
        super('PDF.js saveDocument timed out');
        this.name = 'SaveDocumentTimeoutError';
    }
}

export function createFileOperationsSaveSource(
    ports: IFileOperationsSaveSourcePorts,
    services: IFileOperationsSaveSourceServices,
) {
    const { pdf } = ports;

    function hasUnreplayableEditorOnlyAnnotationsPendingMaterialization() {
        return services.getAnnotationCommentsForSave().some(comment =>
            comment.source === 'editor'
            && !parsePdfJsAnnotationRef(comment.annotationId)
            && !isReplayableEditorOnlyFreeTextNote(comment),
        );
    }

    async function buildSerializedSaveResult(
        rawData: Uint8Array,
        pendingTexts: Map<string, string> | null,
        pendingDeletes: IAnnotationCommentSummary[] | null,
        opts?: IBuildSerializedSaveResultOptions,
    ): Promise<IPdfSaveResult | null> {
        const serializeOptions: NonNullable<Parameters<typeof pdf.serialization.serializePdfForSave>[1]> = {
            annotationCommentsSnapshot: opts?.annotationCommentsSnapshot ?? services.getAnnotationCommentsForSave(),
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
        const data = await services.timedSavePhase(
            'serialize-pdf-for-save',
            () => pdf.serialization.serializePdfForSave(rawData, serializeOptions),
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

    async function runSaveDocumentAttemptWithTimeout() {
        const savePromise = (async () => {
            const result = await pdf.source.runSaveTransaction({
                mode: 'pdfjs-materialize',
                forcePdfjsMaterialize: true,
            });
            const data = result.serializedBytes ?? result.baseBytes;
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
            const attemptStartedAtMs = services.nowMs();
            try {
                const data = await runSaveDocumentAttemptWithTimeout();
                services.logSavePhase('pdfjs-save-document', attemptStartedAtMs, {
                    attempt,
                    maxAttempts,
                    bytes: data.byteLength,
                });
                return data;
            } catch (error) {
                const timedOut = error instanceof SaveDocumentTimeoutError || isTimeoutError(error);
                const durationMs = Math.round(services.nowMs() - attemptStartedAtMs);
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
        services.getAnnotationCommentsForSave()
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

    function buildAnnotationSavePlan(opts?: ISerializationBasePdfBytesOptions) {
        const liveChanges = collectLivePdfJsAnnotationChangeIds(pdf.source.pdfDocument.value);
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

    function canUseSourceBytesForReplayableEmbeddedChanges(opts?: ISerializationBasePdfBytesOptions) {
        const plan = buildAnnotationSavePlan(opts);
        return plan.route === 'source-replay';
    }

    async function getSerializationBasePdfBytes(opts?: ISerializationBasePdfBytesOptions) {
        const liveChanges = collectLivePdfJsAnnotationChangeIds(pdf.source.pdfDocument.value);
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
            return services.timedSavePhase(
                'read-source-pdf-bytes',
                pdf.source.getSourcePdfData,
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
            return services.timedSavePhase(
                'read-source-pdf-bytes-after-pdfjs-fallback',
                pdf.source.getSourcePdfData,
                result => ({ bytes: result?.byteLength ?? null }),
            );
        }
    }

    return {
        buildAnnotationSavePlan,
        buildSerializedSaveResult,
        canUseSourceBytesForReplayableEmbeddedChanges,
        getSerializationBasePdfBytes,
    };
}
