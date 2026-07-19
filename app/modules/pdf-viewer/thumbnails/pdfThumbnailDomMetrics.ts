import {THUMBNAIL_WIDTH} from '@app/constants/pdfLayout';
import {
    resolveThumbnailItemChromeHeightFromStyles,
    resolveThumbnailRenderWidthFromStyles,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailRenderMetrics';

export function resolvePdfThumbnailRenderWidth(container: HTMLElement) {
    const containerStyle = window.getComputedStyle(container);
    const thumbnail = container.querySelector<HTMLElement>('.pdf-thumbnail');
    const frame = thumbnail?.querySelector<HTMLElement>('[data-document-thumbnail-frame]') ?? null;
    const renderedFrameWidth = frame?.getBoundingClientRect().width ?? 0;
    if (Number.isFinite(renderedFrameWidth) && renderedFrameWidth > 0) {
        return renderedFrameWidth;
    }
    return resolveThumbnailRenderWidthFromStyles({
        containerClientWidth: container.clientWidth,
        containerStyle,
        minWidth: THUMBNAIL_WIDTH,
        thumbnailStyle: thumbnail ? window.getComputedStyle(thumbnail) : null,
    });
}

export function resolvePdfThumbnailItemChromeHeight(container: HTMLElement) {
    const thumbnail = container.querySelector<HTMLElement>('.pdf-thumbnail');
    const label = thumbnail?.querySelector<HTMLElement>('[data-document-thumbnail-label]') ?? null;
    if (!thumbnail || !label) {
        return null;
    }
    return resolveThumbnailItemChromeHeightFromStyles({
        labelHeight: label.getBoundingClientRect().height,
        thumbnailStyle: window.getComputedStyle(thumbnail),
    });
}
