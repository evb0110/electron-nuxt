interface IActiveEmptyWorkspacePremountHost {
    requestAnimationFrame: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame: (handle: number) => void;
}

export function scheduleActiveEmptyWorkspacePremount(
    onReady: () => void,
    host: IActiveEmptyWorkspacePremountHost = window,
) {
    let cancelled = false;
    let firstFrameHandle: number | null = null;
    let premountFrameHandle: number | null = null;

    firstFrameHandle = host.requestAnimationFrame(() => {
        firstFrameHandle = null;
        if (cancelled) {
            return;
        }
        premountFrameHandle = host.requestAnimationFrame(() => {
            premountFrameHandle = null;
            if (!cancelled) {
                onReady();
            }
        });
    });

    return () => {
        cancelled = true;
        if (firstFrameHandle !== null) {
            host.cancelAnimationFrame(firstFrameHandle);
            firstFrameHandle = null;
        }
        if (premountFrameHandle !== null) {
            host.cancelAnimationFrame(premountFrameHandle);
            premountFrameHandle = null;
        }
    };
}
