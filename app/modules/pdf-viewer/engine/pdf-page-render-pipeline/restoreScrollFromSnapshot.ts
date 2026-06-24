import type {
    IScrollSnapshot,
    TAnchorPageOutsideEdge,
} from '@app/types/pdf';
import { getPageContainerByNumber } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getPageContainerByNumber';
import { MAX_PAGE_OUTSIDE_ANCHOR_OFFSET_PX } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/maxPageOutsideAnchorOffsetPx';
import { BrowserLogger } from '@app/utils/browserLogger';
import { clamp } from 'es-toolkit/math';

const SNAPSHOT_LOG_THROTTLE_MS = 420;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
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
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'snapshot-restore-horizontal-page-anchor', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] horizontal-page-anchor', {
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
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'snapshot-restore-vertical-page-anchor', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] vertical-page-anchor', {
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
        BrowserLogger.diagnostic('pdf-zoom-debug', '[snapshot-restore] skipped missing snapshot/container', {
            hasSnapshot: Boolean(snapshot),
            hasContainer: Boolean(container),
        });
        return;
    }

    const restoreOptions = resolveRestoreOptions(options);
    if (!restoreOptions.restoreHorizontal && !restoreOptions.restoreVertical) {
        BrowserLogger.diagnostic('pdf-zoom-debug', '[snapshot-restore] skipped both axes disabled');
        return;
    }
    const newWidth = container.scrollWidth;
    const newHeight = container.scrollHeight;

    if (!newWidth || !newHeight || !snapshot.width || !snapshot.height) {
        BrowserLogger.diagnostic('pdf-zoom-debug', '[snapshot-restore] skipped invalid dimensions', {
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
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'snapshot-restore-horizontal-ratio', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] horizontal-ratio', {
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
        BrowserLogger.diagnostic('pdf-zoom-debug', '[snapshot-restore] page-anchor-missing', {anchorPageNumber});
    }

    if (!restoreOptions.restoreVertical) {
        return;
    }

    if (
        !restoreOptions.allowVerticalRatioFallback
        && restoreOptions.preferPageAnchor
        && anchorPageNumber !== null
    ) {
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'snapshot-restore-vertical-ratio-skipped', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] vertical-ratio-skipped', {
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
    BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'snapshot-restore-vertical-ratio', SNAPSHOT_LOG_THROTTLE_MS, '[snapshot-restore] vertical-ratio', {
        targetTop,
        beforeScrollTop,
        afterScrollTop: container.scrollTop,
        maxScrollTop,
        contentYRatio,
        anchorViewportY: anchorViewportYForRatio,
    });
}
