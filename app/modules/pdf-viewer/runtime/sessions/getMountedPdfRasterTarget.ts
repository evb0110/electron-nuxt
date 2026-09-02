import { getPageContainer } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';

export function getMountedPdfRasterTarget(root: HTMLElement | null, pageNumber: number) {
    const container = root ? getPageContainer(root, pageNumber - 1) : null;
    const canvasHost = container?.querySelector<HTMLDivElement>('.page_canvas__render-layer') ?? null;
    return container && canvasHost ? {
        container,
        canvasHost,
    } : null;
}
