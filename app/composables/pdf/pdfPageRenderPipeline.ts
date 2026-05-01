import type {
    IScrollSnapshot,
    TAnchorPageOutsideEdge,
} from '@app/types/pdf';
import { errorToLogText } from '@app/composables/pdf/annotationCssUtils';
import { summarizeViewerMetrics } from '@app/composables/pdf/pdfViewerMetrics';
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
    pageYOutsideEdge: TAnchorPageOutsideEdge;
    pageYOutsideOffsetPx: number | null;
}

interface INearestOutsidePageAnchor extends IAnchorPageSnapshot {distanceSquared: number;}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function getPageNumberFromElement(pageElement: HTMLElement) {
    const pageNumberRaw = pageElement.dataset.page;
    if (!pageNumberRaw) {
        return null;
    }

    const pageNumber = Number.parseInt(pageNumberRaw, PAGE_NUMBER_BASE);
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
        return null;
    }

    return pageNumber;
}

function getViewportAnchorCoordinate(value: number | null | undefined, fallback: number, limit: number) {
    const normalizedLimit = Math.max(limit, 0);
    const normalizedValue = isFiniteNumber(value) ? value : fallback;
    return clamp(normalizedValue, 0, normalizedLimit);
}

function getNormalizedRatio(value: number | null | undefined, fallback: number) {
    const normalizedValue = isFiniteNumber(value) ? value : fallback;
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

function getPageVerticalEdge(
    anchorContentY: number,
    pageTop: number,
    pageBottom: number,
): TAnchorPageOutsideEdge {
    if (anchorContentY < pageTop) {
        return 'above';
    }
    if (anchorContentY > pageBottom) {
        return 'below';
    }
    return 'inside';
}

function getPageVerticalOffsetPx(
    anchorContentY: number,
    pageTop: number,
    pageBottom: number,
    edge: TAnchorPageOutsideEdge,
) {
    if (edge === 'inside') {
        return null;
    }
    return edge === 'above' ? pageTop - anchorContentY : anchorContentY - pageBottom;
}

function createAnchorPageSnapshotForElement(
    pageElement: HTMLElement,
    anchorContentX: number,
    anchorContentY: number,
): IAnchorPageSnapshot | null {
    const pageNumber = getPageNumberFromElement(pageElement);
    if (pageNumber === null) {
        return null;
    }

    const pageLeft = pageElement.offsetLeft;
    const pageTop = pageElement.offsetTop;
    const safeWidth = getPageWidth(pageElement);
    const safeHeight = getPageHeight(pageElement);
    const pageBottom = pageTop + safeHeight;
    const insidePage = isPointInsidePage(anchorContentX, anchorContentY, pageElement);
    const pageYOutsideEdge: TAnchorPageOutsideEdge = insidePage
        ? 'inside'
        : anchorContentY < pageTop
            ? 'above'
            : 'below';
    const pageYOutsideOffsetPx = insidePage
        ? null
        : pageYOutsideEdge === 'above'
            ? pageTop - anchorContentY
            : anchorContentY - pageBottom;

    return {
        page: pageNumber,
        pageXRatio: insidePage
            ? clamp((anchorContentX - pageLeft) / safeWidth, 0, 1)
            : (anchorContentX - pageLeft) / safeWidth,
        pageYRatio: insidePage
            ? clamp((anchorContentY - pageTop) / safeHeight, 0, 1)
            : (anchorContentY - pageTop) / safeHeight,
        insidePage,
        pageYOutsideEdge,
        pageYOutsideOffsetPx,
    };
}

function findPreferredAnchorSnapshot(
    container: HTMLElement,
    anchorContentX: number,
    anchorContentY: number,
    preferredAnchorPage: number | null | undefined,
) {
    if (!isFiniteNumber(preferredAnchorPage)) {
        return null;
    }
    const preferredPageElement = getPageContainerByNumber(
        container,
        Math.max(1, Math.floor(preferredAnchorPage)),
    );
    if (!preferredPageElement) {
        return null;
    }
    return createAnchorPageSnapshotForElement(
        preferredPageElement,
        anchorContentX,
        anchorContentY,
    );
}

function findInsidePageAnchorSnapshot(
    pageElements: NodeListOf<HTMLElement>,
    anchorContentX: number,
    anchorContentY: number,
) {
    for (const pageElement of pageElements) {
        const anchorSnapshotForElement = createAnchorPageSnapshotForElement(
            pageElement,
            anchorContentX,
            anchorContentY,
        );
        if (!anchorSnapshotForElement?.insidePage) {
            continue;
        }
        return anchorSnapshotForElement;
    }
    return null;
}

function getOutsidePageDistanceSquared(
    anchorContentX: number,
    anchorContentY: number,
    pageLeft: number,
    pageTop: number,
    pageRight: number,
    pageBottom: number,
) {
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
    return deltaX * deltaX + deltaY * deltaY;
}

function findNearestOutsidePageAnchor(
    pageElements: NodeListOf<HTMLElement>,
    anchorContentX: number,
    anchorContentY: number,
): INearestOutsidePageAnchor | null {
    let nearest: INearestOutsidePageAnchor | null = null;

    for (const pageElement of pageElements) {
        const pageNumber = getPageNumberFromElement(pageElement);
        if (pageNumber === null) {
            continue;
        }

        const pageLeft = pageElement.offsetLeft;
        const pageTop = pageElement.offsetTop;
        const safeHeight = getPageHeight(pageElement);
        const safeWidth = getPageWidth(pageElement);
        const pageRight = pageLeft + safeWidth;
        const pageBottom = pageTop + safeHeight;
        const pageYOutsideEdge = getPageVerticalEdge(anchorContentY, pageTop, pageBottom);
        const pageYOutsideOffsetPx = getPageVerticalOffsetPx(
            anchorContentY,
            pageTop,
            pageBottom,
            pageYOutsideEdge,
        );
        const distanceSquared = getOutsidePageDistanceSquared(
            anchorContentX,
            anchorContentY,
            pageLeft,
            pageTop,
            pageRight,
            pageBottom,
        );
        if (nearest && distanceSquared >= nearest.distanceSquared) {
            continue;
        }

        nearest = {
            page: pageNumber,
            pageXRatio: (anchorContentX - pageLeft) / safeWidth,
            pageYRatio: (anchorContentY - pageTop) / safeHeight,
            insidePage: false,
            pageYOutsideEdge,
            pageYOutsideOffsetPx,
            distanceSquared,
        };
    }

    return nearest;
}

function getAnchorPageSnapshot(
    container: HTMLElement,
    anchorContentX: number,
    anchorContentY: number,
    preferredAnchorPage?: number | null,
): IAnchorPageSnapshot | null {
    const preferredSnapshot = findPreferredAnchorSnapshot(
        container,
        anchorContentX,
        anchorContentY,
        preferredAnchorPage,
    );
    if (preferredSnapshot) {
        return preferredSnapshot;
    }

    const pageElements = container.querySelectorAll<HTMLElement>('.page_container');
    const insideSnapshot = findInsidePageAnchorSnapshot(
        pageElements,
        anchorContentX,
        anchorContentY,
    );
    if (insideSnapshot) {
        return insideSnapshot;
    }

    const nearest = findNearestOutsidePageAnchor(
        pageElements,
        anchorContentX,
        anchorContentY,
    );
    if (!nearest) {
        return null;
    }

    return {
        page: nearest.page,
        pageXRatio: nearest.pageXRatio,
        pageYRatio: nearest.pageYRatio,
        insidePage: false,
        pageYOutsideEdge: nearest.pageYOutsideEdge,
        pageYOutsideOffsetPx: nearest.pageYOutsideOffsetPx,
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

function getScrollSnapshotAnchor(container: HTMLElement, options?: {
    anchorViewportX?: number | null;
    anchorViewportY?: number | null;
    preferredAnchorPage?: number | null;
}) {
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
        options?.preferredAnchorPage,
    );
    return {
        anchorViewportX,
        anchorViewportY,
        anchorContentX,
        anchorContentY,
        anchorSnapshot,
    };
}

function getAnchorSnapshotPage(anchorSnapshot: IAnchorPageSnapshot | null | undefined) {
    return anchorSnapshot?.page ?? null;
}

function getAnchorSnapshotInsidePage(anchorSnapshot: IAnchorPageSnapshot | null | undefined) {
    return anchorSnapshot?.insidePage ?? false;
}

function getAnchorSnapshotPageYRatio(anchorSnapshot: IAnchorPageSnapshot | null | undefined) {
    return anchorSnapshot?.pageYRatio ?? 0;
}

function getAnchorSnapshotPageXRatio(anchorSnapshot: IAnchorPageSnapshot | null | undefined) {
    return anchorSnapshot?.pageXRatio ?? 0;
}

function getAnchorSnapshotOutsideEdge(anchorSnapshot: IAnchorPageSnapshot | null | undefined) {
    return anchorSnapshot?.pageYOutsideEdge ?? 'inside';
}

function getAnchorSnapshotOutsideOffset(anchorSnapshot: IAnchorPageSnapshot | null | undefined) {
    return anchorSnapshot?.pageYOutsideOffsetPx ?? null;
}

function getDefaultAnchorSnapshot(anchorSnapshot: IAnchorPageSnapshot | null | undefined) {
    return {
        page: getAnchorSnapshotPage(anchorSnapshot),
        insidePage: getAnchorSnapshotInsidePage(anchorSnapshot),
        pageYRatio: getAnchorSnapshotPageYRatio(anchorSnapshot),
        pageXRatio: getAnchorSnapshotPageXRatio(anchorSnapshot),
        pageYOutsideEdge: getAnchorSnapshotOutsideEdge(anchorSnapshot),
        pageYOutsideOffsetPx: getAnchorSnapshotOutsideOffset(anchorSnapshot),
    };
}

function createScrollSnapshot(
    container: HTMLElement,
    scrollWidth: number,
    scrollHeight: number,
    anchor: ReturnType<typeof getScrollSnapshotAnchor>,
): IScrollSnapshot {
    const anchorPage = getDefaultAnchorSnapshot(anchor.anchorSnapshot);
    return {
        width: scrollWidth,
        height: scrollHeight,
        centerX: container.scrollLeft + container.clientWidth / 2,
        centerY: container.scrollTop + container.clientHeight / 2,
        anchorPage: anchorPage.page,
        anchorInsidePage: anchorPage.insidePage,
        anchorOffsetRatio: anchorPage.pageYRatio,
        anchorViewportX: anchor.anchorViewportX,
        anchorViewportY: anchor.anchorViewportY,
        anchorContentXRatio: getNormalizedRatio(anchor.anchorContentX / Math.max(scrollWidth, 1), 0),
        anchorContentYRatio: getNormalizedRatio(anchor.anchorContentY / Math.max(scrollHeight, 1), 0),
        anchorPageXRatio: anchorPage.pageXRatio,
        anchorPageYRatio: anchorPage.pageYRatio,
        anchorPageYOutsideEdge: anchorPage.pageYOutsideEdge,
        anchorPageYOutsideOffsetPx: anchorPage.pageYOutsideOffsetPx,
    };
}

export function captureScrollSnapshot(
    container: HTMLElement | null,
    options?: {
        anchorViewportX?: number | null;
        anchorViewportY?: number | null;
        preferredAnchorPage?: number | null;
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

    const anchor = getScrollSnapshotAnchor(container, options);
    const snapshot = createScrollSnapshot(container, scrollWidth, scrollHeight, anchor);
    BrowserLogger.warnThrottled('pdf-zoom-debug', 'snapshot-capture', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-capture]', {
        anchorViewportX: anchor.anchorViewportX,
        anchorViewportY: anchor.anchorViewportY,
        anchorContentX: anchor.anchorContentX,
        anchorContentY: anchor.anchorContentY,
        preferredAnchorPage: options?.preferredAnchorPage ?? null,
        snapshot,
        container: summarizeViewerMetrics(container),
    });

    return snapshot;
}

interface IRestoreOptions {
    restoreHorizontal: boolean;
    restoreVertical: boolean;
    preferPageAnchor: boolean;
    allowVerticalRatioFallback: boolean;
}

function resolveRestoreOptions(options?: {
    restoreHorizontal?: boolean;
    restoreVertical?: boolean;
    preferPageAnchor?: boolean;
    allowVerticalRatioFallback?: boolean;
}): IRestoreOptions {
    return {
        restoreHorizontal: options?.restoreHorizontal ?? true,
        restoreVertical: options?.restoreVertical ?? true,
        preferPageAnchor: options?.preferPageAnchor ?? true,
        allowVerticalRatioFallback: options?.allowVerticalRatioFallback ?? true,
    };
}

function getAnchorPageNumberFromSnapshot(snapshot: IScrollSnapshot) {
    return isFiniteNumber(snapshot.anchorPage) ? snapshot.anchorPage : null;
}

function resolvePageAnchorRatio(
    primary: number | null | undefined,
    fallback: number | null | undefined,
    anchorInsidePage: boolean,
) {
    if (isFiniteNumber(primary)) {
        return anchorInsidePage ? clamp(primary, 0, 1) : primary;
    }
    if (isFiniteNumber(fallback)) {
        return anchorInsidePage ? clamp(fallback, 0, 1) : fallback;
    }
    return 0;
}

function normalizeOutsideEdge(value: TAnchorPageOutsideEdge | undefined): TAnchorPageOutsideEdge {
    if (value === 'above' || value === 'below' || value === 'inside') {
        return value;
    }
    return 'inside';
}

function normalizeOutsideOffsetPx(value: number | null | undefined) {
    if (isFiniteNumber(value) && value >= 0) {
        return value;
    }
    return null;
}

function canApplyOutsidePageOffset(
    anchorInsidePage: boolean,
    edge: TAnchorPageOutsideEdge,
    offsetPx: number | null,
) {
    return !anchorInsidePage
        && (edge === 'above' || edge === 'below')
        && offsetPx !== null
        && offsetPx <= MAX_PAGE_OUTSIDE_ANCHOR_OFFSET_PX;
}

function computePageAnchorTargetTop(
    anchorPageElement: HTMLElement,
    safeHeight: number,
    effectivePageYRatio: number,
    edge: TAnchorPageOutsideEdge,
    offsetPx: number | null,
    canApplyOutside: boolean,
    anchorViewportY: number,
) {
    if (canApplyOutside && offsetPx !== null && edge === 'above') {
        return anchorPageElement.offsetTop - offsetPx - anchorViewportY;
    }
    if (canApplyOutside && offsetPx !== null && edge === 'below') {
        return anchorPageElement.offsetTop + safeHeight + offsetPx - anchorViewportY;
    }
    return anchorPageElement.offsetTop + effectivePageYRatio * safeHeight - anchorViewportY;
}

function applyPageAnchorRestoration(
    container: HTMLElement,
    snapshot: IScrollSnapshot,
    anchorPageElement: HTMLElement,
    anchorPageNumber: number,
    restoreOptions: IRestoreOptions,
    newWidth: number,
    maxScrollTop: number,
    beforeScrollLeft: number,
    beforeScrollTop: number,
) {
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
    const anchorInsidePage = snapshot.anchorInsidePage !== false;
    const pageXRatio = resolvePageAnchorRatio(
        snapshot.anchorPageXRatio,
        null,
        anchorInsidePage,
    );
    const pageYRatio = resolvePageAnchorRatio(
        snapshot.anchorPageYRatio,
        snapshot.anchorOffsetRatio,
        anchorInsidePage,
    );
    const pageYOutsideEdge = normalizeOutsideEdge(snapshot.anchorPageYOutsideEdge);
    const pageYOutsideOffsetPx = normalizeOutsideOffsetPx(snapshot.anchorPageYOutsideOffsetPx);
    const canApplyOutsideOffset = canApplyOutsidePageOffset(
        anchorInsidePage,
        pageYOutsideEdge,
        pageYOutsideOffsetPx,
    );
    const effectivePageYRatio = !anchorInsidePage && !canApplyOutsideOffset
        ? clamp(pageYRatio, 0, 1)
        : pageYRatio;

    if (restoreOptions.restoreHorizontal) {
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

    if (restoreOptions.restoreVertical) {
        const targetTop = computePageAnchorTargetTop(
            anchorPageElement,
            safeHeight,
            effectivePageYRatio,
            pageYOutsideEdge,
            pageYOutsideOffsetPx,
            canApplyOutsideOffset,
            anchorViewportY,
        );
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

    const restoreOptions = resolveRestoreOptions(options);
    if (!restoreOptions.restoreHorizontal && !restoreOptions.restoreVertical) {
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
    if (restoreOptions.restoreHorizontal) {
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
    const anchorPageNumber = getAnchorPageNumberFromSnapshot(snapshot);

    if (restoreOptions.preferPageAnchor && anchorPageNumber !== null) {
        const anchorPageElement = getPageContainerByNumber(container, anchorPageNumber);
        if (anchorPageElement) {
            applyPageAnchorRestoration(
                container,
                snapshot,
                anchorPageElement,
                anchorPageNumber,
                restoreOptions,
                newWidth,
                maxScrollTop,
                beforeScrollLeft,
                beforeScrollTop,
            );
            return;
        }
        BrowserLogger.warn('pdf-zoom-debug', '[snapshot-restore] page-anchor-missing', {anchorPageNumber});
    }

    if (!restoreOptions.restoreVertical) {
        return;
    }

    if (
        !restoreOptions.allowVerticalRatioFallback
        && restoreOptions.preferPageAnchor
        && anchorPageNumber !== null
    ) {
        BrowserLogger.warnThrottled('pdf-zoom-debug', 'snapshot-restore-vertical-ratio-skipped', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] vertical-ratio-skipped', {
            reason: 'missing-page-anchor',
            anchorPageNumber,
            beforeScrollTop,
            afterScrollTop: container.scrollTop,
            allowVerticalRatioFallback: restoreOptions.allowVerticalRatioFallback,
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
    return `Failed to render PDF page: ${pageNumber} ${errorToLogText(error)}`;
}
