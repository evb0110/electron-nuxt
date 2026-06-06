import type { TPdfLayerVisualSnapshotRelease } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotRelease';

interface IPdfLayerVisualSnapshotReleaseOptions {
    maxDelayMs?: number;
    minFrames?: number;
    waitFor?: () => boolean;
}

export function schedulePdfLayerVisualSnapshotRelease(
    release: TPdfLayerVisualSnapshotRelease | null | undefined,
    options: IPdfLayerVisualSnapshotReleaseOptions = {},
) {
    if (!release) {
        return;
    }

    const maxDelayMs = options.maxDelayMs ?? 0;
    const minFrames = options.minFrames ?? 1;
    const startTime = Date.now();
    let frameCount = 0;

    const shouldRelease = () => {
        frameCount += 1;
        if (frameCount < minFrames) {
            return false;
        }
        if (!options.waitFor || options.waitFor()) {
            return true;
        }
        return maxDelayMs > 0 && Date.now() - startTime >= maxDelayMs;
    };

    if (
        typeof window !== 'undefined'
        && typeof window.requestAnimationFrame === 'function'
    ) {
        const tick = () => {
            if (shouldRelease()) {
                release();
                return;
            }
            window.requestAnimationFrame(tick);
        };
        window.requestAnimationFrame(tick);
        return;
    }

    setTimeout(release, 0);
}
