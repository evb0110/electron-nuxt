import type { TPdfLayerVisualSnapshotRelease } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotTypes';

export function combinePdfLayerVisualSnapshotReleases(
    releases: Array<TPdfLayerVisualSnapshotRelease | null | undefined>,
) {
    const activeReleases = releases.filter(Boolean) as TPdfLayerVisualSnapshotRelease[];
    if (activeReleases.length === 0) {
        return null;
    }

    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        activeReleases.forEach(release => release());
    };
}
