import type { IScrollSnapshot } from '@app/types/pdf';
import { getPageContainerByNumber } from '@app/composables/pdf/pdfScrollVisibility';

const PAGE_NUMBER_BASE = 10;

function getAnchorPageSnapshot(container: HTMLElement) {
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    const pageElements = container.querySelectorAll<HTMLElement>('.page_container');

    let anchorPage = -1;
    let anchorOffsetRatio = 0;
    let maxVisibleHeight = 0;

    for (const pageElement of pageElements) {
        const pageNumberRaw = pageElement.dataset.page;
        if (!pageNumberRaw) {
            continue;
        }
        const pageNumber = Number.parseInt(pageNumberRaw, PAGE_NUMBER_BASE);
        if (!Number.isFinite(pageNumber) || pageNumber < 1) {
            continue;
        }

        const pageTop = pageElement.offsetTop;
        const pageBottom = pageTop + pageElement.offsetHeight;
        const visibleTop = Math.max(pageTop, viewportTop);
        const visibleBottom = Math.min(pageBottom, viewportBottom);
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
        if (visibleHeight <= maxVisibleHeight) {
            continue;
        }

        const safeHeight = Math.max(1, pageElement.offsetHeight);
        anchorPage = pageNumber;
        anchorOffsetRatio = (viewportTop - pageTop) / safeHeight;
        maxVisibleHeight = visibleHeight;
    }

    if (anchorPage < 1 || maxVisibleHeight <= 0) {
        return null;
    }

    return {
        page: anchorPage,
        ratio: anchorOffsetRatio,
    };
}

export function isRenderingCancelledError(error: unknown) {
    if (!error) {
        return false;
    }
    if (
        typeof error === 'object'
        && 'name' in error
        && (error as { name?: string }).name === 'RenderingCancelledException'
    ) {
        return true;
    }

    const message = typeof error === 'string'
        ? error
        : (
            typeof error === 'object'
            && error !== null
            && 'message' in error
            && typeof (error as { message?: unknown }).message === 'string'
        )
            ? (error as { message: string }).message
            : '';

    return /rendering cancelled/i.test(message);
}

export function captureScrollSnapshot(container: HTMLElement | null): IScrollSnapshot | null {
    if (!container) {
        return null;
    }

    const {
        scrollWidth,
        scrollHeight,
    } = container;
    if (!scrollWidth || !scrollHeight) {
        return null;
    }

    const anchorSnapshot = getAnchorPageSnapshot(container);

    return {
        width: scrollWidth,
        height: scrollHeight,
        centerX: container.scrollLeft + container.clientWidth / 2,
        centerY: container.scrollTop + container.clientHeight / 2,
        anchorPage: anchorSnapshot?.page ?? null,
        anchorOffsetRatio: anchorSnapshot?.ratio ?? 0,
    };
}

export function restoreScrollFromSnapshot(
    container: HTMLElement | null,
    snapshot: IScrollSnapshot | null,
) {
    if (!snapshot || !container) {
        return;
    }

    const newWidth = container.scrollWidth;
    const newHeight = container.scrollHeight;

    if (!newWidth || !newHeight || !snapshot.width || !snapshot.height) {
        return;
    }

    const maxScrollLeft = Math.max(0, newWidth - container.clientWidth);
    const maxScrollTop = Math.max(0, newHeight - container.clientHeight);
    const targetLeft = (snapshot.centerX / snapshot.width) * newWidth - container.clientWidth / 2;
    container.scrollLeft = Math.min(maxScrollLeft, Math.max(0, targetLeft));

    if (typeof snapshot.anchorPage === 'number' && Number.isFinite(snapshot.anchorPage)) {
        const anchorPageElement = getPageContainerByNumber(container, snapshot.anchorPage);
        if (anchorPageElement) {
            const safeHeight = Math.max(1, anchorPageElement.offsetHeight);
            const offsetRatio =
                typeof snapshot.anchorOffsetRatio === 'number'
                && Number.isFinite(snapshot.anchorOffsetRatio)
                    ? snapshot.anchorOffsetRatio
                    : 0;
            const targetTop = anchorPageElement.offsetTop + offsetRatio * safeHeight;
            container.scrollTop = Math.min(maxScrollTop, Math.max(0, targetTop));
            return;
        }
    }

    const targetTop = (snapshot.centerY / snapshot.height) * newHeight - container.clientHeight / 2;
    container.scrollTop = Math.min(maxScrollTop, Math.max(0, targetTop));
}

export function formatRenderError(error: unknown, pageNumber: number) {
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : (() => {
                try {
                    return JSON.stringify(error);
                } catch {
                    return String(error);
                }
            })();

    const stack = error instanceof Error ? error.stack ?? '' : '';
    return stack
        ? `Failed to render PDF page: ${pageNumber} ${message}\n${stack}`
        : `Failed to render PDF page: ${pageNumber} ${message}`;
}
