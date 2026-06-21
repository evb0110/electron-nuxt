import type { TPdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotRelease';

interface IPdfLayerVisualSnapshotReleaseOptions {
    maxDelayMs?: number;
    minFrames?: number;
    waitFor?: () => boolean;
}

function normalizeMaxDelayMs(maxDelayMs: number | undefined) {
    if (
        typeof maxDelayMs !== 'number'
        || !Number.isFinite(maxDelayMs)
        || maxDelayMs <= 0
    ) {
        return 0;
    }
    return maxDelayMs;
}

function normalizeMinFrames(minFrames: number | undefined) {
    if (
        typeof minFrames !== 'number'
        || !Number.isFinite(minFrames)
        || minFrames < 1
    ) {
        return 1;
    }
    return Math.ceil(minFrames);
}

export function schedulePdfLayerVisualSnapshotRelease(
    release: TPdfLayerVisualSnapshotRelease | null | undefined,
    options: IPdfLayerVisualSnapshotReleaseOptions = {},
) {
    if (!release) {
        return;
    }

    const maxDelayMs = normalizeMaxDelayMs(options.maxDelayMs);
    const minFrames = normalizeMinFrames(options.minFrames);
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
        return Date.now() - startTime >= maxDelayMs;
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
