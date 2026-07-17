interface IRestorableDocumentPageState {
    lease: {release: () => void;} | null;
    unsubscribeInvalidation: (() => void) | null;
}

interface IRestoreDocumentPageSourceActivePresentationOptions<TState extends IRestorableDocumentPageState> {
    beginPending: (pageNumber: number, state: TState) => void;
    getState: (pageNumber: number) => TState | undefined;
    hasDecodedConnectedSurface: (pageNumber: number, state: TState) => boolean;
    isCurrent: () => boolean;
    markReady: (pageNumber: number, state: TState) => void;
    measureViewport: () => void;
    nextRenderTick: () => Promise<unknown>;
    renderMountedPages: () => Promise<void>;
    residentPages: readonly number[];
}

export async function restoreDocumentPageSourceActivePresentation<TState extends IRestorableDocumentPageState>(
    options: IRestoreDocumentPageSourceActivePresentationOptions<TState>,
) {
    options.measureViewport();
    await options.nextRenderTick();
    if (!options.isCurrent()) {
        return;
    }
    for (const pageNumber of options.residentPages) {
        const state = options.getState(pageNumber);
        if (!state?.lease) {
            continue;
        }
        if (options.hasDecodedConnectedSurface(pageNumber, state)) {
            options.markReady(pageNumber, state);
            continue;
        }
        state.unsubscribeInvalidation?.();
        state.lease.release();
        state.unsubscribeInvalidation = null;
        state.lease = null;
        options.beginPending(pageNumber, state);
    }
    if (options.isCurrent()) {
        await options.renderMountedPages();
    }
}
