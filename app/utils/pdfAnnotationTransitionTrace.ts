import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

const annotationEditorLayerIdentities = new WeakMap<HTMLElement, number>();
let nextAnnotationEditorLayerIdentity = 1;

function getAnnotationEditorLayerIdentity(layer?: HTMLElement | null) {
    if (!layer) {
        return null;
    }
    const existing = annotationEditorLayerIdentities.get(layer);
    if (existing !== undefined) {
        return existing;
    }
    const identity = nextAnnotationEditorLayerIdentity++;
    annotationEditorLayerIdentities.set(layer, identity);
    return identity;
}

export function traceAnnotationEditorLayer(
    phase: string,
    pageNumber: number,
    renderToken: number,
    layer?: HTMLElement | null,
    detail: Record<string, unknown> = {},
) {
    logPdfRenderTrace('annotation-editor-layer', {
        phase,
        pageNumber,
        renderToken,
        layerIdentity: getAnnotationEditorLayerIdentity(layer),
        layerConnected: layer?.isConnected ?? null,
        layerHidden: layer?.hidden ?? null,
        editorCount: layer?.childElementCount ?? 0,
        ...detail,
    });
}

export function traceAnnotationSync(
    phase: string,
    documentGeneration: number,
    revisionToken: unknown,
    syncToken: number,
    editorCount?: number,
    canonicalCount?: number,
    detail: Record<string, unknown> = {},
) {
    logPdfRenderTrace('annotation-sync', {
        phase,
        documentGeneration,
        revisionToken: revisionToken ?? null,
        syncToken,
        editorCount: editorCount ?? null,
        canonicalCount: canonicalCount ?? null,
        sidebarCount: canonicalCount ?? null,
        ...detail,
    });
}
