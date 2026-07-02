import {isFiniteNumber} from '@contracts/runtimeGuards';
import type {
    IScrollSnapshot,
    TAnchorPageOutsideEdge,
} from '@app/types/pdf';
import { clamp } from 'es-toolkit/math';

const PAGE_NUMBER_BASE = 10;
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

interface IPageAnchorSelectorOptions {
    pageSelector: string;
    getPageNumber?: (pageElement: HTMLElement) => number | null;
}

export interface ICapturePageAnchorScrollSnapshotOptions extends IPageAnchorSelectorOptions {
    anchorViewportX?: number | null;
    anchorViewportY?: number | null;
    preferredAnchorPage?: number | null;
}

export interface IRestorePageAnchorScrollSnapshotOptions extends IPageAnchorSelectorOptions {
    restoreHorizontal?: boolean;
    restoreVertical?: boolean;
    preferPageAnchor?: boolean;
    allowVerticalRatioFallback?: boolean;
}

interface IResolvedRestoreOptions {
    restoreHorizontal: boolean;
    restoreVertical: boolean;
    preferPageAnchor: boolean;
    allowVerticalRatioFallback: boolean;
}


function getDefaultPageNumber(pageElement: HTMLElement) {
    const pageNumberRaw = pageElement.dataset.pageNumber ?? pageElement.dataset.page;
    if (!pageNumberRaw) {
        return null;
    }

    const pageNumber = Number.parseInt(pageNumberRaw, PAGE_NUMBER_BASE);
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
        return null;
    }

    return pageNumber;
}

function getPageNumber(pageElement: HTMLElement, options: IPageAnchorSelectorOptions) {
    return options.getPageNumber?.(pageElement) ?? getDefaultPageNumber(pageElement);
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
    return edge === 'above'
        ? pageTop - anchorContentY
        : anchorContentY - pageBottom;
}

function createAnchorPageSnapshotForElement(
    pageElement: HTMLElement,
    anchorContentX: number,
    anchorContentY: number,
    options: IPageAnchorSelectorOptions,
): IAnchorPageSnapshot | null {
    const pageNumber = getPageNumber(pageElement, options);
    if (pageNumber === null) {
        return null;
    }

    const pageLeft = pageElement.offsetLeft;
    const pageTop = pageElement.offsetTop;
    const safeWidth = getPageWidth(pageElement);
    const safeHeight = getPageHeight(pageElement);
    const pageBottom = pageTop + safeHeight;
    const insidePage = isPointInsidePage(anchorContentX, anchorContentY, pageElement);
    const pageYOutsideEdge = getPageVerticalEdge(anchorContentY, pageTop, pageBottom);

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
        pageYOutsideOffsetPx: getPageVerticalOffsetPx(
            anchorContentY,
            pageTop,
            pageBottom,
            pageYOutsideEdge,
        ),
    };
}

function findPreferredAnchorSnapshot(
    container: HTMLElement,
    anchorContentX: number,
    anchorContentY: number,
    options: ICapturePageAnchorScrollSnapshotOptions,
) {
    if (!isFiniteNumber(options.preferredAnchorPage)) {
        return null;
    }

    const preferredPage = Math.max(1, Math.floor(options.preferredAnchorPage));
    const pageElements = container.querySelectorAll<HTMLElement>(options.pageSelector);
    for (const pageElement of pageElements) {
        if (getPageNumber(pageElement, options) !== preferredPage) {
            continue;
        }
        return createAnchorPageSnapshotForElement(
            pageElement,
            anchorContentX,
            anchorContentY,
            options,
        );
    }

    return null;
}

