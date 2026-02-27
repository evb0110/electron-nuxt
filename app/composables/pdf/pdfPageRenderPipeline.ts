import type { IScrollSnapshot } from '@app/types/pdf';
import { getPageContainerByNumber } from '@app/composables/pdf/pdfScrollVisibility';
import { BrowserLogger } from '@app/utils/browser-logger';
import { clamp } from 'es-toolkit/math';

const PAGE_NUMBER_BASE = 10;
const SNAPSHOT_LOG_THROTTLE_MS = 420;
const MAX_PAGE_OUTSIDE_ANCHOR_OFFSET_PX = 320;

interface IAnchorPageSnapshot {
    page: number;
    pageXRatio: number;
    pageYRatio: number;
    insidePage: boolean;
    pageYOutsideEdge: 'inside' | 'above' | 'below';
    pageYOutsideOffsetPx: number | null;
}

function getViewportAnchorCoordinate(value: number | null | undefined, fallback: number, limit: number) {
    const normalizedLimit = Math.max(limit, 0);
    const normalizedValue = typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
    return clamp(normalizedValue, 0, normalizedLimit);
}

function getNormalizedRatio(value: number | null | undefined, fallback: number) {
    const normalizedValue = typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
    return clamp(normalizedValue, 0, 1);
}

function getPageWidth(pageElement: HTMLElement) {
    return Math.max(
        1,
        pageElement.offsetWidth || pageElement.clientWidth || 0,
    );
}

function getPageHeight(pageElement: HTMLElement) {
    return Math.max(
        1,
        pageElement.offsetHeight || pageElement.clientHeight || 0,
    );
}

function isPointInsidePage(
    x: number,
    y: number,
    pageElement: HTMLElement,
) {
    const left = pageElement.offsetLeft;
    const top = pageElement.offsetTop;
    const right = left + getPageWidth(pageElement);
    const bottom = top + getPageHeight(pageElement);
    return x >= left && x <= right && y >= top && y <= bottom;
}

