import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { IPdfPathSource } from '@app/types/pdfUi';
import type {
    IDocumentOpenSurfaceSession,
    IDocumentOpenSurfaceSnapshot,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { getErrorMessage } from '@app/utils/error';
import { createNativePdfPreviewSourceFromPath } from '@app/platform/browser-api/public';
import { shouldStageNativePdfOpeningPreview } from '@app/modules/pdf-viewer/public/nativePreviewRouting';
import type { IPdfValidationSourceRevision } from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';

type TNativePreviewFiles = Parameters<typeof createNativePdfPreviewSourceFromPath>[1];

export interface IPdfOpeningGeometryResolution {
    readonly openingGeometry: IPdfOpeningGeometry | null;
    readonly sourceRevision: IPdfValidationSourceRevision | null;
}

export interface IStagedPdfOpeningPreview {cancel(reason: string): void;}

function isOpeningTransitionPhase(phase: IDocumentOpenSurfaceSnapshot['phase']) {
    return phase === 'pending'
        || phase === 'geometry-committed'
        || phase === 'canvas-committed'
        || phase === 'viewport-committed';
}

function resolveTargetWidth(
    surface: IDocumentOpenSurfaceSession,
    geometry: IPdfOpeningGeometry,
) {
    const frameWidth = Number.parseFloat(
        surface.snapshot.value.openingPageFrame?.style.width ?? '',
    );
    const cssWidth = Number.isFinite(frameWidth) && frameWidth > 0
        ? frameWidth
        : geometry.width;
    const pixelRatio = typeof window === 'undefined'
        ? 1
        : Math.max(1, window.devicePixelRatio || 1);
    return Math.min(4_096, Math.max(64, Math.ceil(cssWidth * pixelRatio)));
}

export function stagePdfOpeningPreview(options: {
    readonly documentFiles: TNativePreviewFiles;
    readonly geometryResolution: Promise<IPdfOpeningGeometryResolution>;
    readonly isCurrent: () => boolean;
    readonly openSurface: IDocumentOpenSurfaceSession;
    readonly source: IPdfPathSource;
    readonly traceContext?: Readonly<Record<string, unknown>>;
}): IStagedPdfOpeningPreview {
    let canceled = false;
    let disposed = false;
    let objectUrl: string | null = null;
    let source: ReturnType<typeof createNativePdfPreviewSourceFromPath> | null = null;
    let stopWatchingOpeningFrame: (() => void) | null = null;
    let stopWatchingSurface: (() => void) | null = null;
    let stopWatchingInvalidation: (() => void) | null = null;
    let resolveOpeningFrameWait: ((snapshot: IDocumentOpenSurfaceSnapshot | null) => void) | null = null;
    let generation: number | null = null;

    function cancelOpeningFrameWait() {
        const resolveWait = resolveOpeningFrameWait;
        resolveOpeningFrameWait = null;
        resolveWait?.(null);
        stopWatchingOpeningFrame?.();
        stopWatchingOpeningFrame = null;
    }

    function dispose(reason: string, clearPreview = true) {
        if (disposed) {
            return;
        }
        disposed = true;
        cancelOpeningFrameWait();
        stopWatchingSurface?.();
        stopWatchingSurface = null;
        stopWatchingInvalidation?.();
        stopWatchingInvalidation = null;
        resolveOpeningFrameWait?.(null);
        resolveOpeningFrameWait = null;
        if (clearPreview && generation !== null && objectUrl !== null) {
            options.openSurface.clearOpeningPagePreview(generation, objectUrl);
        }
        source?.terminate();
        source = null;
        logPdfRenderTrace('pdf-open-native-preview-retired', {
            ...options.traceContext,
            reason,
        });
    }

    function waitForOpeningFrame(input: {
        documentId: string;
        openingGeometry: IPdfOpeningGeometry;
        pageNumber: number;
        sourceRevisionKey: string;
    }): Promise<IDocumentOpenSurfaceSnapshot | null> {
        // One preview attempt owns one generation-bound watcher. Replacement,
        // cancellation, and disposal all settle it through
        // cancelOpeningFrameWait, so no observer can survive its attempt.
        cancelOpeningFrameWait();
        let boundGeneration: number | null = null;
        const inspect = (snapshot: IDocumentOpenSurfaceSnapshot) => {
            if (
                canceled
                || disposed
                || !options.isCurrent()
            ) {
                return null;
            }
            if (!isOpeningTransitionPhase(snapshot.phase)) {
                return snapshot.identity?.documentId === input.documentId
                    && (snapshot.phase === 'ready' || snapshot.phase === 'failed')
                    ? null
                    : undefined;
            }
            if (snapshot.identity?.documentId !== input.documentId) {
                return undefined;
            }
            boundGeneration ??= snapshot.generation;
            if (snapshot.generation !== boundGeneration) {
                return null;
            }
            if (snapshot.openingPageGeometry === null && snapshot.phase === 'pending') {
                options.openSurface.commitOpeningPageGeometry(snapshot.generation, {
                    documentId: input.documentId,
                    ...input.openingGeometry,
                });
                return undefined;
            }
            const frame = snapshot.openingPageFrame;
            if (
                frame?.generation === boundGeneration
                && frame.pageNumber === input.pageNumber
                && frame.sourceRevisionKey === input.sourceRevisionKey
            ) {
                return snapshot;
            }
            return undefined;
        };
        const initial = inspect(options.openSurface.snapshot.value);
        if (initial !== undefined) {
            return Promise.resolve(initial);
        }
        return new Promise((resolve) => {
            let settled = false;
            const settle = (snapshot: IDocumentOpenSurfaceSnapshot | null) => {
                if (settled) {
                    return;
                }
                settled = true;
                stopWatchingOpeningFrame?.();
                stopWatchingOpeningFrame = null;
                resolveOpeningFrameWait = null;
                resolve(snapshot);
            };
            resolveOpeningFrameWait = settle;
            stopWatchingOpeningFrame = watch(
                () => options.openSurface.snapshot.value,
                (snapshot) => {
                    const result = inspect(snapshot);
                    if (result !== undefined) {
                        settle(result);
                    }
                },
                {flush: 'sync'},
            );
            const current = inspect(options.openSurface.snapshot.value);
            if (current !== undefined) {
                settle(current);
            }
        });
    }

    void (async () => {
        logPdfRenderTrace('pdf-open-native-preview-resolution-start', options.traceContext);
        const resolution = await options.geometryResolution;
        const shouldStage = shouldStageNativePdfOpeningPreview(options.source, resolution.openingGeometry);
        const resolvedSnapshot = options.openSurface.snapshot.value;
        logPdfRenderTrace('pdf-open-native-preview-resolution-end', {
            ...options.traceContext,
            canceled,
            current: options.isCurrent(),
            documentId: resolvedSnapshot.identity?.documentId ?? null,
            hasOpeningGeometry: resolution.openingGeometry !== null,
            hasSourceRevision: resolution.sourceRevision !== null,
            pageCount: resolution.openingGeometry?.pageCount ?? null,
            phase: resolvedSnapshot.phase,
            size: resolution.openingGeometry?.size ?? null,
            sourceSize: options.source.size,
            sourceRevisionDocumentId: resolution.sourceRevision?.documentId ?? null,
            shouldStage,
        });
        if (
            canceled
            || !options.isCurrent()
            || resolution.openingGeometry === null
            || resolution.sourceRevision === null
            || !shouldStage
        ) {
            return;
        }
        const sourceRevisionKey = `${String(resolution.sourceRevision.size)}:${String(resolution.sourceRevision.modifiedAt)}`;
        logPdfRenderTrace('pdf-open-native-preview-frame-wait-start', {
            ...options.traceContext,
            pageNumber: resolution.openingGeometry.pageNumber,
            sourceRevisionKey,
        });
        const snapshot = await waitForOpeningFrame({
            documentId: resolution.sourceRevision.documentId,
            openingGeometry: resolution.openingGeometry,
            pageNumber: resolution.openingGeometry.pageNumber,
            sourceRevisionKey,
        });
        generation = snapshot?.generation ?? null;
        logPdfRenderTrace('pdf-open-native-preview-frame-wait-end', {
            ...options.traceContext,
            generation,
            matched: snapshot !== null,
            pageNumber: resolution.openingGeometry.pageNumber,
            sourceRevisionKey,
        });
        if (snapshot === null || canceled || !options.isCurrent()) {
            return;
        }
        const targetWidthPx = resolveTargetWidth(options.openSurface, resolution.openingGeometry);
        logPdfRenderTrace('pdf-open-native-preview-submit', {
            ...options.traceContext,
            generation,
            pageNumber: resolution.openingGeometry.pageNumber,
            sourceRevisionKey,
            targetWidthPx,
        });
        const previewSource = createNativePdfPreviewSourceFromPath(options.source.path, options.documentFiles);
        source = previewSource;
        const rendered = await previewSource.renderPageObjectUrl(resolution.openingGeometry.pageNumber, {
            previewRequestId: `pdf-opening:${String(generation)}:${sourceRevisionKey}`,
            targetWidthPx,
        });
        if (canceled || !options.isCurrent()) {
            previewSource.revokeObjectURL(rendered.objectUrl);
            dispose('stale-render-result', false);
            return;
        }
        objectUrl = rendered.objectUrl;
        const current = options.openSurface.snapshot.value;
        const currentRevision = current.identity?.documentRevision;
        const accepted = current.generation === generation
            && current.identity?.documentId === resolution.sourceRevision.documentId
            && currentRevision !== undefined
            && options.openSurface.commitOpeningPagePreview(generation, {
                documentId: resolution.sourceRevision.documentId,
                documentRevision: currentRevision,
                objectUrl,
                pageNumber: resolution.openingGeometry.pageNumber,
                renderedWidth: rendered.renderedPx,
                sourceRevisionKey,
            });
        if (!accepted) {
            previewSource.revokeObjectURL(objectUrl);
            dispose('surface-rejected', false);
            return;
        }
        logPdfRenderTrace('pdf-open-native-preview-committed', {
            ...options.traceContext,
            generation,
            pageNumber: resolution.openingGeometry.pageNumber,
            renderedWidth: rendered.renderedPx,
            sourceRevisionKey,
        });
        stopWatchingInvalidation = rendered.onInvalidated?.(() => {
            if (generation !== null && objectUrl !== null) {
                options.openSurface.clearOpeningPagePreview(generation, objectUrl);
            }
            dispose('memory-pressure', false);
        }) ?? null;
        stopWatchingSurface = watch(
            () => {
                const live = options.openSurface.snapshot.value;
                return [
                    live.generation,
                    live.phase,
                    live.openingPageFrame?.preview?.objectUrl ?? null,
                ] as const;
            },
            ([
                liveGeneration,
                phase,
                liveObjectUrl,
            ]) => {
                if (
                    liveGeneration !== generation
                    || phase === 'ready'
                    || phase === 'failed'
                    || liveObjectUrl !== objectUrl
                ) {
                    dispose(phase === 'ready' ? 'pdfjs-handoff' : 'surface-changed', false);
                }
            },
            {flush: 'sync'},
        );
    })().catch((error: unknown) => {
        if (!canceled) {
            logPdfRenderTrace('pdf-open-native-preview-failed', {
                ...options.traceContext,
                error: getErrorMessage(error),
            });
        }
        dispose(canceled ? 'canceled' : 'render-failed');
    });

    return Object.freeze({cancel(reason: string) {
        canceled = true;
        dispose(reason);
    }});
}
