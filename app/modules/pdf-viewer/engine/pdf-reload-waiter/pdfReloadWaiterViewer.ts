export interface IPdfReloadWaiterViewer {
    scrollToPage: (page: number) => void;
    waitForViewerLoadSettled?: () => Promise<void>;
    getUserViewportInteractionEpoch?: () => number;
}
