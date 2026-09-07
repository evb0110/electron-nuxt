import type { TPdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotRelease';
import {
    schedulePdfVisualSnapshotRelease,
    type IPdfVisualSnapshotReleaseOptions,
} from '@app/modules/pdf-viewer/engine/pdf-visual-snapshot/schedulePdfVisualSnapshotRelease';

export function schedulePdfLayerVisualSnapshotRelease(
    release: TPdfLayerVisualSnapshotRelease | null | undefined,
    options: IPdfVisualSnapshotReleaseOptions = {},
) {
    return schedulePdfVisualSnapshotRelease(release, options);
}
