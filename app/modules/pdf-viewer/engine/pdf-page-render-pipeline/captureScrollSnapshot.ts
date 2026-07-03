import {isFiniteNumber} from '@contracts/runtimeGuards';
import type {
    IScrollSnapshot,
    TAnchorPageOutsideEdge,
} from '@app/types/pdfUi';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import { MAX_PAGE_OUTSIDE_ANCHOR_OFFSET_PX } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/maxPageOutsideAnchorOffsetPx';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import { BrowserLogger } from '@app/utils/browserLogger';
import { clamp } from 'es-toolkit/math';

const PAGE_NUMBER_BASE = 10;

const SNAPSHOT_LOG_THROTTLE_MS = 420;

interface IAnchorPageSnapshot {
    page: number;
    pageXRatio: number;
    pageYRatio: number;
    insidePage: boolean;
    pageYOutsideEdge: TAnchorPageOutsideEdge;
    pageYOutsideOffsetPx: number | null;
}

interface INearestOutsidePageAnchor extends IAnchorPageSnapshot {distanceSquared: number;}


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

function canUsePreferredAnchorSnapshot(snapshot: IAnchorPageSnapshot) {
    if (snapshot.insidePage) {
        return true;
    }

    if (snapshot.pageYOutsideEdge === 'inside') {
        return true;
    }

    return snapshot.pageYOutsideOffsetPx !== null
        && snapshot.pageYOutsideOffsetPx <= MAX_PAGE_OUTSIDE_ANCHOR_OFFSET_PX;
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
    if (preferredSnapshot && canUsePreferredAnchorSnapshot(preferredSnapshot)) {
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
    BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'snapshot-capture', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-capture]', {
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
