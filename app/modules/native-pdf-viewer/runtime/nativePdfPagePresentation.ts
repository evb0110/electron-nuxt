import type { IDocumentPreviewPageState } from '@app/utils/document-viewer/pagePreviewSource';

interface INativePdfPageShellLayout {
    height: number;
    top: number;
    width: number;
}

export function createIdleNativePdfPageState(): IDocumentPreviewPageState {
    return {
        failedRenderPx: 0,
        objectUrl: null,
        renderedPx: 0,
        status: 'idle',
        token: 0,
    };
}

export function preloadNativePdfPageObjectUrl(objectUrl: string) {
    if (typeof Image === 'undefined') {
        return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Failed to decode PDF page preview'));
        image.src = objectUrl;
    });
}

export function resolveNativePdfPageShellStyle(options: {
    gutterPx: number;
    layout: INativePdfPageShellLayout | null | undefined;
    surfaceWidth: number;
}) {
    if (!options.layout) {
        return {};
    }
    return {
        left: `${Math.max(options.gutterPx, Math.round((options.surfaceWidth - options.layout.width) / 2))}px`,
        top: `${options.layout.top}px`,
        width: `${options.layout.width}px`,
        height: `${options.layout.height}px`,
    };
}
