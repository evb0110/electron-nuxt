import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type { IPdfPathSource } from '@app/types/pdfUi';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
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
    let stopWatchingSurface: (() => void) | null = null;
    let stopWatchingInvalidation: (() => void) | null = null;
    let generation: number | null = null;

    function dispose(reason: string, clearPreview = true) {
        if (disposed) {
            return;
        }
        disposed = true;
        stopWatchingSurface?.();
        stopWatchingSurface = null;
        stopWatchingInvalidation?.();
        stopWatchingInvalidation = null;
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

    void (async () => {
        const resolution = await options.geometryResolution;
        if (
            canceled
            || !options.isCurrent()
            || resolution.openingGeometry === null
            || resolution.sourceRevision === null
            || !shouldStageNativePdfOpeningPreview(options.source, resolution.openingGeometry)
        ) {
            return;
        }
        const snapshot = options.openSurface.snapshot.value;
        const identity = snapshot.identity;
        if (
            identity === null
            || identity.documentId !== resolution.sourceRevision.documentId
            || snapshot.openingPageFrame?.pageNumber !== resolution.openingGeometry.pageNumber
        ) {
            return;
        }
        generation = snapshot.generation;
        const sourceRevisionKey = `${String(resolution.sourceRevision.size)}:${String(resolution.sourceRevision.modifiedAt)}`;
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
