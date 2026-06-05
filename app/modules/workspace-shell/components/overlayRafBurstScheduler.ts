interface IRafHost {
    requestAnimationFrame(callback: FrameRequestCallback): number;
    cancelAnimationFrame(handle: number): void;
}

export function createRafBurstScheduler(
    callback: () => void,
    rafHost?: IRafHost,
) {
    const host = rafHost ?? (typeof window !== 'undefined' ? window : undefined);
    let frameId: number | null = null;
    let remainingFrames = 0;

    const runFrame = () => {
        frameId = null;
        callback();
        remainingFrames = Math.max(0, remainingFrames - 1);
        if (remainingFrames > 0 && host) {
            frameId = host.requestAnimationFrame(runFrame);
        }
    };

    return {
        request(frames = 1) {
            const normalizedFrames = Math.max(1, Math.round(frames));
            if (!host) {
                callback();
                return;
            }

            remainingFrames = Math.max(remainingFrames, normalizedFrames);
            if (frameId !== null) {
                return;
            }

            frameId = host.requestAnimationFrame(runFrame);
        },
        cancel() {
            if (host && frameId !== null) {
                host.cancelAnimationFrame(frameId);
            }
            frameId = null;
            remainingFrames = 0;
        },
    };
}
