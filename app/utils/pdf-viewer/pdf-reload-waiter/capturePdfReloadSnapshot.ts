import type { IScrollSnapshot } from '@app/types/pdf';

interface IPdfReloadWaiterViewer {
    scrollToPage: (page: number) => void;
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: { fallbackPage?: number | null; },
    ) => void;
    waitForViewerLoadSettled?: () => Promise<void>;
}

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
