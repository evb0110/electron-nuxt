import type { IPdfReloadWaiterViewer } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/pdfReloadWaiterViewer';

export function capturePdfReloadSnapshot(
    viewer: IPdfReloadWaiterViewer | null,
    fallbackPage: number,
) {
    const scrollSnapshot = viewer?.captureScrollSnapshot?.() ?? null;
    const anchorPage = typeof scrollSnapshot?.anchorPage === 'number' && Number.isFinite(scrollSnapshot.anchorPage)
        ? Math.max(1, Math.floor(scrollSnapshot.anchorPage))
        : null;

    return {
        scrollSnapshot,
        pageToRestore: anchorPage ?? Math.max(1, Math.floor(fallbackPage)),
    };
}
