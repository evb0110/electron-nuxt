interface IViewerLoadSettleState {
    token: number;
    promise: Promise<void>;
    resolve: () => void;
    settled: boolean;
}

export const useViewerLoadSettle = () => {
    let viewerLoadSettleState: IViewerLoadSettleState = {
        token: 0,
        promise: Promise.resolve(),
        resolve: () => {},
        settled: true,
    };

    function beginViewerLoadSettle(token: number) {
        if (!viewerLoadSettleState.settled) {
            viewerLoadSettleState.resolve();
        }

        let resolvePromise = () => {};
        const promise = new Promise<void>((resolve) => {
            resolvePromise = resolve;
        });
        viewerLoadSettleState = {
            token,
            promise,
            resolve: resolvePromise,
            settled: false,
        };
    }

    function settleViewerLoadSettle(token: number) {
        if (viewerLoadSettleState.token !== token || viewerLoadSettleState.settled) {
            return;
        }

        viewerLoadSettleState.settled = true;
        viewerLoadSettleState.resolve();
    }

    function waitForViewerLoadSettled() {
        return viewerLoadSettleState.promise;
    }

    return {
        beginViewerLoadSettle,
        settleViewerLoadSettle,
        waitForViewerLoadSettled,
        get viewerLoadSettleState() {
            return viewerLoadSettleState;
        },
    };
};