function findInsidePageAnchorSnapshot(
    pageElements: NodeListOf<HTMLElement>,
    anchorContentX: number,
    anchorContentY: number,
    options: IPageAnchorSelectorOptions,
) {
    for (const pageElement of pageElements) {
        const anchorSnapshotForElement = createAnchorPageSnapshotForElement(
            pageElement,
            anchorContentX,
            anchorContentY,
            options,
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
    options: IPageAnchorSelectorOptions,
): IAnchorPageSnapshot | null {
    let nearest: INearestOutsidePageAnchor | null = null;

    for (const pageElement of pageElements) {
        const pageNumber = getPageNumber(pageElement, options);
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
            pageYOutsideOffsetPx: getPageVerticalOffsetPx(
                anchorContentY,
                pageTop,
                pageBottom,
                pageYOutsideEdge,
            ),
            distanceSquared,
        };
    }

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

function getAnchorPageSnapshot(
    container: HTMLElement,
    anchorContentX: number,
    anchorContentY: number,
    options: ICapturePageAnchorScrollSnapshotOptions,
): IAnchorPageSnapshot | null {
    const preferredSnapshot = findPreferredAnchorSnapshot(
        container,
        anchorContentX,
        anchorContentY,
        options,
    );
    if (preferredSnapshot) {
        return preferredSnapshot;
    }

    const pageElements = container.querySelectorAll<HTMLElement>(options.pageSelector);
    const insideSnapshot = findInsidePageAnchorSnapshot(
        pageElements,
        anchorContentX,
        anchorContentY,
        options,
    );
    if (insideSnapshot) {
        return insideSnapshot;
    }

    return findNearestOutsidePageAnchor(
        pageElements,
        anchorContentX,
        anchorContentY,
        options,
    );
}

function getScrollSnapshotAnchor(container: HTMLElement, options: ICapturePageAnchorScrollSnapshotOptions) {
    const anchorViewportX = getViewportAnchorCoordinate(
        options.anchorViewportX,
        container.clientWidth / 2,
        container.clientWidth,
    );
    const anchorViewportY = getViewportAnchorCoordinate(
        options.anchorViewportY,
        container.clientHeight / 2,
        container.clientHeight,
    );
    const anchorContentX = container.scrollLeft + anchorViewportX;
    const anchorContentY = container.scrollTop + anchorViewportY;
    const anchorSnapshot = getAnchorPageSnapshot(
        container,
        anchorContentX,
        anchorContentY,
        options,
    );
    return {
        anchorViewportX,
        anchorViewportY,
        anchorContentX,
        anchorContentY,
        anchorSnapshot,
    };
}

function createScrollSnapshot(
    container: HTMLElement,
    scrollWidth: number,
    scrollHeight: number,
    anchor: ReturnType<typeof getScrollSnapshotAnchor>,
): IScrollSnapshot {
    return {
        width: scrollWidth,
        height: scrollHeight,
        centerX: container.scrollLeft + container.clientWidth / 2,
        centerY: container.scrollTop + container.clientHeight / 2,
        anchorPage: anchor.anchorSnapshot?.page ?? null,
        anchorInsidePage: anchor.anchorSnapshot?.insidePage ?? false,
        anchorOffsetRatio: anchor.anchorSnapshot?.pageYRatio ?? 0,
        anchorViewportX: anchor.anchorViewportX,
        anchorViewportY: anchor.anchorViewportY,
        anchorContentXRatio: getNormalizedRatio(anchor.anchorContentX / Math.max(scrollWidth, 1), 0),
        anchorContentYRatio: getNormalizedRatio(anchor.anchorContentY / Math.max(scrollHeight, 1), 0),
        anchorPageXRatio: anchor.anchorSnapshot?.pageXRatio ?? 0,
        anchorPageYRatio: anchor.anchorSnapshot?.pageYRatio ?? 0,
        anchorPageYOutsideEdge: anchor.anchorSnapshot?.pageYOutsideEdge ?? 'inside',
        anchorPageYOutsideOffsetPx: anchor.anchorSnapshot?.pageYOutsideOffsetPx ?? null,
    };
}

export function capturePageAnchorScrollSnapshot(
    container: HTMLElement | null,
    options: ICapturePageAnchorScrollSnapshotOptions,
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

    return createScrollSnapshot(
        container,
        scrollWidth,
        scrollHeight,
        getScrollSnapshotAnchor(container, options),
    );
}

function resolveRestoreOptions(options: IRestorePageAnchorScrollSnapshotOptions): IResolvedRestoreOptions {
    return {
        restoreHorizontal: options.restoreHorizontal ?? true,
        restoreVertical: options.restoreVertical ?? true,
        preferPageAnchor: options.preferPageAnchor ?? true,
        allowVerticalRatioFallback: options.allowVerticalRatioFallback ?? true,
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

function findPageElementByNumber(
    container: HTMLElement,
    pageNumber: number,
    options: IPageAnchorSelectorOptions,
) {
    const pageElements = container.querySelectorAll<HTMLElement>(options.pageSelector);
    for (const pageElement of pageElements) {
        if (getPageNumber(pageElement, options) === pageNumber) {
            return pageElement;
        }
    }
    return null;
}

function applyPageAnchorRestoration(
    container: HTMLElement,
    snapshot: IScrollSnapshot,
    anchorPageElement: HTMLElement,
    restoreOptions: IResolvedRestoreOptions,
    maxScrollTop: number,
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
        const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
        const targetLeft = anchorPageElement.offsetLeft + pageXRatio * safeWidth - anchorViewportX;
        container.scrollLeft = clamp(targetLeft, 0, maxScrollLeft);
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
    }
}

export function restorePageAnchorScrollSnapshot(
    container: HTMLElement | null,
    snapshot: IScrollSnapshot | null,
    options: IRestorePageAnchorScrollSnapshotOptions,
) {
    if (!snapshot || !container) {
        return;
    }

    const restoreOptions = resolveRestoreOptions(options);
    if (!restoreOptions.restoreHorizontal && !restoreOptions.restoreVertical) {
        return;
    }

    const newWidth = container.scrollWidth;
    const newHeight = container.scrollHeight;
    if (!newWidth || !newHeight || !snapshot.width || !snapshot.height) {
        return;
    }

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
        container.scrollLeft = clamp(contentXRatio * newWidth - anchorViewportXForRatio, 0, maxScrollLeft);
    }

    const maxScrollTop = Math.max(0, newHeight - container.clientHeight);
    const anchorPageNumber = getAnchorPageNumberFromSnapshot(snapshot);
    if (restoreOptions.preferPageAnchor && anchorPageNumber !== null) {
        const anchorPageElement = findPageElementByNumber(
            container,
            anchorPageNumber,
            options,
        );
        if (anchorPageElement) {
            applyPageAnchorRestoration(
                container,
                snapshot,
                anchorPageElement,
                restoreOptions,
                maxScrollTop,
            );
            return;
        }
    }

    if (!restoreOptions.restoreVertical) {
        return;
    }

    if (
        !restoreOptions.allowVerticalRatioFallback
        && restoreOptions.preferPageAnchor
        && anchorPageNumber !== null
    ) {
        return;
    }

    const contentYRatio = getNormalizedRatio(
        snapshot.anchorContentYRatio,
        snapshot.centerY / snapshot.height,
    );
    container.scrollTop = clamp(contentYRatio * newHeight - anchorViewportYForRatio, 0, maxScrollTop);
}
