import type { IScrollSnapshot } from '@app/types/pdf';

export interface IPdfReloadWaiterViewer {
    scrollToPage: (page: number) => void;
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: { fallbackPage?: number | null; },
    ) => void;
    waitForViewerLoadSettled?: () => Promise<void>;
}