function getAnchorPageSnapshot(
    container: HTMLElement,
    anchorContentX: number,
    anchorContentY: number,
) {
    const pageElements = container.querySelectorAll<HTMLElement>('.page_container');

    for (const pageElement of pageElements) {
        const pageNumberRaw = pageElement.dataset.page;
        if (!pageNumberRaw) {
            continue;
        }
        const pageNumber = Number.parseInt(pageNumberRaw, PAGE_NUMBER_BASE);
        if (!Number.isFinite(pageNumber) || pageNumber < 1) {
            continue;
        }
        if (!isPointInsidePage(anchorContentX, anchorContentY, pageElement)) {
            continue;
        }

        const pageLeft = pageElement.offsetLeft;
        const pageTop = pageElement.offsetTop;
        const pageWidth = getPageWidth(pageElement);
        const pageHeight = getPageHeight(pageElement);
        return {
            page: pageNumber,
            pageXRatio: clamp((anchorContentX - pageLeft) / pageWidth, 0, 1),
            pageYRatio: clamp((anchorContentY - pageTop) / pageHeight, 0, 1),
            insidePage: true,
            pageYOutsideEdge: 'inside',
            pageYOutsideOffsetPx: null,
        } satisfies IAnchorPageSnapshot;
    }

    let nearestOutsideAnchor: {
        page: number;
        pageXRatio: number;
        pageYRatio: number;
        distanceSquared: number;
        pageYOutsideEdge: 'inside' | 'above' | 'below';
        pageYOutsideOffsetPx: number | null;
    } | null = null;

    for (const pageElement of pageElements) {
        const pageNumberRaw = pageElement.dataset.page;
        if (!pageNumberRaw) {
            continue;
        }
        const pageNumber = Number.parseInt(pageNumberRaw, PAGE_NUMBER_BASE);
        if (!Number.isFinite(pageNumber) || pageNumber < 1) {
            continue;
        }

        const pageLeft = pageElement.offsetLeft;
        const pageTop = pageElement.offsetTop;
        const safeHeight = getPageHeight(pageElement);
        const safeWidth = getPageWidth(pageElement);
        const pageRight = pageLeft + safeWidth;
        const pageBottom = pageTop + safeHeight;
        const pageYOutsideEdge = anchorContentY < pageTop
            ? 'above'
            : anchorContentY > pageBottom
                ? 'below'
                : 'inside';
        const pageYOutsideOffsetPx = pageYOutsideEdge === 'inside'
            ? null
            : pageYOutsideEdge === 'above'
                ? pageTop - anchorContentY
                : anchorContentY - pageBottom;
        const deltaX = anchorContentX < pageLeft
            ? pageLeft - anchorContentX
            : anchorContentX > pageRight
                ? anchorContentX - pageRight
                : 0;
        const deltaY = anchorContentY < pageTop
            ? pageTop - anchorContentY
            : anchorContentY > pageBottom
                ? anchorContentY - pageBottom
                : 0;
        const distanceSquared = deltaX * deltaX + deltaY * deltaY;
        if (
            nearestOutsideAnchor
            && distanceSquared >= nearestOutsideAnchor.distanceSquared
        ) {
            continue;
        }

        nearestOutsideAnchor = {
            page: pageNumber,
            pageXRatio: (anchorContentX - pageLeft) / safeWidth,
            pageYRatio: (anchorContentY - pageTop) / safeHeight,
            distanceSquared,
            pageYOutsideEdge,
            pageYOutsideOffsetPx,
        };
    }

    if (!nearestOutsideAnchor) {
        return null;
    }

    return {
        page: nearestOutsideAnchor.page,
        pageXRatio: nearestOutsideAnchor.pageXRatio,
        pageYRatio: nearestOutsideAnchor.pageYRatio,
        insidePage: false,
        pageYOutsideEdge: nearestOutsideAnchor.pageYOutsideEdge,
        pageYOutsideOffsetPx: nearestOutsideAnchor.pageYOutsideOffsetPx,
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

export function captureScrollSnapshot(
    container: HTMLElement | null,
    options?: {
        anchorViewportX?: number | null;
        anchorViewportY?: number | null;
    },
): IScrollSnapshot | null {
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

    const anchorViewportX = getViewportAnchorCoordinate(
        options?.anchorViewportX,
        container.clientWidth / 2,
        container.clientWidth,
    );
    const anchorViewportY = getViewportAnchorCoordinate(
        options?.anchorViewportY,
        container.clientHeight / 2,
        container.clientHeight,
    );
    const anchorContentX = container.scrollLeft + anchorViewportX;
    const anchorContentY = container.scrollTop + anchorViewportY;
    const anchorSnapshot = getAnchorPageSnapshot(
        container,
        anchorContentX,
        anchorContentY,
    );
    const snapshot: IScrollSnapshot = {
        width: scrollWidth,
        height: scrollHeight,
        centerX: container.scrollLeft + container.clientWidth / 2,
        centerY: container.scrollTop + container.clientHeight / 2,
        anchorPage: anchorSnapshot?.page ?? null,
        anchorInsidePage: anchorSnapshot?.insidePage ?? false,
        anchorOffsetRatio: anchorSnapshot?.pageYRatio ?? 0,
        anchorViewportX,
        anchorViewportY,
        anchorContentXRatio: getNormalizedRatio(anchorContentX / Math.max(scrollWidth, 1), 0),
        anchorContentYRatio: getNormalizedRatio(anchorContentY / Math.max(scrollHeight, 1), 0),
        anchorPageXRatio: anchorSnapshot?.pageXRatio ?? 0,
        anchorPageYRatio: anchorSnapshot?.pageYRatio ?? 0,
        anchorPageYOutsideEdge: anchorSnapshot?.pageYOutsideEdge ?? 'inside',
        anchorPageYOutsideOffsetPx: anchorSnapshot?.pageYOutsideOffsetPx ?? null,
    };
    BrowserLogger.warnThrottled('pdf-zoom-debug', 'snapshot-capture', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-capture]', {
        anchorViewportX,
        anchorViewportY,
        anchorContentX,
        anchorContentY,
        snapshot,
        container: {
            scrollTop: Math.round(container.scrollTop),
            scrollLeft: Math.round(container.scrollLeft),
            clientWidth: Math.round(container.clientWidth),
            clientHeight: Math.round(container.clientHeight),
            scrollWidth: Math.round(container.scrollWidth),
            scrollHeight: Math.round(container.scrollHeight),
        },
    });

    return snapshot;
}

