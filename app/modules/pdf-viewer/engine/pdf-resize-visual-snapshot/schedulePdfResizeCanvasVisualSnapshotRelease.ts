import {
    schedulePdfVisualSnapshotRelease,
    type IPdfVisualSnapshotReleaseOptions,
} from '@app/modules/pdf-viewer/engine/pdf-visual-snapshot/schedulePdfVisualSnapshotRelease';

export function schedulePdfResizeCanvasVisualSnapshotRelease(
    release: (() => void) | null | undefined,
    options: IPdfVisualSnapshotReleaseOptions = {},
) {
    return schedulePdfVisualSnapshotRelease(release, options);
}
