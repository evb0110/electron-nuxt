import type { TPdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotRelease';

const RESIZE_SNAPSHOT_CLASS = 'pdf-resize-canvas-snapshot';
const RESIZE_SNAPSHOT_PAGE_CLASS = 'page_container--resize-visual-snapshot';

export interface IPdfResizeCanvasVisualSnapshot {
    hasReplacementCanvas: () => boolean;
    isValid: () => boolean;
    release: TPdfLayerVisualSnapshotRelease;
}

export function preservePdfResizeCanvasVisualSnapshot(
    pageContainer: HTMLElement | null | undefined,
): IPdfResizeCanvasVisualSnapshot | null {
    const pageCanvas = pageContainer?.querySelector<HTMLElement>('.page_canvas');
    const canvasHost = pageCanvas?.querySelector<HTMLElement>('.page_canvas__render-layer');
    const sourceCanvas = canvasHost?.querySelector<HTMLCanvasElement>('canvas');
    const existingSnapshots = pageCanvas?.querySelectorAll<HTMLCanvasElement>(
        `.${RESIZE_SNAPSHOT_CLASS}`,
    ) ?? [];
    for (const existingSnapshot of existingSnapshots) {
        const isValid = existingSnapshot.isConnected
            && existingSnapshot.parentElement === pageCanvas
            && existingSnapshot.width > 0
            && existingSnapshot.height > 0;
        if (isValid) {
            return null;
        }
        existingSnapshot.remove();
    }
    if (
        !pageContainer
        || !pageCanvas
        || !canvasHost
        || !sourceCanvas
        || sourceCanvas.width <= 0
        || sourceCanvas.height <= 0
    ) {
        return null;
    }

    const snapshot = document.createElement('canvas');
    snapshot.width = sourceCanvas.width;
    snapshot.height = sourceCanvas.height;
    snapshot.classList.add(RESIZE_SNAPSHOT_CLASS);
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.inert = true;

    const context = snapshot.getContext('2d');
    if (!context) {
        return null;
    }
    context.drawImage(sourceCanvas, 0, 0);

    pageContainer.classList.add(RESIZE_SNAPSHOT_PAGE_CLASS);
    pageCanvas.append(snapshot);

    let released = false;
    return {
        hasReplacementCanvas: () => {
            const replacement = canvasHost.querySelector<HTMLCanvasElement>('canvas');
            return replacement !== null && replacement !== sourceCanvas;
        },
        isValid: () => (
            !released
            && snapshot.isConnected
            && snapshot.parentElement === pageCanvas
            && pageContainer.contains(pageCanvas)
            && snapshot.width > 0
            && snapshot.height > 0
        ),
        release: () => {
            if (released) {
                return;
            }
            released = true;
            snapshot.remove();
            if (!pageCanvas.querySelector(`.${RESIZE_SNAPSHOT_CLASS}`)) {
                pageContainer.classList.remove(RESIZE_SNAPSHOT_PAGE_CLASS);
            }
        },
    };
}