export function restoreScrollFromSnapshot(
    container: HTMLElement | null,
    snapshot: IScrollSnapshot | null,
    options?: {
        restoreHorizontal?: boolean;
        restoreVertical?: boolean;
        preferPageAnchor?: boolean;
        allowVerticalRatioFallback?: boolean;
    },
) {
    if (!snapshot || !container) {
        BrowserLogger.warn('pdf-zoom-debug', '[snapshot-restore] skipped missing snapshot/container', {
            hasSnapshot: Boolean(snapshot),
            hasContainer: Boolean(container),
        });
        return;
    }

    const restoreHorizontal = options?.restoreHorizontal ?? true;
    const restoreVertical = options?.restoreVertical ?? true;
    const preferPageAnchor = options?.preferPageAnchor ?? true;
    const allowVerticalRatioFallback = options?.allowVerticalRatioFallback ?? true;
    if (!restoreHorizontal && !restoreVertical) {
        BrowserLogger.warn('pdf-zoom-debug', '[snapshot-restore] skipped both axes disabled');
        return;
    }
    const newWidth = container.scrollWidth;
    const newHeight = container.scrollHeight;

    if (!newWidth || !newHeight || !snapshot.width || !snapshot.height) {
        BrowserLogger.warn('pdf-zoom-debug', '[snapshot-restore] skipped invalid dimensions', {
            newWidth,
            newHeight,
            snapshotWidth: snapshot.width,
            snapshotHeight: snapshot.height,
        });
        return;
    }

    const beforeScrollTop = container.scrollTop;
    const beforeScrollLeft = container.scrollLeft;

    const anchorViewportXForRatio = getViewportAnchorCoordinate(
        snapshot.anchorViewportX,
        container.clientWidth / 2,
        container.clientWidth,
    );
    const anchorViewportYForRatio = getViewportAnchorCoordinate(
        snapshot.anchorViewportY,
        container.clientHeight / 2,
        container.clientHeight,
    );
    if (restoreHorizontal) {
        const maxScrollLeft = Math.max(0, newWidth - container.clientWidth);
        const contentXRatio = getNormalizedRatio(
            snapshot.anchorContentXRatio,
            snapshot.centerX / snapshot.width,
        );
        const targetLeft = contentXRatio * newWidth - anchorViewportXForRatio;
        container.scrollLeft = clamp(targetLeft, 0, maxScrollLeft);
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'snapshot-restore-horizontal-ratio', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] horizontal-ratio', {
            targetLeft,
            beforeScrollLeft,
            afterScrollLeft: container.scrollLeft,
            maxScrollLeft,
            contentXRatio,
            anchorViewportX: anchorViewportXForRatio,
        });
    }

    const maxScrollTop = Math.max(0, newHeight - container.clientHeight);
    const anchorInsidePage = snapshot.anchorInsidePage !== false;
    const anchorPageNumber =
        typeof snapshot.anchorPage === 'number'
        && Number.isFinite(snapshot.anchorPage)
            ? snapshot.anchorPage
            : null;

    if (preferPageAnchor && anchorPageNumber !== null) {
        const anchorPageElement = getPageContainerByNumber(container, anchorPageNumber);
        if (anchorPageElement) {
            const safeWidth = getPageWidth(anchorPageElement);
            const safeHeight = getPageHeight(anchorPageElement);
            const anchorViewportX = getViewportAnchorCoordinate(
                snapshot.anchorViewportX,
                container.clientWidth / 2,
                container.clientWidth,
            );
            const anchorViewportY = getViewportAnchorCoordinate(
                snapshot.anchorViewportY,
                0,
                container.clientHeight,
            );
            const pageXRatio =
                typeof snapshot.anchorPageXRatio === 'number'
                && Number.isFinite(snapshot.anchorPageXRatio)
                    ? anchorInsidePage
                        ? clamp(snapshot.anchorPageXRatio, 0, 1)
                        : snapshot.anchorPageXRatio
                    : 0;
            const pageYRatio =
                typeof snapshot.anchorPageYRatio === 'number'
                && Number.isFinite(snapshot.anchorPageYRatio)
                    ? anchorInsidePage
                        ? clamp(snapshot.anchorPageYRatio, 0, 1)
                        : snapshot.anchorPageYRatio
                    : (
                        typeof snapshot.anchorOffsetRatio === 'number'
                        && Number.isFinite(snapshot.anchorOffsetRatio)
                    )
                        ? anchorInsidePage
                            ? clamp(snapshot.anchorOffsetRatio, 0, 1)
                            : snapshot.anchorOffsetRatio
                        : 0;
            const pageYOutsideEdge = snapshot.anchorPageYOutsideEdge === 'above'
                || snapshot.anchorPageYOutsideEdge === 'below'
                || snapshot.anchorPageYOutsideEdge === 'inside'
                ? snapshot.anchorPageYOutsideEdge
                : 'inside';
            const pageYOutsideOffsetPx =
                typeof snapshot.anchorPageYOutsideOffsetPx === 'number'
                && Number.isFinite(snapshot.anchorPageYOutsideOffsetPx)
                && snapshot.anchorPageYOutsideOffsetPx >= 0
                    ? snapshot.anchorPageYOutsideOffsetPx
                    : null;
            const canApplyOutsideOffset = !anchorInsidePage
                && (pageYOutsideEdge === 'above' || pageYOutsideEdge === 'below')
                && pageYOutsideOffsetPx !== null
                && pageYOutsideOffsetPx <= MAX_PAGE_OUTSIDE_ANCHOR_OFFSET_PX;
            const effectivePageYRatio = !anchorInsidePage && !canApplyOutsideOffset
                ? clamp(pageYRatio, 0, 1)
                : pageYRatio;

            if (restoreHorizontal) {
                const maxScrollLeft = Math.max(0, newWidth - container.clientWidth);
                const targetLeft =
                    anchorPageElement.offsetLeft + pageXRatio * safeWidth - anchorViewportX;
                container.scrollLeft = clamp(targetLeft, 0, maxScrollLeft);
                BrowserLogger.warnThrottled('pdf-zoom-debug', 'snapshot-restore-horizontal-page-anchor', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] horizontal-page-anchor', {
                    anchorPageNumber,
                    pageXRatio,
                    targetLeft,
                    beforeScrollLeft,
                    afterScrollLeft: container.scrollLeft,
                    anchorViewportX,
                    anchorInsidePage,
                });
            }

            if (restoreVertical) {
                const targetTop = canApplyOutsideOffset
                    && pageYOutsideEdge === 'above'
                    ? anchorPageElement.offsetTop - pageYOutsideOffsetPx - anchorViewportY
                    : canApplyOutsideOffset
                        && pageYOutsideEdge === 'below'
                        ? anchorPageElement.offsetTop + safeHeight + pageYOutsideOffsetPx - anchorViewportY
                        : anchorPageElement.offsetTop + effectivePageYRatio * safeHeight - anchorViewportY;
                container.scrollTop = clamp(targetTop, 0, maxScrollTop);
                BrowserLogger.warnThrottled('pdf-zoom-debug', 'snapshot-restore-vertical-page-anchor', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] vertical-page-anchor', {
                    anchorPageNumber,
                    pageYRatio,
                    effectivePageYRatio,
                    pageYOutsideEdge,
                    pageYOutsideOffsetPx,
                    canApplyOutsideOffset,
                    outsideOffsetLimitPx: MAX_PAGE_OUTSIDE_ANCHOR_OFFSET_PX,
                    targetTop,
                    beforeScrollTop,
                    afterScrollTop: container.scrollTop,
                    anchorViewportY,
                    anchorInsidePage,
                });
            }
            return;
        }
        BrowserLogger.warn('pdf-zoom-debug', '[snapshot-restore] page-anchor-missing', {anchorPageNumber});
    }

    if (!restoreVertical) {
        return;
    }

    if (
        !allowVerticalRatioFallback
        && preferPageAnchor
        && anchorPageNumber !== null
    ) {
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'snapshot-restore-vertical-ratio-skipped', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] vertical-ratio-skipped', {
            reason: 'missing-page-anchor',
            anchorPageNumber,
            beforeScrollTop,
            afterScrollTop: container.scrollTop,
            allowVerticalRatioFallback,
        });
        return;
    }

    const contentYRatio = getNormalizedRatio(
        snapshot.anchorContentYRatio,
        snapshot.centerY / snapshot.height,
    );
    const targetTop = contentYRatio * newHeight - anchorViewportYForRatio;
    container.scrollTop = clamp(targetTop, 0, maxScrollTop);
    BrowserLogger.warnThrottled('pdf-zoom-debug', 'snapshot-restore-vertical-ratio', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] vertical-ratio', {
        targetTop,
        beforeScrollTop,
        afterScrollTop: container.scrollTop,
        maxScrollTop,
        contentYRatio,
        anchorViewportY: anchorViewportYForRatio,
    });
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
