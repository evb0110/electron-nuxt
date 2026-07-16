import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createLargeScannedFixturePdf,
    createNativeDjvuLatePageSearchFixture,
    createMultiPageTextFixturePdf,
    createPngFixture,
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    clickVisibleToolbarButton,
    ensureSidebarOpen,
    goToPageViaToolbar,
    openDjvuInApp,
    openDocumentSidebarTab,
    openPdfInApp,
    waitForDjvuLoaded,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
    triggerOpenPathInApp,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { captureDocumentThumbnailParitySnapshot } from '@tests/e2e/electron/helpers/captureDocumentThumbnailParitySnapshot';

interface IViewerSmokeSnapshot {
    hostHeight: number;
    viewerHeight: number;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    visiblePages: number[];
    firstPageWidth: number;
    firstPageHeight: number;
    firstPagePainted: boolean;
}

interface IViewerScrollAttempt {
    maxScrollTop: number;
    scrollTop: number;
}

interface IBalancedScrollRegionGeometry {
    clientWidth: number;
    gutter: string;
    horizontalOverflow: number;
    leftBand: number;
    overflowY: string;
    rightBand: number;
}

interface IDjvuWheelMetricSample {
    clientHeight: number;
    committedPage: number;
    currentPage: number | null;
    imageCount: number;
    mountedRange: string;
    observedPage: number;
    maxVisibleGapPx: number;
    pageNumbers: number[];
    scrollHeight: number;
    scrollTop: number;
    surfaceHeight: number;
    virtualSpacerCount: number;
    virtualSpacerHeight: number;
    visibleImageCount: number;
    visiblePageNumbers: number[];
    visibleShellCount: number;
    visibleSkeletonCount: number;
    visibleUnloadedFraction: number;
    requestedPage: number;
}

interface IDjvuWheelMetricSummary {
    finalPage: number | null;
    maxVisiblePage: number;
    maxMountedPages: number;
    maxScrollHeightDelta: number;
    maxSurfaceHeightDelta: number;
    maxVisibleGapPx: number;
    maxVisibleUnloadedFraction: number;
    minVisibleImageCount: number;
    monotonicScrollViolations: number;
    rangeTransitions: number;
    sampleCount: number;
    visibleImageZeroFrames: number;
    virtualSpacerCount: number;
    virtualSpacerHeight: number;
}

interface IDjvuVisibleInterval {
    bottom: number;
    top: number;
}

interface IDjvuToolbarPageSnapshot {currentPage?: number | null;}

interface IDjvuWheelMetricWindow {__evbTestApi?: {getActiveToolbarSnapshot?: () => IDjvuToolbarPageSnapshot | null;};}

async function readBalancedScrollRegionGeometry(
    session: IElectronE2ESession,
    containerSelector: string,
    contentSelector: string,
): Promise<IBalancedScrollRegionGeometry> {
    return session.page.evaluate((selectors) => {
        const container = document.querySelector<HTMLElement>(selectors.container);
        const content = document.querySelector<HTMLElement>(selectors.content);
        if (!container || !content) {
            throw new Error(`Balanced scroll geometry was not found: ${selectors.container} -> ${selectors.content}`);
        }
        const containerRect = container.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const style = getComputedStyle(container);
        return {
            clientWidth: container.clientWidth,
            gutter: style.scrollbarGutter,
            horizontalOverflow: Math.max(0, container.scrollWidth - container.clientWidth),
            leftBand: contentRect.left - containerRect.left,
            overflowY: style.overflowY,
            rightBand: containerRect.right - contentRect.right,
        };
    }, {
        container: containerSelector,
        content: contentSelector,
    });
}

function expectBalancedScrollRegion(
    geometry: IBalancedScrollRegionGeometry,
    detail: string,
) {
    expect(geometry.gutter, detail).toBe('stable both-edges');
    expect(geometry.clientWidth, detail).toBeGreaterThan(0);
    expect(geometry.horizontalOverflow, detail).toBeLessThanOrEqual(2);
    expect(Math.abs(geometry.leftBand - geometry.rightBand), detail).toBeLessThanOrEqual(1.5);
}

type TSplitResizeDocumentKind = 'pdf' | 'djvu';

interface ISplitResizeViewportAnchor {
    busy: boolean;
    pageHeight: number;
    pageNumber: number | null;
    pagePointRatio: number;
    paneWidth: number;
    readyVisiblePageCount: number;
    scrollTop: number;
    visiblePageCount: number;
}

interface IDjvuSplitResizeContinuityFrame {
    busy: boolean;
    readyVisiblePageCount: number;
    visiblePageCount: number;
}

interface IDjvuSplitResizeContinuityProbe {
    active: boolean;
    frames: IDjvuSplitResizeContinuityFrame[];
}

interface IDjvuSplitResizeContinuityWindow extends Window {__djvuSplitResizeContinuityProbe?: IDjvuSplitResizeContinuityProbe;}

interface IDjvuSidebarLifecycleFrame {
    busy: boolean;
    currentPage: number | null;
    errorText: string;
    readyVisiblePageCount: number;
    runtimeErrorText: string;
    visiblePageCount: number;
}

interface IDjvuSidebarLifecycleProbe {
    active: boolean;
    frames: IDjvuSidebarLifecycleFrame[];
}

interface IDjvuSidebarLifecycleWindow extends Window {__djvuSidebarLifecycleProbe?: IDjvuSidebarLifecycleProbe;}

interface IDocumentSidebarResizeGeometry {
    configuredSashWidth: number;
    sashBackground: string;
    sashRight: number;
    sashWidth: number;
    sidebarWidth: number;
    viewerLeft: number;
    wrapperRight: number;
}

interface IDjvuNativeSearchProgressEvent {
    processed: number;
    requestId: string;
    status?: 'running' | 'success' | 'canceled' | 'failed';
    total: number;
}

interface IDjvuNativeSearchProgressProbe {
    events: IDjvuNativeSearchProgressEvent[];
    unsubscribe: () => void;
}

interface IDjvuNativeSearchProgressWindow extends Window {__djvuNativeSearchProgressProbe?: IDjvuNativeSearchProgressProbe;}

const VIEWER_SMOKE_OPEN_TIMEOUT_MS = 45_000;
const DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS = 90_000;
const DJVU_VIDEO_LIKE_VIEWPORT = {
    deviceScaleFactor: 1,
    height: 949,
    width: 1459,
};
const DJVU_VIDEO_ZOOM = 0.29;
const DJVU_VIDEO_START_PAGE = 11;
const DJVU_WHEEL_DELTA_Y = 320;
const DJVU_PROJECTED_SCROLL_START_PAGE = 27;
const DJVU_PROJECTED_SCROLL_DELTA_Y = 32;
const DJVU_PROJECTED_SCROLL_INTERVAL_MS = 12;
const DJVU_PROJECTED_SCROLL_STEPS = 650;
const DJVU_PROJECTED_SCROLL_WARMUP_SAMPLES = 3;
const DJVU_HIGH_ZOOM_REGRESSION_ZOOM = 4.72;
const DJVU_HIGH_ZOOM_PRESSURE_DURATION_MS = 5_500;
const SPLIT_RESIZE_ANCHOR_TOLERANCE = 0.08;

interface IThumbnailPaintSample {
    containerClientHeight: number;
    containerScrollHeight: number;
    containerScrollTop: number;
    contentPixels: number;
    height: number;
    intersectsViewport: boolean;
    itemViewportTop: number;
    page: number;
    renderKey: string | null;
    rendered: boolean;
    timeMs: number;
    width: number;
}

interface IThumbnailPaintProbe {
    samples: IThumbnailPaintSample[];
    stop: () => void;
}

interface IThumbnailPaintProbeWindow extends Window {
    __getPdfRasterProfileForE2E?: () => {maxBufferCanvasPixels: number};
    __getWorkspaceSurfaceBudgetForE2E?: () => {
        effectiveMaxBytes: number;
        pressureLevel: string;
        reservedBytes: number;
    };
    __setWorkspaceSurfacePressureForE2E?: (level: 'healthy' | 'critical') => void;
    __thumbnailPaintProbe?: IThumbnailPaintProbe;
}

interface IMacWheelVisualProbe {
    samples: Array<{
        hasVisual: boolean;
        timeMs: number;
        visiblePageCount: number;
    }>;
    stop: () => void;
}

interface IMacWheelE2EWindow extends Window {
    __macWheelHeartbeat?: {
        lastAt: number;
        maxGapMs: number;
        sampleCount: number;
    };
    __macWheelHeartbeatTimer?: number;
    __macWheelModifierSamples?: Array<{
        ctrlKey: boolean;
        defaultPrevented: boolean;
        metaKey: boolean;
    }>;
    __macWheelVisualProbe?: IMacWheelVisualProbe;
}

const djvuFixture = resolveDjvuFixturePath();
const runDjvuSmokeOrSkip = selectFixtureDescribe(describe, djvuFixture);

function readSplitResizeViewportAnchorFromPage(
    paneId: string,
    documentKind: TSplitResizeDocumentKind,
): ISplitResizeViewportAnchor {
    const pane = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane'))
        .find(candidate => candidate.dataset.editorPaneId === paneId) ?? null;
    const host = pane?.querySelector<HTMLElement>('.workspace-host') ?? null;
    const sourceSurface = host?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]') ?? null;
    const viewport = documentKind === 'pdf'
        ? host?.querySelector<HTMLElement>('#pdf-viewer') ?? null
        : sourceSurface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
    const pageSelector = documentKind === 'pdf'
        ? '.page_container[data-page]'
        : '[data-testid="document-page-source-page"][data-page-number]';
    const pageElements = Array.from(viewport?.querySelectorAll<HTMLElement>(pageSelector) ?? []);
    const viewportRect = viewport?.getBoundingClientRect() ?? null;
    const viewportPointY = viewportRect
        ? viewportRect.top + viewportRect.height / 2
        : 0;
    const visiblePages = viewportRect
        ? pageElements.filter((page) => {
            const rect = page.getBoundingClientRect();
            return Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top) > 8;
        })
        : [];
    const anchorPage = visiblePages.find((page) => {
        const rect = page.getBoundingClientRect();
        return rect.top <= viewportPointY && rect.bottom >= viewportPointY;
    }) ?? visiblePages.reduce<HTMLElement | null>((best, page) => {
        if (!viewportRect) {
            return best;
        }
        const visibleHeight = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            return Math.max(0, Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top));
        };
        return !best || visibleHeight(page) > visibleHeight(best) ? page : best;
    }, null);
    const anchorRect = anchorPage?.getBoundingClientRect() ?? null;
    const readyVisiblePageCount = visiblePages.filter((page) => {
        if (documentKind === 'pdf') {
            const canvas = page.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas');
            return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
        }
        const image = page.querySelector<HTMLImageElement>('[data-testid="document-page-source-image"]');
        return Boolean(
            image?.complete
            && image.naturalWidth > 0
            && image.naturalHeight > 0,
        );
    }).length;
    const banner = host?.querySelector<HTMLElement>('.djvu-banner') ?? null;

    return {
        busy: Boolean(
            host?.querySelector('.workspace-host__loading')
            || banner?.getAttribute('aria-busy') === 'true'
            || banner?.textContent?.includes('Opening DjVu'),
        ),
        pageHeight: Math.round(anchorRect?.height ?? 0),
        pageNumber: anchorPage
            ? Number.parseInt(
                documentKind === 'pdf'
                    ? anchorPage.dataset.page ?? ''
                    : anchorPage.dataset.pageNumber ?? '',
                10,
            ) || null
            : null,
        pagePointRatio: anchorRect && anchorRect.height > 0
            ? (viewportPointY - anchorRect.top) / anchorRect.height
            : 0,
        paneWidth: Math.round(pane?.getBoundingClientRect().width ?? 0),
        readyVisiblePageCount,
        scrollTop: Math.round(viewport?.scrollTop ?? 0),
        visiblePageCount: visiblePages.length,
    };
}

async function readSplitResizeViewportAnchor(
    session: IElectronE2ESession,
    paneId: string,
    documentKind: TSplitResizeDocumentKind,
) {
    return session.page.evaluate(readSplitResizeViewportAnchorFromPage, paneId, documentKind);
}

async function waitForSplitResizeViewportAnchor(
    session: IElectronE2ESession,
    paneId: string,
    documentKind: TSplitResizeDocumentKind,
    expected: ISplitResizeViewportAnchor,
) {
    const deadline = Date.now() + 5_000;
    let snapshot = await readSplitResizeViewportAnchor(session, paneId, documentKind);
    while (
        Date.now() < deadline
        && (
            snapshot.pageNumber !== expected.pageNumber
            || Math.abs(snapshot.pagePointRatio - expected.pagePointRatio) > SPLIT_RESIZE_ANCHOR_TOLERANCE
            || snapshot.readyVisiblePageCount === 0
        )
    ) {
        await session.page.evaluate(async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
        });
        snapshot = await readSplitResizeViewportAnchor(session, paneId, documentKind);
    }
    return snapshot;
}

async function splitActivePaneWithEmptyEditor(session: IElectronE2ESession) {
    const result = await session.page.evaluate(async () => {
        const sourcePaneId = document.querySelector<HTMLElement>('.editor-pane.is-active')
            ?.dataset.editorPaneId ?? null;
        const splitEditor = (window as Window & {__splitEditorEmptyForE2E?: (direction: 'right') => Promise<void> | void;}).__splitEditorEmptyForE2E;
        if (!sourcePaneId || typeof splitEditor !== 'function') {
            return {
                sourcePaneId,
                split: false,
            };
        }
        await splitEditor('right');
        return {
            sourcePaneId,
            split: true,
        };
    });
    expect(result.split).toBe(true);
    expect(result.sourcePaneId).not.toBeNull();
    await session.page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 2);
    return result.sourcePaneId!;
}

async function nudgeActiveDocumentViewportWithWheel(
    session: IElectronE2ESession,
    documentKind: TSplitResizeDocumentKind,
    deltaY: number,
) {
    const point = await session.page.evaluate((kind: TSplitResizeDocumentKind) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const surface = host?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]') ?? null;
        const viewport = kind === 'pdf'
            ? host?.querySelector<HTMLElement>('#pdf-viewer') ?? null
            : surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
        if (!viewport) {
            return null;
        }
        const rect = viewport.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    }, documentKind);
    if (!point) {
        throw new Error(`Active ${documentKind} viewport was not found`);
    }
    await session.page.mouse.move(point.x, point.y);
    await session.page.mouse.wheel({deltaY});
    await session.page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
    });
}

async function dragEditorDividerToRatio(session: IElectronE2ESession, targetRatio: number) {
    const geometry = await session.page.evaluate((ratio: number) => {
        const split = Array.from(document.querySelectorAll<HTMLElement>('.editor-split.is-horizontal'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return rect.width > 400 && rect.height > 300;
            }) ?? null;
        const sash = split?.querySelector<HTMLElement>(':scope > .editor-sash.is-vertical-line') ?? null;
        if (!split || !sash) {
            return null;
        }
        const splitRect = split.getBoundingClientRect();
        const sashRect = sash.getBoundingClientRect();
        return {
            startX: sashRect.left + sashRect.width / 2,
            targetX: splitRect.left + splitRect.width * ratio,
            y: sashRect.top + sashRect.height / 2,
        };
    }, targetRatio);
    if (!geometry) {
        throw new Error('Visible horizontal editor divider was not found');
    }

    await session.page.mouse.move(geometry.startX, geometry.y);
    await session.page.mouse.down();
    const steps = 12;
    for (let index = 1; index <= steps; index += 1) {
        const progress = index / steps;
        await session.page.mouse.move(
            geometry.startX + (geometry.targetX - geometry.startX) * progress,
            geometry.y,
        );
        await session.page.evaluate(async () => {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        });
    }
    await session.page.mouse.up();
    await session.page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
    });
}

async function readDocumentSidebarResizeGeometry(session: IElectronE2ESession) {
    return session.page.evaluate((): IDocumentSidebarResizeGeometry | null => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const wrapper = host?.querySelector<HTMLElement>('.sidebar-wrapper') ?? null;
        const sidebar = wrapper?.querySelector<HTMLElement>('[data-testid="document-sidebar"]') ?? null;
        const sash = wrapper?.querySelector<HTMLElement>('.sidebar-resizer') ?? null;
        const viewer = host?.querySelector<HTMLElement>('.workspace-main__viewer') ?? null;
        if (!wrapper || !sidebar || !sash || !viewer) {
            return null;
        }
        const rootStyle = window.getComputedStyle(document.documentElement);
        const sashRect = sash.getBoundingClientRect();
        return {
            configuredSashWidth: Number.parseFloat(rootStyle.getPropertyValue('--app-editor-sash-width')) || 0,
            sashBackground: window.getComputedStyle(sash).backgroundColor,
            sashRight: sashRect.right,
            sashWidth: sashRect.width,
            sidebarWidth: sidebar.getBoundingClientRect().width,
            viewerLeft: viewer.getBoundingClientRect().left,
            wrapperRight: wrapper.getBoundingClientRect().right,
        };
    });
}

async function dragDocumentSidebarDividerBy(session: IElectronE2ESession, deltaX: number) {
    const before = await readDocumentSidebarResizeGeometry(session);
    if (!before) {
        throw new Error('Visible document sidebar divider was not found');
    }
    const point = await session.page.evaluate(() => {
        const sash = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host .sidebar-resizer',
        );
        if (!sash) {
            return null;
        }
        const rect = sash.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    });
    if (!point) {
        throw new Error('Visible document sidebar divider geometry was unavailable');
    }

    await session.page.mouse.move(point.x, point.y);
    await session.page.mouse.down();
    await session.page.mouse.move(point.x + deltaX, point.y, {steps: 8});
    await session.page.mouse.up();
    await session.page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
    });
    const after = await readDocumentSidebarResizeGeometry(session);
    if (!after) {
        throw new Error('Document sidebar divider disappeared after resize');
    }
    return {
        after,
        before,
    };
}

async function installDjvuSplitResizeContinuityProbe(session: IElectronE2ESession, paneId: string) {
    return session.page.evaluate((sourcePaneId: string) => {
        const probeWindow = window as IDjvuSplitResizeContinuityWindow;
        const sourcePane = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane'))
            .find(candidate => candidate.dataset.editorPaneId === sourcePaneId) ?? null;
        const host = sourcePane?.querySelector<HTMLElement>('.workspace-host') ?? null;
        const surface = host?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]') ?? null;
        const viewport = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
        if (!host || !viewport) {
            return false;
        }
        const probe: IDjvuSplitResizeContinuityProbe = {
            active: true,
            frames: [],
        };
        const sample = () => {
            if (!probe.active) {
                return;
            }
            const viewportRect = viewport.getBoundingClientRect();
            const visiblePages = Array.from(viewport.querySelectorAll<HTMLElement>(
                '[data-testid="document-page-source-page"]',
            )).filter((page) => {
                const rect = page.getBoundingClientRect();
                return Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top) > 8;
            });
            const banner = host.querySelector<HTMLElement>('.djvu-banner');
            probe.frames.push({
                busy: Boolean(
                    host.querySelector('.workspace-host__loading')
                    || banner?.getAttribute('aria-busy') === 'true'
                    || banner?.textContent?.includes('Opening DjVu'),
                ),
                readyVisiblePageCount: visiblePages.filter((page) => {
                    const image = page.querySelector<HTMLImageElement>('[data-testid="document-page-source-image"]');
                    return Boolean(
                        image?.complete
                        && image.naturalWidth > 0
                        && image.naturalHeight > 0,
                    );
                }).length,
                visiblePageCount: visiblePages.length,
            });
            requestAnimationFrame(sample);
        };
        probeWindow.__djvuSplitResizeContinuityProbe = probe;
        requestAnimationFrame(sample);
        return true;
    }, paneId);
}

async function stopDjvuSplitResizeContinuityProbe(session: IElectronE2ESession) {
    return session.page.evaluate(() => {
        const probe = (window as IDjvuSplitResizeContinuityWindow).__djvuSplitResizeContinuityProbe;
        if (!probe) {
            return [];
        }
        probe.active = false;
        return probe.frames;
    });
}

function expectSplitResizeAnchorPreserved(
    actual: ISplitResizeViewportAnchor,
    expected: ISplitResizeViewportAnchor,
) {
    const detail = JSON.stringify({
        actual,
        expected,
    });
    expect(actual.pageNumber, detail).toBe(expected.pageNumber);
    expect(Math.abs(actual.pagePointRatio - expected.pagePointRatio), detail)
        .toBeLessThanOrEqual(SPLIT_RESIZE_ANCHOR_TOLERANCE);
    expect(actual.visiblePageCount, detail).toBeGreaterThan(0);
    expect(actual.readyVisiblePageCount, detail).toBeGreaterThan(0);
}

async function readViewerSmokeSnapshot(session: IElectronE2ESession) {
    return session.page.evaluate((): IViewerSmokeSnapshot => {
        const visibleHost = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 100
                    && rect.height > 100
                );
            }) ?? null;
        const viewerHost = visibleHost?.querySelector<HTMLElement>('.workspace-viewer-host') ?? null;
        const viewer = visibleHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const viewerRect = viewer?.getBoundingClientRect() ?? null;
        const firstPage = viewer?.querySelector<HTMLElement>('.page_container[data-page="1"]') ?? null;
        const firstPageRect = firstPage?.getBoundingClientRect() ?? null;
        const firstPageCanvas = firstPage?.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas') ?? null;
        const visiblePages = viewer && viewerRect
            ? Array.from(viewer.querySelectorAll<HTMLElement>('.page_container'))
                .filter((pageElement) => {
                    const rect = pageElement.getBoundingClientRect();
                    return Math.min(rect.bottom, viewerRect.bottom) - Math.max(rect.top, viewerRect.top) > 8;
                })
                .map(pageElement => Number.parseInt(pageElement.dataset.page ?? '', 10))
                .filter(Number.isFinite)
            : [];

        return {
            hostHeight: Math.round(viewerHost?.getBoundingClientRect().height ?? 0),
            viewerHeight: Math.round(viewerRect?.height ?? 0),
            scrollTop: Math.round(viewer?.scrollTop ?? 0),
            scrollHeight: Math.round(viewer?.scrollHeight ?? 0),
            clientHeight: Math.round(viewer?.clientHeight ?? 0),
            visiblePages,
            firstPageWidth: Math.round(firstPageRect?.width ?? 0),
            firstPageHeight: Math.round(firstPageRect?.height ?? 0),
            firstPagePainted: Boolean(
                firstPageCanvas
                && firstPageCanvas.width > 0
                && firstPageCanvas.height > 0,
            ),
        };
    });
}

async function waitForViewerSmokeSnapshot(
    session: IElectronE2ESession,
    minimums: {
        viewerHeight: number;
        firstPageHeight: number;
    } = {
        viewerHeight: 300,
        firstPageHeight: 300,
    },
) {
    await waitForFunctionInPage(session.page, (expected: typeof minimums) => {
        const viewer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host #pdf-viewer',
        );
        const firstPage = viewer?.querySelector<HTMLElement>('.page_container[data-page="1"]') ?? null;
        if (!viewer || !firstPage) {
            return false;
        }

        const viewerRect = viewer.getBoundingClientRect();
        const firstPageRect = firstPage.getBoundingClientRect();
        const canvas = firstPage.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas');
        const visibleHeight = Math.min(firstPageRect.bottom, viewerRect.bottom)
            - Math.max(firstPageRect.top, viewerRect.top);
        return viewerRect.height > expected.viewerHeight
            && firstPageRect.height > expected.firstPageHeight
            && visibleHeight > 8
            && Boolean(canvas && canvas.width > 0 && canvas.height > 0);
    }, { timeout: VIEWER_SMOKE_OPEN_TIMEOUT_MS }, minimums);

    return readViewerSmokeSnapshot(session);
}

async function scrollToBottomOfPageOne(session: IElectronE2ESession) {
    const attempt = await session.page.evaluate((): IViewerScrollAttempt => {
        const viewer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host #pdf-viewer',
        );
        const firstPage = viewer?.querySelector<HTMLElement>('.page_container[data-page="1"]');
        if (!viewer || !firstPage) {
            return {
                maxScrollTop: 0,
                scrollTop: 0,
            };
        }

        const maxScrollTop = Math.max(0, firstPage.offsetTop + firstPage.offsetHeight - viewer.clientHeight);
        viewer.scrollTop = maxScrollTop;
        viewer.dispatchEvent(new Event('scroll', { bubbles: true }));
        return {
            maxScrollTop: Math.round(maxScrollTop),
            scrollTop: Math.round(viewer.scrollTop),
        };
    });
    await waitForFunctionInPage(session.page, () => {
        const viewer = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host #pdf-viewer',
        );
        return Boolean(viewer && viewer.scrollTop > 20);
    }, { timeout: 5_000 });
    return attempt;
}

async function zoomInUntilScrollable(session: IElectronE2ESession, start: IViewerSmokeSnapshot) {
    let previous = start;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const toolbarBefore = await getWorkspaceToolbarSnapshot(session.page);
        await clickVisibleToolbarButton(session.page, 'Zoom In');
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {minEffectiveZoom: (toolbarBefore?.effectiveZoom ?? 0) + 0.005},
            { timeoutMs: 10_000 },
        );
        await waitForFunctionInPage(session.page, (previousWidth: number) => {
            const pageElement = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host #pdf-viewer .page_container[data-page="1"]',
            );
            return Boolean(pageElement && pageElement.getBoundingClientRect().width > previousWidth + 5);
        }, { timeout: 10_000 }, previous.firstPageWidth);

        const next = await readViewerSmokeSnapshot(session);
        if (next.scrollHeight > next.clientHeight + 20) {
            return next;
        }
        previous = next;
    }

    return previous;
}

function readDjvuWheelMetricSampleFromPage(): IDjvuWheelMetricSample {
    const toolbarCurrentPage = (window as Window & IDjvuWheelMetricWindow)
        .__evbTestApi
        ?.getActiveToolbarSnapshot
        ?.()
        ?.currentPage;
    const visibleHost = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
        .find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                Boolean(candidate.querySelector('[data-testid="document-page-source-viewer"]'))
                &&
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100
            );
        }) ?? null;
    const surface = visibleHost?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]') ?? null;
    const viewer = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]') ?? null;
    const chassis = viewer?.closest<HTMLElement>('.document-viewer-chassis') ?? null;
    const viewerRect = viewer?.getBoundingClientRect() ?? null;
    // The opening-page shell is teleported beside the source surface while a
    // viewport transition commits. Count shells from the chassis viewport so
    // that temporary ownership move is not misreported as a missing page.
    const pageShells = Array.from(viewer?.querySelectorAll<HTMLElement>('[data-testid="document-page-source-page"]') ?? []);
    const virtualSpacers: HTMLElement[] = [];
    const pageNumbers = pageShells
        .map(pageElement => Number.parseInt(pageElement.dataset.pageNumber ?? '', 10))
        .filter(Number.isFinite);
    let maxVisibleGapPx = 0;
    let totalVisibleShellArea = 0;
    let unloadedVisibleShellArea = 0;
    let visibleImageCount = 0;
    let visibleSkeletonCount = 0;
    const visiblePageNumbers: number[] = [];
    const visibleIntervals: IDjvuVisibleInterval[] = [];

    if (viewer && viewerRect) {
        for (const pageElement of pageShells) {
            const rect = pageElement.getBoundingClientRect();
            const visibleTop = Math.max(rect.top, viewerRect.top);
            const visibleBottom = Math.min(rect.bottom, viewerRect.bottom);
            const visibleHeight = Math.max(0, visibleBottom - visibleTop);
            if (visibleHeight <= 8) {
                continue;
            }

            const pageNumber = Number.parseInt(pageElement.dataset.pageNumber ?? '', 10);
            if (Number.isFinite(pageNumber)) {
                visiblePageNumbers.push(pageNumber);
            }
            visibleIntervals.push({
                top: visibleTop,
                bottom: visibleBottom,
            });
            const visibleArea = visibleHeight * Math.max(1, Math.min(rect.width, viewerRect.width));
            totalVisibleShellArea += visibleArea;
            if (pageElement.querySelector('img')) {
                visibleImageCount += 1;
            } else {
                unloadedVisibleShellArea += visibleArea;
            }
            if (pageElement.querySelector('.document-source-viewer__skeleton')) {
                visibleSkeletonCount += 1;
            }
        }

        visibleIntervals.sort((left, right) => left.top - right.top);
        let cursor = viewerRect.top;
        for (const interval of visibleIntervals) {
            maxVisibleGapPx = Math.max(maxVisibleGapPx, Math.max(0, interval.top - cursor));
            cursor = Math.max(cursor, interval.bottom);
        }
        maxVisibleGapPx = Math.max(maxVisibleGapPx, Math.max(0, viewerRect.bottom - cursor));
    }

    return {
        clientHeight: Math.round(viewer?.clientHeight ?? 0),
        committedPage: Number(chassis?.dataset.viewportCommittedPage ?? 0),
        currentPage: typeof toolbarCurrentPage === 'number' && Number.isFinite(toolbarCurrentPage)
            ? Math.trunc(toolbarCurrentPage)
            : Number.parseInt(
                visibleHost?.querySelector('.page-controls-current')?.textContent
                    ?? document.querySelector('.page-controls-current')?.textContent
                    ?? '',
                10,
            ) || null,
        imageCount: viewer?.querySelectorAll('[data-testid="document-page-source-image"]').length ?? 0,
        mountedRange: pageNumbers.length > 0 ? `${pageNumbers[0]}-${pageNumbers.at(-1)}` : 'empty',
        observedPage: Number(chassis?.dataset.viewportObservedPage ?? 0),
        maxVisibleGapPx: Math.round(maxVisibleGapPx),
        pageNumbers,
        scrollHeight: Math.round(viewer?.scrollHeight ?? 0),
        scrollTop: Math.round(viewer?.scrollTop ?? 0),
        surfaceHeight: Math.round(surface?.getBoundingClientRect().height ?? 0),
        virtualSpacerCount: virtualSpacers.length,
        virtualSpacerHeight: Math.round(virtualSpacers.reduce((total, spacer) => total + spacer.getBoundingClientRect().height, 0)),
        visibleImageCount,
        visiblePageNumbers,
        visibleShellCount: visiblePageNumbers.length,
        visibleSkeletonCount,
        visibleUnloadedFraction: totalVisibleShellArea > 0
            ? unloadedVisibleShellArea / totalVisibleShellArea
            : 1,
        requestedPage: Number(chassis?.dataset.viewportRequestedPage ?? 0),
    };
}

async function readDjvuWheelMetricSample(session: IElectronE2ESession) {
    return session.page.evaluate(readDjvuWheelMetricSampleFromPage);
}

function getMaxDelta(values: number[]) {
    if (values.length <= 1) {
        return 0;
    }

    let maxDelta = 0;
    for (let index = 1; index < values.length; index += 1) {
        maxDelta = Math.max(maxDelta, Math.abs(values[index]! - values[index - 1]!));
    }
    return maxDelta;
}

function summarizeDjvuWheelMetrics(samples: IDjvuWheelMetricSample[]): IDjvuWheelMetricSummary {
    let monotonicScrollViolations = 0;
    let rangeTransitions = 0;
    for (let index = 1; index < samples.length; index += 1) {
        if (samples[index]!.scrollTop + 2 < samples[index - 1]!.scrollTop) {
            monotonicScrollViolations += 1;
        }
        if (samples[index]!.mountedRange !== samples[index - 1]!.mountedRange) {
            rangeTransitions += 1;
        }
    }

    return {
        finalPage: samples.at(-1)?.currentPage ?? null,
        maxVisiblePage: Math.max(0, ...samples.flatMap(sample => sample.visiblePageNumbers)),
        maxMountedPages: Math.max(0, ...samples.map(sample => sample.pageNumbers.length)),
        maxScrollHeightDelta: getMaxDelta(samples.map(sample => sample.scrollHeight)),
        maxSurfaceHeightDelta: getMaxDelta(samples.map(sample => sample.surfaceHeight)),
        maxVisibleGapPx: Math.max(0, ...samples.map(sample => sample.maxVisibleGapPx)),
        maxVisibleUnloadedFraction: Math.max(0, ...samples.map(sample => sample.visibleUnloadedFraction)),
        minVisibleImageCount: Math.min(Number.MAX_SAFE_INTEGER, ...samples.map(sample => sample.visibleImageCount)),
        monotonicScrollViolations,
        rangeTransitions,
        sampleCount: samples.length,
        visibleImageZeroFrames: samples.filter(sample => sample.visibleImageCount === 0).length,
        virtualSpacerCount: Math.max(0, ...samples.map(sample => sample.virtualSpacerCount)),
        virtualSpacerHeight: Math.max(0, ...samples.map(sample => sample.virtualSpacerHeight)),
    };
}

async function configureDjvuWheelMetricStart(
    session: IElectronE2ESession,
    startPage = DJVU_VIDEO_START_PAGE,
) {
    const zoomResult = await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [DJVU_VIDEO_ZOOM]);
    expect(zoomResult.called).toBe(true);
    await waitForWorkspaceToolbarSnapshot(
        session.page,
        {
            continuousScroll: true,
            minEffectiveZoom: DJVU_VIDEO_ZOOM - 0.005,
            minTotalPages: 100,
        },
        { timeoutMs: 10_000 },
    );

    const toolbarSnapshot = await getWorkspaceToolbarSnapshot(session.page);
    expect(toolbarSnapshot?.effectiveZoom ?? 0).toBeCloseTo(DJVU_VIDEO_ZOOM, 1);

    const scrollResult = await callWorkspaceCommand(session.page, 'handleGoToPage', [startPage]);
    expect(scrollResult.called).toBe(true);
    await waitForWorkspaceToolbarSnapshot(
        session.page,
        { currentPage: startPage },
        { timeoutMs: 20_000 },
    );
    await waitForFunctionInPage(session.page, (pageNumber: number) => {
        const surface = document.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
        const viewer = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
        const startPage = surface?.querySelector<HTMLElement>(`[data-testid="document-page-source-page"][data-page-number="${pageNumber}"]`);
        return Boolean(
            viewer
            && viewer.scrollTop > 0
            && startPage
            && startPage.querySelector('img'),
        );
    }, { timeout: 20_000 }, startPage);

    await session.page.evaluate(async () => {
        await new Promise(resolve => setTimeout(resolve, 320));
    });
}

async function collectDjvuWheelMetricSamples(session: IElectronE2ESession) {
    const samples: IDjvuWheelMetricSample[] = [await readDjvuWheelMetricSample(session)];
    const viewerCenter = await session.page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
        const viewer = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
        if (!viewer) {
            throw new Error('DjVu viewer container was not found');
        }
        const rect = viewer.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });
    await session.page.mouse.move(viewerCenter.x, viewerCenter.y);

    for (let index = 0; index < 120; index += 1) {
        await session.page.mouse.wheel({ deltaY: DJVU_WHEEL_DELTA_Y });
        await session.page.evaluate(async () => {
            await new Promise(resolve => setTimeout(resolve, 24));
        });
        const sample = await readDjvuWheelMetricSample(session);
        samples.push(sample);
        if ((sample.currentPage ?? 0) >= 30 && index >= 40) {
            break;
        }
    }

    return samples;
}

async function collectDjvuProjectedScrollMetricSamples(session: IElectronE2ESession) {
    const samples: IDjvuWheelMetricSample[] = [await readDjvuWheelMetricSample(session)];

    for (let index = 0; index < DJVU_PROJECTED_SCROLL_STEPS; index += 1) {
        await session.page.evaluate((deltaY: number) => {
            const surface = document.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
            const viewer = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
            if (!viewer) {
                throw new Error('DjVu viewer container was not found');
            }

            viewer.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                deltaMode: 0,
                deltaY,
            }));
            viewer.scrollTop += deltaY;
        }, DJVU_PROJECTED_SCROLL_DELTA_Y);
        await session.page.evaluate(async (intervalMs: number) => {
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }, DJVU_PROJECTED_SCROLL_INTERVAL_MS);
        samples.push(await readDjvuWheelMetricSample(session));
    }

    return samples;
}

describe('Electron E2E - Viewer Smoke', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-viewer-smoke-${Date.now()}`});

    it('keeps disabled selected toolbar controls visually selected on hover', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-viewer-disabled-selected-toolbar-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await session.page.setViewport({
            deviceScaleFactor: 1,
            height: 1_152,
            width: 2_048,
        });
        const fixturePath = await createMultiPageTextFixturePdf(
            `viewer-disabled-selected-toolbar-${Date.now()}.pdf`,
            2,
        );
        await openPdfInApp(session.page, fixturePath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await session.page.evaluate(() => {
            document.querySelector<HTMLButtonElement>('.tab-list .tab.is-active .tab-close')?.click();
        });
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {hasPdf: false},
            {timeoutMs: VIEWER_SMOKE_OPEN_TIMEOUT_MS},
        );
        await session.page.waitForSelector('.toolbar-btn.is-active:disabled', {
            timeout: 10_000,
            visible: true,
        });
        const buttons = await session.page.$$('.toolbar-btn.is-active:disabled');
        expect(buttons.length).toBeGreaterThanOrEqual(3);

        const visualSamples = [];
        for (const button of buttons) {
            await session.page.mouse.move(1, 1);
            await session.page.evaluate(async () => {
                await new Promise(resolve => setTimeout(resolve, 180));
            });
            const before = await button.evaluate((element) => {
                const style = getComputedStyle(element);
                return {
                    backgroundColor: style.backgroundColor,
                    borderColor: style.borderColor,
                    boxShadow: style.boxShadow,
                };
            });
            await button.hover();
            await session.page.evaluate(async () => {
                await new Promise(resolve => setTimeout(resolve, 180));
            });
            const after = await button.evaluate((element) => {
                const style = getComputedStyle(element);
                return {
                    backgroundColor: style.backgroundColor,
                    borderColor: style.borderColor,
                    boxShadow: style.boxShadow,
                };
            });
            visualSamples.push({
                after,
                before,
                label: await button.evaluate(element => element.getAttribute('aria-label')),
            });
        }

        expect(visualSamples.every(sample => (
            sample.after.backgroundColor === sample.before.backgroundColor
            && sample.after.borderColor === sample.before.borderColor
            && sample.after.boxShadow === sample.before.boxShadow
        )), JSON.stringify(visualSamples)).toBe(true);
    });

    it('keeps physical macOS Control-wheel scrolling and reserves Command-wheel for zoom', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-viewer-macos-wheel-modifiers-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const isMac = await session.page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform));
        if (!isMac) {
            return;
        }

        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 900,
            width: 1_400,
        });
        const fixturePath = process.env.EVB_E2E_WHEEL_STRESS_PDF
            ?? await createMultiPageTextFixturePdf(
                `viewer-macos-wheel-modifiers-${Date.now()}.pdf`,
                12,
            );
        await openPdfInApp(session.page, fixturePath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        const point = await session.page.evaluate(() => {
            const viewer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host #pdf-viewer',
            );
            if (!viewer) {
                return null;
            }
            viewer.scrollTop = 0;
            const samples: Array<{
                ctrlKey: boolean;
                defaultPrevented: boolean;
                metaKey: boolean;
            }> = [];
            const heartbeat = {
                lastAt: performance.now(),
                maxGapMs: 0,
                sampleCount: 0,
            };
            const heartbeatTimer = window.setInterval(() => {
                const now = performance.now();
                heartbeat.maxGapMs = Math.max(heartbeat.maxGapMs, now - heartbeat.lastAt);
                heartbeat.lastAt = now;
                heartbeat.sampleCount += 1;
            }, 25);
            viewer.addEventListener('wheel', (event) => {
                queueMicrotask(() => samples.push({
                    ctrlKey: event.ctrlKey,
                    defaultPrevented: event.defaultPrevented,
                    metaKey: event.metaKey,
                }));
            });
            const testWindow = window as Window & {
                __macWheelHeartbeat?: typeof heartbeat;
                __macWheelHeartbeatTimer?: number;
                __macWheelModifierSamples?: typeof samples;
            };
            testWindow.__macWheelHeartbeat = heartbeat;
            testWindow.__macWheelHeartbeatTimer = heartbeatTimer;
            testWindow.__macWheelModifierSamples = samples;
            const rect = viewer.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });
        expect(point).not.toBeNull();
        if (!point) {
            return;
        }

        const toolbarBefore = await getWorkspaceToolbarSnapshot(session.page);
        expect(toolbarBefore?.effectiveZoom).toBeTypeOf('number');
        await session.page.mouse.move(point.x, point.y);
        const controlStressStartedAt = Date.now();
        await session.page.keyboard.down('Control');
        for (let index = 0; index < 40; index += 1) {
            await session.page.mouse.wheel({deltaY: 240});
        }
        await session.page.keyboard.up('Control');
        const controlStressElapsedMs = Date.now() - controlStressStartedAt;
        await waitForFunctionInPage(session.page, () => (
            (document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host #pdf-viewer',
            )?.scrollTop ?? 0) > 20
        ), {timeout: 5_000});
        const toolbarAfterControl = await getWorkspaceToolbarSnapshot(session.page);

        await session.page.evaluate(() => {
            const samples: Array<{
                hasVisual: boolean;
                timeMs: number;
                visiblePageCount: number;
            }> = [];
            let active = true;
            const sample = () => {
                if (!active) {
                    return;
                }
                const viewer = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host #pdf-viewer',
                );
                const viewerRect = viewer?.getBoundingClientRect() ?? null;
                const visiblePages = viewerRect
                    ? Array.from(viewer?.querySelectorAll<HTMLElement>('.page_container[data-page]') ?? [])
                        .filter((page) => {
                            const rect = page.getBoundingClientRect();
                            return rect.bottom > viewerRect.top && rect.top < viewerRect.bottom;
                        })
                    : [];
                const hasVisual = visiblePages.some((page) => {
                    const snapshot = page.querySelector<HTMLCanvasElement>('.pdf-resize-canvas-snapshot');
                    if (snapshot && snapshot.width > 0 && snapshot.height > 0) {
                        return true;
                    }
                    const renderLayer = page.querySelector<HTMLElement>('.page_canvas__render-layer');
                    const renderedCanvas = renderLayer?.querySelector<HTMLCanvasElement>('canvas');
                    return page.classList.contains('page_container--rendered')
                        && renderLayer !== null
                        && getComputedStyle(renderLayer).visibility !== 'hidden'
                        && renderedCanvas != null
                        && renderedCanvas.width > 0
                        && renderedCanvas.height > 0;
                });
                samples.push({
                    hasVisual,
                    timeMs: Math.round(performance.now()),
                    visiblePageCount: visiblePages.length,
                });
                requestAnimationFrame(sample);
            };
            const probeWindow = window as IMacWheelE2EWindow;
            probeWindow.__macWheelVisualProbe = {
                samples,
                stop() {
                    active = false;
                },
            };
            requestAnimationFrame(sample);
        });

        await session.page.keyboard.down('Meta');
        for (let index = 0; index < 16; index += 1) {
            await session.page.mouse.wheel({deltaY: -18});
            await new Promise(resolve => setTimeout(resolve, 8));
        }
        await session.page.keyboard.up('Meta');
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {minEffectiveZoom: (toolbarAfterControl?.effectiveZoom ?? 0) + 0.005},
            {timeoutMs: 10_000},
        );
        await new Promise(resolve => setTimeout(resolve, 700));
        const result = await session.page.evaluate(() => {
            const testWindow = window as IMacWheelE2EWindow;
            if (testWindow.__macWheelHeartbeatTimer !== undefined) {
                window.clearInterval(testWindow.__macWheelHeartbeatTimer);
            }
            testWindow.__macWheelVisualProbe?.stop();
            return {
                heartbeat: testWindow.__macWheelHeartbeat ?? null,
                samples: testWindow.__macWheelModifierSamples ?? [],
                visualSamples: testWindow.__macWheelVisualProbe?.samples ?? [],
                scrollTop: document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .workspace-host #pdf-viewer',
                )?.scrollTop ?? 0,
            };
        });

        expect(toolbarAfterControl?.effectiveZoom).toBeCloseTo(toolbarBefore?.effectiveZoom ?? 0, 5);
        expect(controlStressElapsedMs).toBeLessThan(10_000);
        expect(result.heartbeat?.sampleCount ?? 0).toBeGreaterThan(0);
        expect(result.heartbeat?.maxGapMs ?? Number.POSITIVE_INFINITY).toBeLessThan(1_500);
        expect(result.scrollTop).toBeGreaterThan(20);
        expect(result.samples.some(sample => (
            sample.ctrlKey && !sample.metaKey && !sample.defaultPrevented
        )), JSON.stringify(result.samples)).toBe(true);
        expect(result.samples.some(sample => (
            sample.metaKey && sample.defaultPrevented
        )), JSON.stringify(result.samples)).toBe(true);
        expect(result.visualSamples.length).toBeGreaterThan(5);
        expect(
            result.visualSamples.filter(sample => !sample.hasVisual),
            JSON.stringify(result.visualSamples),
        ).toEqual([]);
    }, 120_000);

    it('keeps the PDF viewport scrollable, navigable, and scalable', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-viewer-pdf-smoke-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const fixturePath = await createMultiPageTextFixturePdf(`viewer-smoke-${Date.now()}.pdf`, 4);
        await openPdfInApp(session.page, fixturePath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);

        const initial = await waitForViewerSmokeSnapshot(session);
        expect(initial.hostHeight).toBeGreaterThan(300);
        expect(initial.viewerHeight).toBeGreaterThan(300);
        expect(initial.firstPageHeight).toBeGreaterThan(300);
        expect(initial.firstPagePainted).toBe(true);
        expect(initial.visiblePages).toContain(1);

        const zoomed = await zoomInUntilScrollable(session, initial);
        expect(zoomed.scrollHeight).toBeGreaterThan(zoomed.clientHeight + 20);

        const scrollAttempt = await scrollToBottomOfPageOne(session);
        expect(scrollAttempt.maxScrollTop).toBeGreaterThan(20);

        await clickVisibleToolbarButton(session.page, 'Fit Height');
        await waitForFunctionInPage(session.page, (previousHeight: number) => {
            const pageElement = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host #pdf-viewer .page_container[data-page="1"]',
            );
            return Boolean(pageElement && Math.abs(pageElement.getBoundingClientRect().height - previousHeight) > 5);
        }, { timeout: 5_000 }, zoomed.firstPageHeight);

        await clickVisibleToolbarButton(session.page, 'Next Page');
        await waitForToolbarCurrentPage(session.page, 2);
        await waitForFunctionInPage(session.page, () => {
            const viewer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host #pdf-viewer',
            );
            if (!viewer) {
                return false;
            }

            const viewerRect = viewer.getBoundingClientRect();
            const pageTwo = viewer.querySelector<HTMLElement>('.page_container[data-page="2"]');
            if (!pageTwo) {
                return false;
            }

            const pageRect = pageTwo.getBoundingClientRect();
            return Math.min(pageRect.bottom, viewerRect.bottom) - Math.max(pageRect.top, viewerRect.top) > 100;
        }, { timeout: 5_000 });
    });

    it('preserves a user-established PDF viewport anchor through separate split-divider drags', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-viewer-pdf-split-resize-${Date.now()}`,
        });
        if (!session) {
            return;
        }
        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        const fixturePath = await createMultiPageTextFixturePdf(
            `viewer-pdf-split-resize-${Date.now()}.pdf`,
            8,
        );
        await openPdfInApp(session.page, fixturePath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        const fitWidth = await callWorkspaceCommand(session.page, 'handleFitWidth');
        expect(fitWidth.called).toBe(true);
        await goToPageViaToolbar(session.page, 4);
        await nudgeActiveDocumentViewportWithWheel(session, 'pdf', 220);

        const sourcePaneId = await session.page.evaluate(() => (
            document.querySelector<HTMLElement>('.editor-pane.is-active')?.dataset.editorPaneId ?? null
        ));
        expect(sourcePaneId).not.toBeNull();
        const userAnchor = await readSplitResizeViewportAnchor(session, sourcePaneId!, 'pdf');
        expect(userAnchor.scrollTop).toBeGreaterThan(0);
        expect(userAnchor.pageHeight).toBeGreaterThan(100);
        expect(userAnchor.readyVisiblePageCount).toBeGreaterThan(0);

        const retainedPaneId = await splitActivePaneWithEmptyEditor(session);
        expect(retainedPaneId).toBe(sourcePaneId);
        const afterSplit = await waitForSplitResizeViewportAnchor(
            session,
            retainedPaneId,
            'pdf',
            userAnchor,
        );
        expectSplitResizeAnchorPreserved(afterSplit, userAnchor);

        await dragEditorDividerToRatio(session, 0.32);
        const afterNarrowDrag = await waitForSplitResizeViewportAnchor(
            session,
            retainedPaneId,
            'pdf',
            userAnchor,
        );
        expectSplitResizeAnchorPreserved(afterNarrowDrag, userAnchor);
        expect(afterNarrowDrag.paneWidth).toBeLessThan(afterSplit.paneWidth - 100);

        await dragEditorDividerToRatio(session, 0.68);
        const afterWideDrag = await waitForSplitResizeViewportAnchor(
            session,
            retainedPaneId,
            'pdf',
            userAnchor,
        );
        expectSplitResizeAnchorPreserved(afterWideDrag, userAnchor);
        expect(afterWideDrag.paneWidth).toBeGreaterThan(afterNarrowDrag.paneWidth + 250);
    }, 90_000);

    it('exposes named sidebar tabs and navigates from a real search result', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-viewer-sidebar-search-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const fixturePath = await createMultiPageTextFixturePdf(
            `viewer-sidebar-search-${Date.now()}.pdf`,
            4,
        );
        await openPdfInApp(session.page, fixturePath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await ensureSidebarOpen(session.page);

        const tabNames = await session.page.evaluate(() => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] [role="tab"]',
            )).map(tab => tab.textContent?.trim() ?? '')
        ));
        const commonTabOrder = [
            'Annotations',
            'Pages',
            'Bookmarks',
            'Search',
        ];
        expect(tabNames).toEqual(commonTabOrder);

        const sidebarTabs = await session.page.$$(
            '.editor-pane.is-active [data-testid="document-sidebar"] [role="tab"]',
        );
        expect(sidebarTabs).toHaveLength(4);
        await openDocumentSidebarTab(session.page, 'Search');

        await waitForFunctionInPage(session.page, () => {
            const input = document.querySelector<HTMLInputElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-bar input',
            );
            return Boolean(input && input.getBoundingClientRect().width > 0);
        }, { timeout: 10_000 });
        const searchInput = await session.page.$(
            '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-bar input',
        );
        expect(searchInput).not.toBeNull();
        expect(await searchInput!.evaluate(input => ({
            accessibleName: input.getAttribute('aria-label'),
            placeholder: input.getAttribute('placeholder'),
        }))).toEqual({
            accessibleName: 'Search document',
            placeholder: 'Search...',
        });
        await searchInput!.type('Page 3 sample text');
        const searchStarted = await session.page.evaluate(() => {
            const button = document.querySelector<HTMLButtonElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .search-run-button',
            );
            if (!button || button.disabled) {
                return false;
            }
            button.click();
            return true;
        });
        expect(searchStarted).toBe(true);

        await waitForFunctionInPage(session.page, () => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result',
            )).some(result => result.textContent?.includes('Page 3 sample text'))
        ), { timeout: 15_000 });
        const clickedResult = await session.page.evaluate(() => {
            const result = Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result',
            )).find(candidate => candidate.textContent?.includes('Page 3 sample text'));
            result?.click();
            return Boolean(result);
        });
        expect(clickedResult).toBe(true);
        await waitForToolbarCurrentPage(session.page, 3);
        await waitForFunctionInPage(session.page, () => {
            const viewer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host #pdf-viewer',
            );
            const page = viewer?.querySelector<HTMLElement>('.page_container[data-page="3"]') ?? null;
            const currentResult = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result[aria-current="true"]',
            );
            if (!viewer || !page || !currentResult) {
                return false;
            }
            const viewerRect = viewer.getBoundingClientRect();
            const pageRect = page.getBoundingClientRect();
            const canvas = page.querySelector<HTMLCanvasElement>('.page_canvas canvas, canvas');
            return Math.min(viewerRect.bottom, pageRect.bottom) - Math.max(viewerRect.top, pageRect.top) > 8
                && Boolean(canvas && canvas.width > 0 && canvas.height > 0);
        }, {timeout: 15_000});
    });

    it('never presents an under-resolution thumbnail when the sidebar first opens', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-viewer-thumbnail-first-open-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 1_000,
            width: 1_200,
        });
        const fixturePath = await createMultiPageTextFixturePdf(
            `viewer-thumbnail-first-open-${Date.now()}.pdf`,
            12,
        );
        await openPdfInApp(session.page, fixturePath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);

        await waitForFunctionInPage(session.page, () => {
            const sidebar = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"]',
            );
            return !sidebar || getComputedStyle(sidebar).display === 'none';
        });

        await session.page.evaluate(() => {
            interface IProbeSample {
                cssWidth: number;
                elapsedMs: number;
                page: number;
                pixelWidth: number;
                presented: boolean;
                requiredPixelWidth: number;
                underResolution: boolean;
            }
            interface IProbeState {
                active: boolean;
                samples: IProbeSample[];
            }
            interface IProbeWindow extends Window {__thumbnailFirstOpenProbe?: IProbeState;}
            const probeWindow = window as IProbeWindow;
            const probe = {
                active: true,
                samples: [] as IProbeSample[],
            };
            const startedAt = performance.now();
            probeWindow.__thumbnailFirstOpenProbe = probe;
            const sample = () => {
                if (!probe.active) {
                    return;
                }
                const rail = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .pdf-sidebar-pages-thumbnails .pdf-thumbnails',
                );
                const railRect = rail?.getBoundingClientRect() ?? null;
                const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
                if (rail && railRect && railRect.width > 0 && railRect.height > 0) {
                    for (const canvas of rail.querySelectorAll<HTMLCanvasElement>('.pdf-thumbnail-canvas')) {
                        const item = canvas.closest<HTMLElement>('.pdf-thumbnail');
                        const itemRect = item?.getBoundingClientRect() ?? null;
                        const canvasRect = canvas.getBoundingClientRect();
                        if (
                            !item
                            || !itemRect
                            || itemRect.bottom <= railRect.top
                            || itemRect.top >= railRect.bottom
                            || canvasRect.width <= 0
                        ) {
                            continue;
                        }
                        const presented = canvas.dataset.thumbnailRendered === 'true'
                            || canvas.dataset.thumbnailPreservedBitmap === 'true';
                        const requiredPixelWidth = Math.ceil(canvasRect.width * outputScale);
                        probe.samples.push({
                            cssWidth: Math.round(canvasRect.width),
                            elapsedMs: Math.round(performance.now() - startedAt),
                            page: Number(item.dataset.page),
                            pixelWidth: canvas.width,
                            presented,
                            requiredPixelWidth,
                            underResolution: presented && canvas.width < requiredPixelWidth,
                        });
                    }
                }
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });

        await clickVisibleToolbarButton(session.page, 'Toggle Sidebar');
        await openDocumentSidebarTab(session.page, 'Pages');
        await waitForFunctionInPage(session.page, () => {
            const canvas = document.querySelector<HTMLCanvasElement>(
                '.editor-pane.is-active .pdf-thumbnail[data-page="1"] .pdf-thumbnail-canvas',
            );
            if (!canvas || canvas.dataset.thumbnailRendered !== 'true') {
                return false;
            }
            const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
            return canvas.width >= Math.ceil(canvas.getBoundingClientRect().width * outputScale);
        }, {timeout: 10_000});
        await session.page.evaluate(async () => {
            await new Promise(resolve => setTimeout(resolve, 200));
        });

        const firstOpenProbe = await session.page.evaluate(() => {
            interface IProbeSample {
                cssWidth: number;
                elapsedMs: number;
                page: number;
                pixelWidth: number;
                presented: boolean;
                requiredPixelWidth: number;
                underResolution: boolean;
            }
            interface IProbeState {
                active: boolean;
                samples: IProbeSample[];
            }
            interface IProbeWindow extends Window {__thumbnailFirstOpenProbe?: IProbeState;}
            const probeWindow = window as IProbeWindow;
            const probe = probeWindow.__thumbnailFirstOpenProbe;
            if (!probe) {
                throw new Error('Thumbnail first-open probe was not installed');
            }
            probe.active = false;
            return {
                firstPresented: probe.samples.find(sample => sample.presented) ?? null,
                sampleCount: probe.samples.length,
                underResolution: probe.samples.filter(sample => sample.underResolution),
            };
        });
        expect(firstOpenProbe.sampleCount, JSON.stringify(firstOpenProbe)).toBeGreaterThan(0);
        expect(firstOpenProbe.firstPresented, JSON.stringify(firstOpenProbe)).not.toBeNull();
        expect(firstOpenProbe.underResolution, JSON.stringify(firstOpenProbe)).toEqual([]);
    });

    it('keeps the visible thumbnail triplet painted through sustained raster pressure', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-viewer-thumbnail-open-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await session.page.setViewport({
            deviceScaleFactor: 2,
            // The three neighboring thumbnails are the regression subject.
            // Give their portrait canvases enough vertical CSS space to all
            // be genuinely viewport-resident instead of weakening the test
            // to include an intentionally cold offscreen neighbor.
            height: 1_600,
            width: 1_200,
        });
        const fixturePath = await createMultiPageTextFixturePdf(`viewer-thumbnail-open-${Date.now()}.pdf`, 36);
        await openPdfInApp(session.page, fixturePath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await ensureSidebarOpen(session.page);
        await openDocumentSidebarTab(session.page, 'Pages');
        await waitForFunctionInPage(session.page, () => {
            const pages = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .pdf-sidebar-pages',
            );
            const firstCanvas = document.querySelector<HTMLCanvasElement>(
                '.editor-pane.is-active .pdf-thumbnail[data-page="1"] .pdf-thumbnail-canvas',
            );
            return Boolean(
                pages
                && pages.getBoundingClientRect().height > 0
                && firstCanvas?.dataset.thumbnailRendered === 'true'
                && firstCanvas.width > 0
                && firstCanvas.height > 0,
            );
        }, {timeout: 10_000});

        const pdfPageGeometry = await readBalancedScrollRegionGeometry(
            session,
            '.editor-pane.is-active #pdf-viewer',
            '.editor-pane.is-active #pdf-viewer .page_container[data-page="1"]',
        );
        expectBalancedScrollRegion(pdfPageGeometry, JSON.stringify({pdfPageGeometry}));
        const pdfThumbnailGeometry = await readBalancedScrollRegionGeometry(
            session,
            '.editor-pane.is-active .pdf-thumbnails',
            '.editor-pane.is-active .pdf-thumbnail[data-page="1"] .pdf-thumbnail-canvas',
        );
        expectBalancedScrollRegion(pdfThumbnailGeometry, JSON.stringify({pdfThumbnailGeometry}));

        await goToPageViaToolbar(session.page, 18);
        await waitForFunctionInPage(session.page, () => Boolean(document.querySelector(
            '.editor-pane.is-active .pdf-thumbnail[data-page="18"]',
        )), {timeout: 10_000});
        const zoomResult = await callWorkspaceCommand(session.page, 'setCustomZoomFromDisplay', [4]);
        expect(zoomResult.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(session.page, {minEffectiveZoom: 3.99}, {timeoutMs: 15_000});

        await session.page.evaluate(() => {
            const probeWindow = window as IThumbnailPaintProbeWindow;
            const samples: IThumbnailPaintSample[] = [];
            const sampleCanvas = document.createElement('canvas');
            sampleCanvas.width = 32;
            sampleCanvas.height = 32;
            const sampleContext = sampleCanvas.getContext('2d', {willReadFrequently: true});
            let active = true;

            function sample() {
                if (!active) {
                    return;
                }
                const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(
                    '.editor-pane.is-active .pdf-sidebar-pages-thumbnails .pdf-thumbnail-canvas',
                ));
                const container = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .pdf-sidebar-pages-thumbnails .pdf-thumbnails',
                );
                const containerRect = container?.getBoundingClientRect() ?? null;
                for (const canvas of canvases) {
                    const item = canvas.closest<HTMLElement>('.pdf-thumbnail');
                    const page = Number(item?.dataset.page);
                    if (!Number.isFinite(page) || page < 17 || page > 19) {
                        continue;
                    }
                    let contentPixels = 0;
                    if (sampleContext && canvas.width > 0 && canvas.height > 0) {
                        sampleContext.clearRect(0, 0, 32, 32);
                        sampleContext.drawImage(canvas, 0, 0, 32, 32);
                        const pixels = sampleContext.getImageData(0, 0, 32, 32).data;
                        for (let index = 0; index < pixels.length; index += 4) {
                            const alpha = pixels[index + 3] ?? 0;
                            if (alpha > 32) {
                                contentPixels += 1;
                            }
                        }
                    }
                    samples.push({
                        containerClientHeight: container?.clientHeight ?? 0,
                        containerScrollHeight: container?.scrollHeight ?? 0,
                        containerScrollTop: container?.scrollTop ?? 0,
                        contentPixels,
                        height: canvas.height,
                        intersectsViewport: Boolean(item && containerRect
                            && item.getBoundingClientRect().bottom > containerRect.top
                            && item.getBoundingClientRect().top < containerRect.bottom),
                        itemViewportTop: item && containerRect
                            ? item.getBoundingClientRect().top - containerRect.top
                            : 0,
                        page,
                        renderKey: canvas.dataset.thumbnailRenderKey ?? null,
                        rendered: canvas.dataset.thumbnailRendered === 'true',
                        timeMs: Math.round(performance.now()),
                        width: canvas.width,
                    });
                }
                requestAnimationFrame(sample);
            }

            probeWindow.__thumbnailPaintProbe = {
                samples,
                stop() {
                    active = false;
                },
            };
            requestAnimationFrame(sample);
        });

        await session.page.evaluate(() => {
            const container = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .pdf-sidebar-pages-thumbnails .pdf-thumbnails',
            );
            const current = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .pdf-thumbnail[data-page="18"]',
            );
            if (!container || !current) {
                return;
            }
            const containerRect = container.getBoundingClientRect();
            const currentRect = current.getBoundingClientRect();
            container.scrollTop = Math.max(
                0,
                container.scrollTop
                + currentRect.top
                - containerRect.top
                - (container.clientHeight - currentRect.height) / 2,
            );
            container.dispatchEvent(new Event('scroll', {bubbles: true}));
        });
        let thumbnailTriplet: Array<{
            height: number;
            intersectsViewport: boolean;
            page: number;
            rendered: boolean;
            width: number;
        }> = [];
        const thumbnailDeadline = Date.now() + 20_000;
        while (Date.now() < thumbnailDeadline) {
            thumbnailTriplet = await session.page.evaluate(() => [
                17,
                18,
                19,
            ].map((page) => {
                const container = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .pdf-sidebar-pages-thumbnails .pdf-thumbnails',
                );
                const canvas = document.querySelector<HTMLCanvasElement>(
                    `.editor-pane.is-active .pdf-thumbnail[data-page="${String(page)}"] .pdf-thumbnail-canvas`,
                );
                const item = canvas?.closest<HTMLElement>('.pdf-thumbnail');
                const containerRect = container?.getBoundingClientRect() ?? null;
                const itemRect = item?.getBoundingClientRect() ?? null;
                return {
                    height: canvas?.height ?? 0,
                    intersectsViewport: Boolean(containerRect && itemRect
                        && itemRect.bottom > containerRect.top
                        && itemRect.top < containerRect.bottom),
                    page,
                    rendered: canvas?.dataset.thumbnailRendered === 'true',
                    width: canvas?.width ?? 0,
                };
            }));
            if (thumbnailTriplet.every(sample => (
                sample.intersectsViewport
                && sample.rendered
                && sample.width > 0
                && sample.height > 0
            ))) {
                break;
            }
            await session.page.evaluate(async () => {
                await new Promise(resolve => setTimeout(resolve, 100));
            });
        }
        expect(thumbnailTriplet.every(sample => (
            sample.intersectsViewport
            && sample.rendered
            && sample.width > 0
            && sample.height > 0
        )), JSON.stringify(thumbnailTriplet)).toBe(true);
        const pressureResult = await session.page.evaluate(async () => {
            const probeWindow = window as IThumbnailPaintProbeWindow;
            const applyPressure = () => probeWindow.__setWorkspaceSurfacePressureForE2E?.('critical');
            if (!probeWindow.__setWorkspaceSurfacePressureForE2E) {
                throw new Error('Workspace surface pressure E2E hook is unavailable');
            }
            applyPressure();
            const pressureTimer = window.setInterval(applyPressure, 200);
            await new Promise(resolve => setTimeout(resolve, 5_500));
            window.clearInterval(pressureTimer);
            const snapshot = probeWindow.__getWorkspaceSurfaceBudgetForE2E?.() ?? null;
            probeWindow.__setWorkspaceSurfacePressureForE2E('healthy');
            return {snapshot};
        });
        const pressureSnapshot = pressureResult.snapshot;
        const samples = await session.page.evaluate(() => {
            const probe = (window as IThumbnailPaintProbeWindow).__thumbnailPaintProbe;
            probe?.stop();
            return probe?.samples ?? [];
        });

        const samplesByPage = Map.groupBy(samples, sample => sample.page);
        const regressions = Array.from(samplesByPage.entries()).flatMap(([
            page,
            pageSamples,
        ]) => {
            const firstPaintIndex = pageSamples.findIndex(sample => sample.contentPixels > 1);
            if (firstPaintIndex < 0) {
                return [];
            }
            const firstPaint = pageSamples[firstPaintIndex]!;
            const cleared = pageSamples.slice(firstPaintIndex + 1).find(sample => (
                sample.width === 0
                || sample.height === 0
                || sample.contentPixels === 0
            ));
            return cleared ? [{
                page,
                firstPaint,
                cleared,
            }] : [];
        });
        const settledPages = Array.from(samplesByPage.entries())
            .filter(([
                ,
                pageSamples,
            ]) => pageSamples.some(sample => sample.rendered && sample.contentPixels > 1))
            .map(([page]) => page);
        const targetPages = [
            17,
            18,
            19,
        ];
        const stableStartTime = Math.max(...targetPages.map(page => (
            samplesByPage.get(page)?.find(sample => sample.rendered && sample.contentPixels > 1)?.timeMs ?? 0
        )));
        const visibleCurrentPageSamples = samples.filter(sample => (
            sample.page === 18
            && sample.intersectsViewport
            && sample.timeMs >= stableStartTime
        ));
        const metricSpread = (values: number[]) => Math.max(...values) - Math.min(...values);

        expect(pressureSnapshot).toMatchObject({pressureLevel: 'critical'});
        expect(settledPages).toEqual(expect.arrayContaining(targetPages));
        expect(regressions, JSON.stringify({
            regressions,
            settledPages,
            pressureSnapshot,
        })).toEqual([]);
        for (const page of targetPages) {
            const finalSample = samplesByPage.get(page)?.at(-1);
            expect(finalSample, `missing final sample for thumbnail ${String(page)}`).toMatchObject({
                rendered: true,
                intersectsViewport: true,
            });
            expect(finalSample?.width ?? 0).toBeGreaterThan(0);
            expect(finalSample?.height ?? 0).toBeGreaterThan(0);
            expect(finalSample?.contentPixels ?? 0).toBeGreaterThan(1);
        }
        expect(visibleCurrentPageSamples.length).toBeGreaterThan(1);
        expect(metricSpread(visibleCurrentPageSamples.map(sample => sample.containerScrollHeight))).toBeLessThanOrEqual(1);
        expect(metricSpread(visibleCurrentPageSamples.map(sample => sample.containerScrollTop))).toBeLessThanOrEqual(1);
        expect(metricSpread(visibleCurrentPageSamples.map(sample => sample.itemViewportTop))).toBeLessThanOrEqual(1);
    }, 120_000);

    it('keeps rapidly scrolled large-scan pages and thumbnails visibly occupied', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-viewer-thumbnail-fast-scroll-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await session.page.setViewport({
            deviceScaleFactor: 2,
            height: 900,
            width: 1_400,
        });
        const fixturePath = process.env.EVB_E2E_THUMBNAIL_STRESS_PDF
            ?? await createLargeScannedFixturePdf(
                `viewer-thumbnail-fast-scroll-${Date.now()}.pdf`,
                348,
                0,
            );
        await openPdfInApp(session.page, fixturePath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);

        const pageContinuity = await session.page.evaluate(async () => {
            const viewer = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host #pdf-viewer',
            );
            if (!viewer) {
                throw new Error('PDF viewer was not found');
            }

            const sample = () => {
                const viewerRect = viewer.getBoundingClientRect();
                const mountedPages = Array.from(viewer.querySelectorAll<HTMLElement>('.page_container[data-page]'));
                const visiblePages = mountedPages
                    .filter((page) => {
                        const rect = page.getBoundingClientRect();
                        return rect.bottom > viewerRect.top && rect.top < viewerRect.bottom;
                    });
                const occupied = visiblePages.some((page) => {
                    const canvas = Array.from(page.querySelectorAll<HTMLCanvasElement>(
                        '.page_canvas__render-layer canvas, .pdf-resize-canvas-snapshot',
                    )).find(candidate => candidate.width > 0 && candidate.height > 0);
                    const skeleton = page.querySelector<HTMLElement>('.pdf-page-skeleton');
                    const skeletonRect = skeleton?.getBoundingClientRect() ?? null;
                    return Boolean(canvas || (
                        skeleton
                        && getComputedStyle(skeleton).display !== 'none'
                        && (skeletonRect?.width ?? 0) > 0
                        && (skeletonRect?.height ?? 0) > 0
                    ));
                });
                return {
                    firstMountedPage: Number(mountedPages[0]?.dataset.page ?? 0),
                    firstMountedTop: Math.round(mountedPages[0]?.getBoundingClientRect().top ?? 0),
                    lastMountedBottom: Math.round(mountedPages.at(-1)?.getBoundingClientRect().bottom ?? 0),
                    lastMountedPage: Number(mountedPages.at(-1)?.dataset.page ?? 0),
                    occupied,
                    scrollHeight: viewer.scrollHeight,
                    scrollTop: Math.round(viewer.scrollTop),
                    visiblePageCount: visiblePages.length,
                };
            };

            let consecutiveBlankFrames = 0;
            let maxConsecutiveBlankFrames = 0;
            let zeroVisiblePageFrames = 0;
            const motionSamples: Array<{
                firstMountedPage: number;
                firstMountedTop: number;
                lastMountedBottom: number;
                lastMountedPage: number;
                occupied: boolean;
                scrollHeight: number;
                scrollTop: number;
                visiblePageCount: number;
            }> = [];
            const maxScrollTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
            for (let frame = 0; frame < 90; frame += 1) {
                const target = frame < 45
                    ? 0.5 + 0.46 * Math.sin(frame * 0.82)
                    : 0.92 - 0.3 * (1 - ((frame - 45) / 44)) ** 3;
                viewer.scrollTop = maxScrollTop * target;
                viewer.dispatchEvent(new Event('scroll', {bubbles: true}));
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                const frameSample = sample();
                motionSamples.push(frameSample);
                if (frameSample.visiblePageCount === 0) {
                    zeroVisiblePageFrames += 1;
                }
                if (frameSample.occupied) {
                    consecutiveBlankFrames = 0;
                } else {
                    consecutiveBlankFrames += 1;
                    maxConsecutiveBlankFrames = Math.max(
                        maxConsecutiveBlankFrames,
                        consecutiveBlankFrames,
                    );
                }
            }

            const finalScrollAt = performance.now();
            let finalSample = sample();
            while (!finalSample.occupied && performance.now() - finalScrollAt < 5_000) {
                await new Promise(resolve => setTimeout(resolve, 25));
                finalSample = sample();
            }
            return {
                finalOccupiedElapsedMs: Math.round(performance.now() - finalScrollAt),
                finalSample,
                lastMotionSample: motionSamples.at(-1) ?? null,
                maxConsecutiveBlankFrames,
                zeroVisiblePageFrames,
            };
        });
        expect(pageContinuity.maxConsecutiveBlankFrames, JSON.stringify(pageContinuity)).toBeLessThanOrEqual(4);
        expect(pageContinuity.finalSample.occupied, JSON.stringify(pageContinuity)).toBe(true);
        expect(pageContinuity.finalOccupiedElapsedMs).toBeLessThanOrEqual(2_000);

        await ensureSidebarOpen(session.page);
        await openDocumentSidebarTab(session.page, 'Pages');
        await waitForFunctionInPage(session.page, () => Boolean(document.querySelector(
            '.editor-pane.is-active .pdf-thumbnail-canvas[data-thumbnail-rendered="true"]',
        )), {timeout: 10_000});

        const visualContinuity = await session.page.evaluate(async () => {
            const rail = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .pdf-sidebar-pages-thumbnails .pdf-thumbnails',
            );
            if (!rail) {
                throw new Error('PDF thumbnail rail was not found');
            }

            const placeholder = rail.querySelector<HTMLElement>('.pdf-thumbnail-skeleton');
            const placeholderStyle = placeholder ? getComputedStyle(placeholder) : null;
            const placeholderPresentation = {
                animationName: placeholderStyle?.animationName ?? null,
                backgroundImage: placeholderStyle?.backgroundImage ?? null,
            };

            const defaultCanvasPreservation: Array<{
                height: number;
                page: number;
                width: number;
            }> = [];
            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    const canvas = mutation.target;
                    if (
                        !(canvas instanceof HTMLCanvasElement)
                        || mutation.attributeName !== 'data-thumbnail-preserved-bitmap'
                        || canvas.dataset.thumbnailPreservedBitmap !== 'true'
                        || canvas.width !== 300
                        || canvas.height !== 150
                    ) {
                        continue;
                    }
                    const page = Number(canvas.closest<HTMLElement>('.pdf-thumbnail')?.dataset.page);
                    defaultCanvasPreservation.push({
                        height: canvas.height,
                        page,
                        width: canvas.width,
                    });
                }
            });
            observer.observe(rail, {
                attributeFilter: ['data-thumbnail-preserved-bitmap'],
                attributes: true,
                subtree: true,
            });

            const sampleVisibleItems = () => {
                const railRect = rail.getBoundingClientRect();
                return Array.from(rail.querySelectorAll<HTMLElement>('.pdf-thumbnail')).flatMap((item) => {
                    const itemRect = item.getBoundingClientRect();
                    if (itemRect.bottom <= railRect.top || itemRect.top >= railRect.bottom) {
                        return [];
                    }
                    const canvas = item.querySelector<HTMLCanvasElement>('.pdf-thumbnail-canvas');
                    const skeleton = item.querySelector<HTMLElement>('.pdf-thumbnail-skeleton');
                    let contentPixels = 0;
                    if (canvas && canvas.width > 0 && canvas.height > 0) {
                        const probe = document.createElement('canvas');
                        probe.width = 32;
                        probe.height = 32;
                        const context = probe.getContext('2d', {willReadFrequently: true});
                        if (context) {
                            context.drawImage(canvas, 0, 0, probe.width, probe.height);
                            const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
                            for (let index = 0; index < pixels.length; index += 4) {
                                const red = pixels[index] ?? 255;
                                const green = pixels[index + 1] ?? 255;
                                const blue = pixels[index + 2] ?? 255;
                                const alpha = pixels[index + 3] ?? 0;
                                if (
                                    alpha > 0
                                    && (
                                        red < 245
                                        || green < 245
                                        || blue < 245
                                    )
                                ) {
                                    contentPixels += 1;
                                }
                            }
                        }
                    }
                    const skeletonStyle = skeleton ? getComputedStyle(skeleton) : null;
                    const skeletonRect = skeleton?.getBoundingClientRect() ?? null;
                    const skeletonVisible = Boolean(
                        skeleton
                        && skeletonStyle
                        && skeletonStyle.display !== 'none'
                        && skeletonStyle.visibility !== 'hidden'
                        && Number.parseFloat(skeletonStyle.opacity || '1') > 0.01
                        && (skeletonRect?.width ?? 0) > 0
                        && (skeletonRect?.height ?? 0) > 0,
                    );
                    const canvasCommitted = canvas?.dataset.thumbnailRendered === 'true';
                    const preserved = canvas?.dataset.thumbnailPreservedBitmap === 'true';
                    const painted = canvasCommitted && contentPixels > 0;
                    return [{
                        canvasCommitted,
                        contentPixels,
                        page: Number(item.dataset.page),
                        painted,
                        preserved,
                        skeletonDisplay: skeletonStyle?.display ?? null,
                        skeletonHeight: skeletonRect?.height ?? 0,
                        skeletonOpacity: skeletonStyle?.opacity ?? null,
                        skeletonVisible,
                        skeletonWidth: skeletonRect?.width ?? 0,
                    }];
                });
            };

            const blankExposures: Array<{
                canvasCommitted: boolean;
                contentPixels: number;
                elapsedMs: number;
                page: number;
                preserved: boolean;
                skeletonDisplay: string | null;
                skeletonHeight: number;
                skeletonOpacity: string | null;
                skeletonVisible: boolean;
                skeletonWidth: number;
            }> = [];
            const startedAt = performance.now();
            let motionItemSamples = 0;
            const sampleFrame = () => {
                for (const item of sampleVisibleItems()) {
                    motionItemSamples += 1;
                    if (
                        !item.canvasCommitted
                        && !item.preserved
                        && !item.skeletonVisible
                    ) {
                        blankExposures.push({
                            canvasCommitted: item.canvasCommitted,
                            contentPixels: item.contentPixels,
                            elapsedMs: Math.round(performance.now() - startedAt),
                            page: item.page,
                            preserved: item.preserved,
                            skeletonDisplay: item.skeletonDisplay,
                            skeletonHeight: item.skeletonHeight,
                            skeletonOpacity: item.skeletonOpacity,
                            skeletonVisible: item.skeletonVisible,
                            skeletonWidth: item.skeletonWidth,
                        });
                    }
                }
            };

            const maxScrollTop = Math.max(0, rail.scrollHeight - rail.clientHeight);
            for (let frame = 0; frame < 90; frame += 1) {
                const target = frame < 45
                    ? 0.5 + 0.44 * Math.sin(frame * 0.9)
                    : 0.48 + 0.32 * (1 - ((frame - 45) / 44)) ** 3;
                rail.scrollTop = maxScrollTop * target;
                rail.dispatchEvent(new Event('scroll', {bubbles: true}));
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                sampleFrame();
            }

            const finalJumpAt = performance.now();
            const settleDeadline = performance.now() + 10_000;
            let settledItems = sampleVisibleItems();
            let firstPaintElapsedMs: number | null = settledItems.some(item => item.painted) ? 0 : null;
            while (
                performance.now() < settleDeadline
                && (
                    settledItems.length === 0
                    || settledItems.some(item => !item.painted)
                )
            ) {
                sampleFrame();
                await new Promise(resolve => setTimeout(resolve, 50));
                settledItems = sampleVisibleItems();
                if (firstPaintElapsedMs === null && settledItems.some(item => item.painted)) {
                    firstPaintElapsedMs = Math.round(performance.now() - finalJumpAt);
                }
            }
            observer.disconnect();
            return {
                blankExposures,
                defaultCanvasPreservation,
                firstPaintElapsedMs,
                motionItemSamples,
                placeholderPresentation,
                settledElapsedMs: Math.round(performance.now() - finalJumpAt),
                settledItems,
            };
        });

        expect(visualContinuity.defaultCanvasPreservation).toEqual([]);
        expect(visualContinuity.blankExposures).toEqual([]);
        expect(visualContinuity.placeholderPresentation.animationName).toBe('none');
        expect(visualContinuity.placeholderPresentation.backgroundImage).toContain('linear-gradient');
        expect(visualContinuity.placeholderPresentation.backgroundImage).not.toContain('repeating-linear-gradient');
        expect(visualContinuity.motionItemSamples).toBeGreaterThan(0);
        expect(visualContinuity.firstPaintElapsedMs).not.toBeNull();
        expect(visualContinuity.firstPaintElapsedMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2_000);
        expect(visualContinuity.settledElapsedMs).toBeLessThanOrEqual(5_000);
        expect(visualContinuity.settledItems.length).toBeGreaterThan(0);
        expect(
            visualContinuity.settledItems.every(item => item.painted),
            JSON.stringify(visualContinuity.settledItems),
        ).toBe(true);
    }, 180_000);

    it('opens a PNG image through the same document entrypoint', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-viewer-smoke-image-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const pngPath = createPngFixture(`viewer-smoke-image-${Date.now()}.png`);
        await triggerOpenPathInApp(session.page, pngPath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);

        const snapshot = await waitForViewerSmokeSnapshot(session, {
            viewerHeight: 300,
            firstPageHeight: 0,
        });
        expect(snapshot.hostHeight).toBeGreaterThan(300);
        expect(snapshot.viewerHeight).toBeGreaterThan(300);
        expect(snapshot.visiblePages).toEqual([1]);
        expect(snapshot.firstPageWidth).toBeGreaterThan(0);
        expect(snapshot.firstPageHeight).toBeGreaterThan(0);
        expect(snapshot.firstPagePainted).toBe(true);
    });
});

runDjvuSmokeOrSkip('Electron E2E - DjVu Viewer Smoke', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-djvu-viewer-smoke-${Date.now()}`});

    it('uses one thumbnail rail presentation and late-page activation contract for PDF and DjVu', async () => {
        let session = sessionFixture.getSession();
        if (!session || !djvuFixture.path) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-thumbnail-parity-pdf-${Date.now()}`,
        });
        if (!session) {
            return;
        }
        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        const pdfPath = await createMultiPageTextFixturePdf(`thumbnail-parity-${Date.now()}.pdf`, 36);
        await openPdfInApp(session.page, pdfPath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        const pdf = await captureDocumentThumbnailParitySnapshot(session, 18);

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-thumbnail-parity-djvu-${Date.now()}`,
        });
        if (!session) {
            return;
        }
        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        const djvu = await captureDocumentThumbnailParitySnapshot(session, 18);

        for (const snapshot of [
            pdf,
            djvu,
        ]) {
            expect(snapshot.activeTab).toBe('Pages');
            expect(snapshot.currentPage).toBe(18);
            expect(snapshot.currentVisible).toBe(true);
            expect(snapshot.observedCurrentPages.length).toBeGreaterThan(0);
            expect(snapshot.observedCurrentPages.every(page => page === 18)).toBe(true);
        }
        expect(djvu.rail).toEqual(pdf.rail);
        expect(djvu.item).toEqual(pdf.item);
        expect(djvu.frame).toEqual(pdf.frame);
        expect(djvu.label).toEqual(pdf.label);
    }, 150_000);

    it('uses the shared macOS Control-scroll and Command-zoom policy for DjVu', async () => {
        let session = sessionFixture.getSession();
        if (!session || !djvuFixture.path) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-macos-wheel-modifiers-${Date.now()}`,
        });
        if (!session) {
            return;
        }
        const isMac = await session.page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform));
        if (!isMac) {
            return;
        }

        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        const point = await session.page.evaluate(() => {
            const surface = document.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
            const viewport = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
            if (!viewport) {
                return null;
            }
            viewport.scrollTop = 0;
            const samples: NonNullable<IMacWheelE2EWindow['__macWheelModifierSamples']> = [];
            viewport.addEventListener('wheel', (event) => {
                queueMicrotask(() => samples.push({
                    ctrlKey: event.ctrlKey,
                    defaultPrevented: event.defaultPrevented,
                    metaKey: event.metaKey,
                }));
            });
            (window as IMacWheelE2EWindow).__macWheelModifierSamples = samples;
            const rect = viewport.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        });
        expect(point).not.toBeNull();
        if (!point) {
            return;
        }

        const toolbarBefore = await getWorkspaceToolbarSnapshot(session.page);
        await session.page.mouse.move(point.x, point.y);
        await session.page.keyboard.down('Control');
        for (let index = 0; index < 20; index += 1) {
            await session.page.mouse.wheel({deltaY: 240});
        }
        await session.page.keyboard.up('Control');
        await waitForFunctionInPage(session.page, () => {
            const surface = document.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
            return (surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')?.scrollTop ?? 0) > 20;
        }, {timeout: 5_000});
        const toolbarAfterControl = await getWorkspaceToolbarSnapshot(session.page);

        await session.page.keyboard.down('Meta');
        for (let index = 0; index < 12; index += 1) {
            await session.page.mouse.wheel({deltaY: 18});
        }
        await session.page.keyboard.up('Meta');
        await session.page.evaluate(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
        });
        const modifierSamplesAfterMeta = await session.page.evaluate(() => (
            (window as IMacWheelE2EWindow).__macWheelModifierSamples ?? []
        ));
        const toolbarAfterMetaInput = await getWorkspaceToolbarSnapshot(session.page);
        const modifierDetail = JSON.stringify({
            modifierSamplesAfterMeta,
            toolbarAfterControl,
            toolbarAfterMetaInput,
        });
        expect(modifierSamplesAfterMeta.some(sample => (
            sample.metaKey && sample.defaultPrevented
        )), modifierDetail).toBe(true);
        expect(toolbarAfterMetaInput?.effectiveZoom ?? Number.POSITIVE_INFINITY, modifierDetail).toBeLessThan(
            (toolbarAfterControl?.effectiveZoom ?? 0) - 0.005,
        );
        const result = await session.page.evaluate(() => {
            const surface = document.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
            return {
                samples: (window as IMacWheelE2EWindow).__macWheelModifierSamples ?? [],
                scrollTop: surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')?.scrollTop ?? 0,
            };
        });

        expect(toolbarAfterControl?.effectiveZoom).toBeCloseTo(toolbarBefore?.effectiveZoom ?? 0, 5);
        expect(result.scrollTop).toBeGreaterThan(20);
        expect(result.samples.some(sample => (
            sample.ctrlKey && !sample.metaKey && !sample.defaultPrevented
        )), JSON.stringify(result.samples)).toBe(true);
        expect(result.samples.some(sample => (
            sample.metaKey && sample.defaultPrevented
        )), modifierDetail).toBe(true);
    }, 120_000);

    it('searches deterministic late-page native DjVu text through the common sidebar with visible result geometry', async (context) => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-native-search-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const searchFixture = await createNativeDjvuLatePageSearchFixture();
        if (!searchFixture.path) {
            console.info(`SKIPPED (native tool unavailable): ${searchFixture.reason}`);
            context.skip();
            return;
        }

        const rendererErrors: string[] = [];
        const onConsole = (message: {
            type: () => string;
            text: () => string;
        }) => {
            if (message.type() !== 'error') {
                return;
            }
            const text = message.text();
            if (text.includes('[renderer-guard]') || text.includes('Unhandled window error')) {
                rendererErrors.push(text);
            }
        };
        const onPageError = (error: unknown) => {
            rendererErrors.push(`pageerror:${error instanceof Error ? error.message : String(error)}`);
        };
        session.page.on('console', onConsole);
        session.page.on('pageerror', onPageError);

        try {
            await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
            await openDjvuInApp(
                session.page,
                searchFixture.path,
                DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS,
            );
            await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
            await ensureSidebarOpen(session.page);

            const progressProbeInstalled = await session.page.evaluate(() => {
                const probeWindow = window as IDjvuNativeSearchProgressWindow;
                probeWindow.__djvuNativeSearchProgressProbe?.unsubscribe();
                const events: IDjvuNativeSearchProgressEvent[] = [];
                const unsubscribe = probeWindow.electronAPI?.djvu.onTextSearchProgress((progress) => {
                    events.push({
                        processed: progress.processed,
                        requestId: progress.requestId,
                        ...(progress.status ? {status: progress.status} : {}),
                        total: progress.total,
                    });
                });
                if (!unsubscribe) {
                    return false;
                }
                probeWindow.__djvuNativeSearchProgressProbe = {
                    events,
                    unsubscribe,
                };
                return true;
            });
            expect(progressProbeInstalled).toBe(true);

            await openDocumentSidebarTab(session.page, 'Search');

            await waitForFunctionInPage(session.page, () => {
                const input = document.querySelector<HTMLInputElement>(
                    '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-bar input',
                );
                const rect = input?.getBoundingClientRect();
                return Boolean(rect && rect.width > 20 && rect.height > 10);
            }, {timeout: 10_000});
            const searchInput = await session.page.$(
                '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-bar input',
            );
            expect(searchInput).not.toBeNull();
            await searchInput!.type(searchFixture.sentinel);
            const searchStarted = await session.page.evaluate(() => {
                const button = document.querySelector<HTMLButtonElement>(
                    '.editor-pane.is-active [data-testid="document-sidebar"] .search-run-button',
                );
                if (!button || button.disabled) {
                    return false;
                }
                button.click();
                return true;
            });
            expect(searchStarted).toBe(true);

            await waitForFunctionInPage(session.page, (
                args: {
                    pageNumber: number;
                    sentinel: string
                },
            ) => {
                const resultHighlights = Array.from(document.querySelectorAll<HTMLElement>(
                    '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result-highlight',
                ));
                const groupLabel = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-group-label',
                )?.textContent ?? '';
                const spinner = document.querySelector(
                    '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-results-spinner',
                );
                return !spinner
                    && groupLabel.includes(String(args.pageNumber))
                    && resultHighlights.length === 2
                    && resultHighlights.every(highlight => highlight.textContent?.trim() === args.sentinel);
            }, {timeout: 60_000}, {
                pageNumber: searchFixture.pageNumber,
                sentinel: searchFixture.sentinel,
            });

            const completedProgressEvents = await session.page.evaluate(() => (
                (window as IDjvuNativeSearchProgressWindow).__djvuNativeSearchProgressProbe?.events ?? []
            ));
            expect(completedProgressEvents.some(event => (
                event.status === 'running'
                && event.processed > 0
                && event.processed < searchFixture.pageCount
            )), JSON.stringify(completedProgressEvents)).toBe(true);
            expect(completedProgressEvents.at(-1), JSON.stringify(completedProgressEvents)).toMatchObject({
                processed: searchFixture.pageCount,
                status: 'success',
                total: searchFixture.pageCount,
            });

            await waitForToolbarCurrentPage(session.page, searchFixture.pageNumber, 30_000);
            await waitForFunctionInPage(session.page, (pageNumber: number) => {
                const page = document.querySelector<HTMLElement>(
                    `[data-testid="document-page-source-page"][data-page-number="${String(pageNumber)}"]`,
                );
                const highlights = page?.querySelectorAll<HTMLElement>(
                    '[data-testid="document-page-source-search-highlight"]',
                );
                return highlights?.length === 2
                    && Array.from(highlights).filter(highlight => (
                        highlight.dataset.searchHighlightCurrent === 'true'
                    )).length === 1;
            }, {timeout: 30_000}, searchFixture.pageNumber);

            await goToPageViaToolbar(session.page, 1);
            await waitForFunctionInPage(session.page, (pageNumber: number) => {
                const viewer = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active [data-document-viewer-chassis-viewport]',
                );
                const page = viewer?.querySelector<HTMLElement>(
                    `[data-testid="document-page-source-page"][data-page-number="${String(pageNumber)}"]`,
                );
                const image = page?.querySelector<HTMLImageElement>(
                    '[data-testid="document-page-source-image"]',
                );
                if (!viewer || !page || !image?.complete || image.naturalWidth <= 0) {
                    return false;
                }
                const viewerRect = viewer.getBoundingClientRect();
                const pageRect = page.getBoundingClientRect();
                return Math.min(viewerRect.bottom, pageRect.bottom)
                    - Math.max(viewerRect.top, pageRect.top) > 8;
            }, {timeout: 30_000}, 1);
            const clickedSecondResult = await session.page.evaluate(() => {
                const results = Array.from(document.querySelectorAll<HTMLElement>(
                    '.editor-pane.is-active [data-testid="document-sidebar"] .document-search-result',
                ));
                results[1]?.click();
                return results.length === 2;
            });
            expect(clickedSecondResult).toBe(true);
            await waitForToolbarCurrentPage(session.page, searchFixture.pageNumber, 30_000);

            await waitForFunctionInPage(session.page, (pageNumber: number) => {
                const page = document.querySelector<HTMLElement>(
                    `[data-testid="document-page-source-page"][data-page-number="${String(pageNumber)}"]`,
                );
                const highlights = Array.from(page?.querySelectorAll<HTMLElement>(
                    '[data-testid="document-page-source-search-highlight"]',
                ) ?? []);
                return highlights.length === 2
                    && highlights.some(highlight => (
                        highlight.dataset.searchResultIndex === '1'
                        && highlight.dataset.searchHighlightCurrent === 'true'
                    ));
            }, {timeout: 30_000}, searchFixture.pageNumber);

            const searchEvidence = await session.page.evaluate((pageNumber: number) => {
                const page = document.querySelector<HTMLElement>(
                    `[data-testid="document-page-source-page"][data-page-number="${String(pageNumber)}"]`,
                );
                const pageRect = page?.getBoundingClientRect() ?? null;
                const highlights = Array.from(page?.querySelectorAll<HTMLElement>(
                    '[data-testid="document-page-source-search-highlight"]',
                ) ?? []).map((highlight) => {
                    const rect = highlight.getBoundingClientRect();
                    return {
                        background: window.getComputedStyle(highlight).backgroundColor,
                        bottom: rect.bottom,
                        current: highlight.dataset.searchHighlightCurrent === 'true',
                        height: rect.height,
                        left: rect.left,
                        resultIndex: Number(highlight.dataset.searchResultIndex),
                        right: rect.right,
                        top: rect.top,
                        width: rect.width,
                    };
                });
                const progressEvents = (window as IDjvuNativeSearchProgressWindow)
                    .__djvuNativeSearchProgressProbe?.events ?? [];
                return {
                    highlights,
                    pageRect: pageRect ? {
                        bottom: pageRect.bottom,
                        left: pageRect.left,
                        right: pageRect.right,
                        top: pageRect.top,
                    } : null,
                    progressEvents,
                    runtimeErrorText: document.querySelector<HTMLElement>(
                        '.runtime-error-reports',
                    )?.textContent?.trim() ?? '',
                    workspaceErrorText: document.querySelector<HTMLElement>(
                        '.editor-pane.is-active [data-testid="workspace-document-djvu-error"]',
                    )?.textContent?.trim() ?? '',
                };
            }, searchFixture.pageNumber);

            expect(searchEvidence.highlights).toHaveLength(2);
            expect(searchEvidence.highlights.filter(highlight => highlight.current)).toHaveLength(1);
            expect(searchEvidence.highlights.find(highlight => highlight.current)?.resultIndex).toBe(1);
            expect(searchEvidence.pageRect).not.toBeNull();
            for (const highlight of searchEvidence.highlights) {
                expect(highlight.width).toBeGreaterThan(2);
                expect(highlight.height).toBeGreaterThan(2);
                expect(highlight.background).not.toBe('rgba(0, 0, 0, 0)');
                expect(highlight.left).toBeGreaterThanOrEqual(searchEvidence.pageRect!.left);
                expect(highlight.right).toBeLessThanOrEqual(searchEvidence.pageRect!.right);
                expect(highlight.top).toBeGreaterThanOrEqual(searchEvidence.pageRect!.top);
                expect(highlight.bottom).toBeLessThanOrEqual(searchEvidence.pageRect!.bottom);
            }
            expect(searchEvidence.workspaceErrorText).toBe('');
            expect(searchEvidence.runtimeErrorText).toBe('');
            expect(rendererErrors).toEqual([]);
        } finally {
            session.page.off('console', onConsole);
            session.page.off('pageerror', onPageError);
            await session.page.evaluate(() => {
                const probeWindow = window as IDjvuNativeSearchProgressWindow;
                probeWindow.__djvuNativeSearchProgressProbe?.unsubscribe();
                delete probeWindow.__djvuNativeSearchProgressProbe;
            }).catch(() => undefined);
        }
    }, 120_000);

    it('keeps the live DjVu viewport intact while the common sidebar and virtual thumbnail rail settle', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-sidebar-lifecycle-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        const initialToolbar = await getWorkspaceToolbarSnapshot(session.page);
        expect(initialToolbar?.currentPage ?? 0).toBeGreaterThan(0);

        const sidebarWasVisible = await session.page.evaluate(() => {
            const sidebar = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"]',
            );
            const rect = sidebar?.getBoundingClientRect();
            return Boolean(rect && rect.width > 10 && rect.height > 10);
        });
        if (sidebarWasVisible) {
            await clickVisibleToolbarButton(session.page, 'Toggle Sidebar');
            await waitForFunctionInPage(session.page, () => {
                const sidebar = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active [data-testid="document-sidebar"]',
                );
                const rect = sidebar?.getBoundingClientRect();
                return !rect || rect.width <= 10 || rect.height <= 10;
            }, {timeout: 10_000});
        }

        const probeInstalled = await session.page.evaluate(() => {
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const surface = host?.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
            const viewport = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
            if (!host || !viewport) {
                return false;
            }
            const probe: IDjvuSidebarLifecycleProbe = {
                active: true,
                frames: [],
            };
            const sample = () => {
                if (!probe.active) {
                    return;
                }
                const viewportRect = viewport.getBoundingClientRect();
                const visiblePages = Array.from(viewport.querySelectorAll<HTMLElement>(
                    '[data-testid="document-page-source-page"]',
                )).filter((page) => {
                    const rect = page.getBoundingClientRect();
                    return Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top) > 8;
                });
                const readyVisiblePageCount = visiblePages.filter((page) => {
                    const image = page.querySelector<HTMLImageElement>(
                        ':scope > [data-testid="document-page-source-image"]',
                    );
                    return Boolean(
                        image?.complete
                        && image.naturalWidth > 0
                        && image.naturalHeight > 0,
                    );
                }).length;
                const banner = host.querySelector<HTMLElement>('.djvu-banner');
                const error = host.querySelector<HTMLElement>('[data-testid="workspace-document-djvu-error"]');
                const runtimeError = document.querySelector<HTMLElement>('.runtime-error-reports');
                const currentPage = visiblePages.find((page) => {
                    const rect = page.getBoundingClientRect();
                    const viewportCenter = viewportRect.top + viewportRect.height / 2;
                    return rect.top <= viewportCenter && rect.bottom >= viewportCenter;
                }) ?? visiblePages[0] ?? null;
                probe.frames.push({
                    busy: Boolean(
                        host.querySelector('.workspace-host__loading')
                        || banner?.getAttribute('aria-busy') === 'true'
                        || banner?.textContent?.includes('Opening DjVu'),
                    ),
                    currentPage: currentPage
                        ? Number.parseInt(currentPage.dataset.pageNumber ?? '', 10) || null
                        : null,
                    errorText: error?.textContent?.trim() ?? '',
                    readyVisiblePageCount,
                    runtimeErrorText: runtimeError?.textContent?.trim() ?? '',
                    visiblePageCount: visiblePages.length,
                });
                window.requestAnimationFrame(sample);
            };
            (window as IDjvuSidebarLifecycleWindow).__djvuSidebarLifecycleProbe = probe;
            window.requestAnimationFrame(sample);
            return true;
        });
        expect(probeInstalled).toBe(true);

        await clickVisibleToolbarButton(session.page, 'Toggle Sidebar');
        await waitForFunctionInPage(session.page, () => {
            const sidebar = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"]',
            );
            const rect = sidebar?.getBoundingClientRect();
            return Boolean(rect && rect.width > 10 && rect.height > 10);
        }, {timeout: 10_000});

        const sidebarResize = await dragDocumentSidebarDividerBy(session, 120);
        const resizeDetail = JSON.stringify(sidebarResize);
        expect(sidebarResize.before.configuredSashWidth, resizeDetail).toBeGreaterThanOrEqual(5);
        expect(
            Math.abs(
                sidebarResize.before.sashWidth
                - sidebarResize.before.configuredSashWidth,
            ),
            resizeDetail,
        ).toBeLessThanOrEqual(1);
        expect(sidebarResize.before.sashBackground, resizeDetail).not.toBe('rgba(0, 0, 0, 0)');
        expect(sidebarResize.before.sashBackground, resizeDetail).not.toBe('rgb(255, 255, 255)');
        expect(
            Math.abs(sidebarResize.before.wrapperRight - sidebarResize.before.sashRight),
            resizeDetail,
        ).toBeLessThanOrEqual(1);
        expect(
            Math.abs(sidebarResize.before.viewerLeft - sidebarResize.before.sashRight),
            resizeDetail,
        ).toBeLessThanOrEqual(1);
        expect(sidebarResize.after.sidebarWidth, resizeDetail)
            .toBeGreaterThan(sidebarResize.before.sidebarWidth + 80);
        await session.page.evaluate(async () => {
            await new Promise(resolve => setTimeout(resolve, 600));
        });
        const lifecycleFrames = await session.page.evaluate(() => {
            const probe = (window as IDjvuSidebarLifecycleWindow).__djvuSidebarLifecycleProbe;
            if (!probe) {
                return [];
            }
            probe.active = false;
            return probe.frames;
        });
        const lifecycleDetail = JSON.stringify(lifecycleFrames);
        expect(lifecycleFrames.length, lifecycleDetail).toBeGreaterThan(10);
        expect(lifecycleFrames.every(frame => !frame.busy), lifecycleDetail).toBe(true);
        expect(lifecycleFrames.every(frame => frame.visiblePageCount > 0), lifecycleDetail).toBe(true);
        expect(lifecycleFrames.every(frame => frame.readyVisiblePageCount > 0), lifecycleDetail).toBe(true);
        expect(lifecycleFrames.every(frame => frame.errorText === ''), lifecycleDetail).toBe(true);
        expect(lifecycleFrames.every(frame => frame.runtimeErrorText === ''), lifecycleDetail).toBe(true);
        expect(lifecycleFrames.every(frame => frame.currentPage !== null), lifecycleDetail).toBe(true);

        const tabNames = await session.page.evaluate(() => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] [role="tab"]',
            )).map(tab => tab.textContent?.trim() ?? '')
        ));
        expect(tabNames).toEqual([
            'Pages',
            'Bookmarks',
            'Search',
        ]);
        await waitForFunctionInPage(session.page, () => {
            const activeTab = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] [role="tab"][aria-selected="true"]',
            );
            const rail = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-thumbnail-list"]',
            );
            return Boolean(
                activeTab?.textContent?.trim() === 'Pages'
                &&
                rail
                && rail.getBoundingClientRect().height > 100
                && rail.querySelectorAll('[data-thumbnail-page]').length > 0,
            );
        }, {timeout: 20_000});

        const currentPage = initialToolbar?.currentPage ?? 1;
        await waitForFunctionInPage(session.page, (pageNumber: number) => Boolean(
            document.querySelector(
                `.editor-pane.is-active [data-testid="document-page-source-page"][data-page-number="${String(pageNumber)}"]`,
            )
            && document.querySelector(
                `.editor-pane.is-active [data-testid="document-thumbnail-list"] [data-thumbnail-page="${String(pageNumber)}"] [data-document-thumbnail-frame]`,
            ),
        ), {timeout: 20_000}, currentPage);
        const djvuPageGeometry = await readBalancedScrollRegionGeometry(
            session,
            '.editor-pane.is-active [data-document-viewer-chassis-viewport]',
            `.editor-pane.is-active [data-testid="document-page-source-page"][data-page-number="${String(currentPage)}"]`,
        );
        expectBalancedScrollRegion(djvuPageGeometry, JSON.stringify({djvuPageGeometry}));
        const djvuThumbnailGeometry = await readBalancedScrollRegionGeometry(
            session,
            '.editor-pane.is-active [data-testid="document-thumbnail-list"]',
            `.editor-pane.is-active [data-testid="document-thumbnail-list"] [data-thumbnail-page="${String(currentPage)}"] [data-document-thumbnail-frame]`,
        );
        expectBalancedScrollRegion(djvuThumbnailGeometry, JSON.stringify({djvuThumbnailGeometry}));
        const sourceSidebarOwnership = await session.page.evaluate(() => {
            const shellContent = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-sidebar"] .app-sidebar-shell__content',
            );
            if (!shellContent) {
                throw new Error('Source sidebar shell content was not found');
            }
            const style = getComputedStyle(shellContent);
            return {
                gutter: style.scrollbarGutter,
                overflowY: style.overflowY,
            };
        });
        expect(sourceSidebarOwnership).toEqual({
            gutter: 'auto',
            overflowY: 'hidden',
        });

        const thumbnailProbe = await session.page.evaluate(async () => {
            interface IAspectRecord {
                placeholderRatio?: number;
                placeholderSeen?: boolean;
                renderedRatio?: number;
            }
            const rail = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="document-thumbnail-list"]',
            );
            if (!rail) {
                throw new Error('DjVu thumbnail rail was not found');
            }
            const aspects = new Map<number, IAspectRecord>();
            let active = true;
            let maxDomCount = 0;
            const sample = () => {
                if (!active) {
                    return;
                }
                const items = Array.from(rail.querySelectorAll<HTMLElement>('[data-thumbnail-page]'));
                maxDomCount = Math.max(maxDomCount, items.length);
                for (const item of items) {
                    const pageNumber = Number(item.dataset.thumbnailPage);
                    const frame = item.querySelector<HTMLElement>('[data-document-thumbnail-frame]');
                    const frameRect = frame?.getBoundingClientRect();
                    if (!frameRect || frameRect.width <= 0 || frameRect.height <= 0) {
                        continue;
                    }
                    const record = aspects.get(pageNumber) ?? {};
                    // The frame owns placeholder geometry before paint and
                    // must keep that exact aspect after its renderer arrives.
                    record.placeholderRatio = frameRect.width / frameRect.height;
                    record.placeholderSeen ||= Boolean(
                        item.querySelector('.document-thumbnail-list__placeholder'),
                    );
                    const image = item.querySelector<HTMLImageElement>('img');
                    const canvas = item.querySelector<HTMLCanvasElement>('canvas');
                    if (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
                        record.renderedRatio = image.naturalWidth / image.naturalHeight;
                    } else if (canvas && canvas.width > 0 && canvas.height > 0) {
                        record.renderedRatio = canvas.width / canvas.height;
                    }
                    aspects.set(pageNumber, record);
                }
                window.requestAnimationFrame(sample);
            };
            window.requestAnimationFrame(sample);
            for (let step = 1; step <= 28; step += 1) {
                const maxScrollTop = Math.max(0, rail.scrollHeight - rail.clientHeight);
                rail.scrollTop = maxScrollTop * step / 28;
                rail.dispatchEvent(new Event('scroll'));
                await new Promise(resolve => setTimeout(resolve, 12));
            }
            const deadline = performance.now() + 20_000;
            while (performance.now() < deadline) {
                const matchedCount = [...aspects.values()].filter(record => (
                    record.placeholderRatio !== undefined
                    && record.renderedRatio !== undefined
                )).length;
                if (matchedCount >= 3) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            active = false;
            const items = Array.from(rail.querySelectorAll<HTMLElement>('[data-thumbnail-page]'));
            const renderedCount = items.filter(item => {
                const image = item.querySelector<HTMLImageElement>('img');
                const canvas = item.querySelector<HTMLCanvasElement>('canvas');
                return Boolean(
                    (image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0)
                    || (canvas && canvas.width > 0 && canvas.height > 0),
                );
            }).length;
            return {
                finalDomCount: items.length,
                maxDomCount,
                maxPageNumberSeen: Math.max(0, ...aspects.keys()),
                maxScrollTop: Math.max(0, rail.scrollHeight - rail.clientHeight),
                matchedAspects: [...aspects.entries()].flatMap(([
                    pageNumber,
                    record,
                ]) => (
                    record.placeholderRatio !== undefined && record.renderedRatio !== undefined
                        ? [{
                            pageNumber,
                            placeholderRatio: record.placeholderRatio,
                            renderedRatio: record.renderedRatio,
                        }]
                        : []
                )),
                placeholderPagesSeen: [...aspects.values()].filter(record => (
                    record.placeholderSeen
                )).length,
                renderedCount,
                scrollTop: rail.scrollTop,
            };
        });
        const toolbar = await getWorkspaceToolbarSnapshot(session.page);
        const thumbnailDetail = JSON.stringify({
            thumbnailProbe,
            totalPages: toolbar?.totalPages,
        });
        expect(toolbar?.currentPage, thumbnailDetail).toBe(initialToolbar?.currentPage);
        expect(thumbnailProbe.maxPageNumberSeen, thumbnailDetail).toBeGreaterThan(50);
        expect(thumbnailProbe.maxScrollTop, thumbnailDetail).toBeGreaterThan(1_000);
        expect(thumbnailProbe.scrollTop, thumbnailDetail).toBeGreaterThan(1_000);
        expect(thumbnailProbe.maxDomCount, thumbnailDetail).toBeLessThanOrEqual(24);
        expect(thumbnailProbe.maxDomCount, thumbnailDetail).toBeLessThan(thumbnailProbe.maxPageNumberSeen);
        expect(thumbnailProbe.finalDomCount, thumbnailDetail).toBeLessThanOrEqual(24);
        expect(thumbnailProbe.renderedCount, thumbnailDetail).toBeGreaterThan(0);
        expect(thumbnailProbe.placeholderPagesSeen, thumbnailDetail).toBeGreaterThan(0);
        expect(thumbnailProbe.matchedAspects.length, thumbnailDetail).toBeGreaterThanOrEqual(3);
        expect(thumbnailProbe.matchedAspects.every(sample => (
            Math.abs(sample.placeholderRatio - sample.renderedRatio) <= 0.03
        )), thumbnailDetail).toBe(true);

        const errorSurface = await session.page.evaluate(() => ({
            runtimeError: document.querySelector<HTMLElement>('.runtime-error-reports')?.textContent?.trim() ?? '',
            workspaceError: document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-testid="workspace-document-djvu-error"]',
            )?.textContent?.trim() ?? '',
        }));
        expect(errorSurface.workspaceError).toBe('');
        expect(errorSurface.runtimeError).toBe('');
        expect(`${errorSurface.workspaceError} ${errorSurface.runtimeError}`).not.toMatch(/cancell?ed/iu);
    }, 150_000);

    it('preserves the DjVu viewport anchor and ready surface through separate split-divider drags', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-split-resize-${Date.now()}`,
        });
        if (!session) {
            return;
        }
        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        const fitWidth = await callWorkspaceCommand(session.page, 'handleFitWidth');
        expect(fitWidth.called).toBe(true);
        const navigation = await callWorkspaceCommand(session.page, 'handleGoToPage', [18]);
        expect(navigation.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(session.page, {currentPage: 18}, {timeoutMs: 20_000});
        await nudgeActiveDocumentViewportWithWheel(session, 'djvu', 160);

        const sourcePaneId = await session.page.evaluate(() => (
            document.querySelector<HTMLElement>('.editor-pane.is-active')?.dataset.editorPaneId ?? null
        ));
        expect(sourcePaneId).not.toBeNull();
        const userAnchor = await readSplitResizeViewportAnchor(session, sourcePaneId!, 'djvu');
        expect(userAnchor.busy).toBe(false);
        expect(userAnchor.scrollTop).toBeGreaterThan(0);
        expect(userAnchor.pageHeight).toBeGreaterThan(100);
        expect(userAnchor.readyVisiblePageCount).toBeGreaterThan(0);

        const retainedPaneId = await splitActivePaneWithEmptyEditor(session);
        expect(retainedPaneId).toBe(sourcePaneId);
        const afterSplit = await waitForSplitResizeViewportAnchor(
            session,
            retainedPaneId,
            'djvu',
            userAnchor,
        );
        expectSplitResizeAnchorPreserved(afterSplit, userAnchor);
        expect(afterSplit.busy).toBe(false);

        const probeInstalled = await installDjvuSplitResizeContinuityProbe(session, retainedPaneId);
        expect(probeInstalled).toBe(true);

        await dragEditorDividerToRatio(session, 0.32);
        const afterNarrowDrag = await waitForSplitResizeViewportAnchor(
            session,
            retainedPaneId,
            'djvu',
            userAnchor,
        );
        expectSplitResizeAnchorPreserved(afterNarrowDrag, userAnchor);
        expect(afterNarrowDrag.paneWidth).toBeLessThan(afterSplit.paneWidth - 100);

        await dragEditorDividerToRatio(session, 0.68);
        const afterWideDrag = await waitForSplitResizeViewportAnchor(
            session,
            retainedPaneId,
            'djvu',
            userAnchor,
        );
        expectSplitResizeAnchorPreserved(afterWideDrag, userAnchor);
        expect(afterWideDrag.paneWidth).toBeGreaterThan(afterNarrowDrag.paneWidth + 250);

        const continuityFrames = await stopDjvuSplitResizeContinuityProbe(session);
        const continuityDetail = JSON.stringify(continuityFrames);
        expect(continuityFrames.length, continuityDetail).toBeGreaterThan(20);
        expect(continuityFrames.every(frame => !frame.busy), continuityDetail).toBe(true);
        expect(
            continuityFrames.every(frame => frame.visiblePageCount > 0),
            continuityDetail,
        ).toBe(true);
        expect(
            continuityFrames.every(frame => frame.readyVisiblePageCount > 0),
            continuityDetail,
        ).toBe(true);
    }, 120_000);

    it('keeps DjVu continuous wheel scroll geometry stable on the exact fixture', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-continuous-scroll-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForFunctionInPage(session.page, () => {
            const banner = document.querySelector<HTMLElement>('.editor-pane.is-active .djvu-banner');
            const openingText = banner?.textContent?.includes('Opening DjVu') ?? false;
            return !openingText && banner?.getAttribute('aria-busy') !== 'true';
        }, {timeout: 10_000});
        await configureDjvuWheelMetricStart(session);

        const samples = await collectDjvuWheelMetricSamples(session);
        const summary = summarizeDjvuWheelMetrics(samples);
        const summaryDetail = JSON.stringify(summary);

        expect(summary.sampleCount, summaryDetail).toBeGreaterThan(40);
        expect(samples[0]?.currentPage ?? 0, summaryDetail).toBeGreaterThanOrEqual(DJVU_VIDEO_START_PAGE - 1);
        expect(summary.finalPage ?? 0, summaryDetail).toBeGreaterThanOrEqual(30);
        expect(samples.at(-1)?.observedPage, summaryDetail).toBe(samples.at(-1)?.currentPage);
        expect(samples.every(sample => sample.requestedPage === samples[0]?.committedPage), summaryDetail).toBe(true);
        expect(samples.every(sample => sample.committedPage === samples[0]?.committedPage), summaryDetail).toBe(true);
        expect(samples.at(-1)!.scrollTop, summaryDetail).toBeGreaterThan(samples[0]!.scrollTop);
        expect(summary.monotonicScrollViolations, summaryDetail).toBe(0);
        expect(summary.virtualSpacerCount, summaryDetail).toBe(0);
        expect(summary.virtualSpacerHeight, summaryDetail).toBe(0);
        expect(summary.maxScrollHeightDelta, summaryDetail).toBeLessThanOrEqual(2);
        expect(summary.maxSurfaceHeightDelta, summaryDetail).toBeLessThanOrEqual(2);
        // The source viewer keeps a 12-page radius plus a short overlap while
        // the preceding viewport commit retires. Keep the cap tight enough to
        // catch an unbounded render window while allowing that transition.
        expect(summary.maxMountedPages, summaryDetail).toBeLessThanOrEqual(40);
        expect(summary.rangeTransitions, summaryDetail).toBeGreaterThan(3);
        expect(summary.maxVisibleGapPx, summaryDetail).toBeLessThanOrEqual(240);
        expect(summary.maxVisibleUnloadedFraction, summaryDetail).toBeLessThanOrEqual(0.85);
        for (const sample of samples) {
            expect(sample.visibleShellCount, summaryDetail).toBeGreaterThan(0);
            expect(sample.visibleImageCount, summaryDetail).toBeGreaterThan(0);
            expect(sample.pageNumbers).toEqual([...sample.pageNumbers].sort((left, right) => left - right));
            // Mounted pages are the union of current and outgoing destination
            // windows and need not be contiguous. Visible continuity is
            // asserted directly through gap and loaded-image metrics above.
        }
    }, 120_000);

    it('keeps paged fit-height DjVu wheel navigation committed through slow and rapid bursts', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-paged-fit-height-scroll-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        expect((await callWorkspaceCommand(session.page, 'handleFitHeight')).called).toBe(true);
        const initialToolbar = await getWorkspaceToolbarSnapshot(session.page);
        if (initialToolbar?.continuousScroll) {
            expect((await callWorkspaceCommand(session.page, 'handleToggleContinuousScroll')).called).toBe(true);
        }
        expect((await callWorkspaceCommand(session.page, 'handleGoToPage', [1])).called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                continuousScroll: false,
                currentPage: 1,
            },
            {timeoutMs: 20_000},
        );

        const viewportPoint = await session.page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-document-viewer-chassis-viewport]',
            );
            const rect = viewport?.getBoundingClientRect();
            return rect ? {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            } : null;
        });
        expect(viewportPoint).not.toBeNull();
        if (!viewportPoint) {
            return;
        }
        const waitForReadyCurrentPage = async (minimumPage: number) => {
            await waitForFunctionInPage(session.page, (minPage: number) => {
                const toolbar = (window as typeof window & IDjvuWheelMetricWindow)
                    .__evbTestApi?.getActiveToolbarSnapshot?.();
                const pageNumber = toolbar?.currentPage ?? 0;
                const page = document.querySelector<HTMLElement>(
                    `.editor-pane.is-active [data-testid="document-page-source-page"][data-page-number="${String(pageNumber)}"]`,
                );
                const chassis = page?.closest<HTMLElement>('.document-viewer-chassis') ?? null;
                const image = page?.querySelector<HTMLImageElement>(
                    ':scope > [data-testid="document-page-source-image"]',
                );
                return pageNumber >= minPage
                    && page?.dataset.pageSourceVisual === 'fresh'
                    && image?.complete
                    && image.naturalWidth > 0
                    && image.naturalHeight > 0
                    && chassis?.dataset.viewportLifecycle === 'ready'
                    && chassis.dataset.viewportRequestedPage === String(pageNumber)
                    && chassis.dataset.viewportCommittedPage === String(pageNumber)
                    && chassis.dataset.viewportVisualPage === String(pageNumber)
                    && chassis.dataset.viewportVisualPresentation === 'canvas';
            }, {timeout: 30_000}, minimumPage);
            return (await getWorkspaceToolbarSnapshot(session.page))?.currentPage ?? 0;
        };

        await session.page.mouse.move(viewportPoint.x, viewportPoint.y);
        const collectPagedState = () => session.page.evaluate(() => {
            const toolbar = (window as typeof window & IDjvuWheelMetricWindow)
                .__evbTestApi?.getActiveToolbarSnapshot?.();
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-document-viewer-chassis-viewport]',
            );
            const chassis = viewport?.closest<HTMLElement>('.document-viewer-chassis') ?? null;
            const pages = Array.from(viewport?.querySelectorAll<HTMLElement>(
                '[data-testid="document-page-source-page"]',
            ) ?? []);
            return {
                clientHeight: viewport?.clientHeight ?? 0,
                currentPage: toolbar?.currentPage ?? 0,
                openSurfaceGeneration: chassis?.dataset.openSurfaceGeneration,
                openSurfacePhase: viewport?.dataset.openSurfacePhase,
                pages: pages.map(page => ({
                    display: getComputedStyle(page).display,
                    height: Math.round(page.getBoundingClientRect().height),
                    imageReady: (() => {
                        const image = page.querySelector<HTMLImageElement>(
                            ':scope > [data-testid="document-page-source-image"]',
                        );
                        return Boolean(
                            image?.complete
                            && image.naturalWidth > 0
                            && image.naturalHeight > 0,
                        );
                    })(),
                    pageNumber: Number(page.dataset.pageNumber),
                    visual: page.dataset.pageSourceVisual,
                })),
                scrollHeight: viewport?.scrollHeight ?? 0,
                scrollTop: viewport?.scrollTop ?? 0,
                viewportCommittedPage: chassis?.dataset.viewportCommittedPage,
                viewportLifecycle: chassis?.dataset.viewportLifecycle,
                viewportRequestedPage: chassis?.dataset.viewportRequestedPage,
                viewportStagedRenderPage: chassis?.dataset.viewportStagedRenderPage || null,
                viewportStagedViewportPage: chassis?.dataset.viewportStagedViewportPage || null,
                viewportVisualPage: chassis?.dataset.viewportVisualPage,
                viewportVisualPresentation: chassis?.dataset.viewportVisualPresentation,
            };
        });
        const slowSamples: Array<Awaited<ReturnType<typeof collectPagedState>>> = [];
        for (let packet = 0; packet < 8; packet += 1) {
            await session.page.mouse.wheel({deltaY: 180});
            await new Promise(resolve => setTimeout(resolve, 220));
            slowSamples.push(await collectPagedState());
        }
        const slowState = slowSamples.at(-1)!;
        const slowDetail = JSON.stringify(slowState);
        for (const [
            index,
            sample,
        ] of slowSamples.entries()) {
            const detail = JSON.stringify(sample);
            const previousPage = index === 0 ? 1 : slowSamples[index - 1]!.currentPage;
            expect(sample.currentPage, detail).toBeGreaterThanOrEqual(previousPage);
            expect(sample.currentPage, detail).toBeLessThanOrEqual(previousPage + 1);
            expect(sample.pages.find(page => page.pageNumber === sample.currentPage), detail).toMatchObject({
                display: 'block',
                imageReady: true,
                visual: 'fresh',
            });
            expect(sample.viewportLifecycle, detail).toBe('ready');
            expect(sample.viewportRequestedPage, detail).toBe(String(sample.currentPage));
            expect(sample.viewportCommittedPage, detail).toBe(String(sample.currentPage));
            expect(sample.viewportVisualPage, detail).toBe(String(sample.currentPage));
            expect(sample.viewportVisualPresentation, detail).toBe('canvas');
            expect(sample.viewportStagedRenderPage, detail).toBeNull();
            expect(sample.viewportStagedViewportPage, detail).toBeNull();
        }
        expect(slowState.currentPage, slowDetail).toBeGreaterThanOrEqual(5);
        expect(slowState.pages.find(page => page.pageNumber === slowState.currentPage), slowDetail).toMatchObject({
            display: 'block',
            imageReady: true,
            visual: 'fresh',
        });
        const slowPage = await waitForReadyCurrentPage(5);
        for (let packet = 0; packet < 24; packet += 1) {
            await session.page.mouse.wheel({deltaY: 180});
            await new Promise(resolve => setTimeout(resolve, 40));
        }
        const fastPage = await waitForReadyCurrentPage(slowPage + 1);
        expect(fastPage).toBeGreaterThan(slowPage);

        expect((await callWorkspaceCommand(session.page, 'handleGoToPage', [1])).called).toBe(true);
        expect(await waitForReadyCurrentPage(1)).toBe(1);
    }, 120_000);

    it('keeps the DjVu render window ahead of monotonic projected trackpad scrolling', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-projected-scroll-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await configureDjvuWheelMetricStart(session, DJVU_PROJECTED_SCROLL_START_PAGE);

        const samples = await collectDjvuProjectedScrollMetricSamples(session);
        const stableSamples = samples.slice(DJVU_PROJECTED_SCROLL_WARMUP_SAMPLES);
        const summary = summarizeDjvuWheelMetrics(stableSamples);
        const summaryDetail = JSON.stringify(summary);

        expect(summary.sampleCount, summaryDetail).toBeGreaterThan(600);
        expect(samples[0]?.currentPage ?? 0, summaryDetail).toBeGreaterThanOrEqual(DJVU_PROJECTED_SCROLL_START_PAGE - 1);
        expect(summary.maxVisiblePage, summaryDetail).toBeGreaterThanOrEqual(35);
        expect(samples.at(-1)!.scrollTop, summaryDetail).toBeGreaterThan(samples[0]!.scrollTop + 15_000);
        expect(summary.monotonicScrollViolations, summaryDetail).toBe(0);
        expect(summary.virtualSpacerCount, summaryDetail).toBe(0);
        expect(summary.virtualSpacerHeight, summaryDetail).toBe(0);
        expect(summary.maxScrollHeightDelta, summaryDetail).toBeLessThanOrEqual(2);
        expect(summary.maxSurfaceHeightDelta, summaryDetail).toBeLessThanOrEqual(2);
        expect(summary.maxMountedPages, summaryDetail).toBeLessThanOrEqual(40);
        expect(summary.rangeTransitions, summaryDetail).toBeGreaterThan(3);
        expect(summary.visibleImageZeroFrames, summaryDetail).toBe(0);
        expect(summary.minVisibleImageCount, summaryDetail).toBeGreaterThan(0);
        expect(summary.maxVisibleGapPx, summaryDetail).toBeLessThanOrEqual(240);
        expect(summary.maxVisibleUnloadedFraction, summaryDetail).toBeLessThanOrEqual(0.35);
    }, 180_000);

    it('keeps high-zoom visible pages resident under pressure with PDF-equivalent page framing', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-djvu-high-zoom-residency-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);

        const zoomResult = await callWorkspaceCommand(
            session.page,
            'setCustomZoomFromDisplay',
            [DJVU_HIGH_ZOOM_REGRESSION_ZOOM],
        );
        expect(zoomResult.called).toBe(true);
        const toolbar = await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                minEffectiveZoom: DJVU_HIGH_ZOOM_REGRESSION_ZOOM - 0.005,
                minTotalPages: 11,
            },
            {timeoutMs: 20_000},
        );
        const totalPages = toolbar.totalPages;
        expect(totalPages).toBeGreaterThan(10);
        const targetPage = Math.max(2, totalPages - 8);
        const navigation = await callWorkspaceCommand(session.page, 'handleGoToPage', [targetPage]);
        expect(navigation.called).toBe(true);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {currentPage: targetPage},
            {timeoutMs: 30_000},
        );
        await waitForFunctionInPage(session.page, () => {
            const surface = document.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
            const viewer = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
            if (!viewer) {
                return false;
            }
            const viewerRect = viewer.getBoundingClientRect();
            const visiblePages = Array.from(viewer.querySelectorAll<HTMLElement>(
                '[data-testid="document-page-source-page"]',
            )).filter((page) => {
                const rect = page.getBoundingClientRect();
                return Math.min(rect.bottom, viewerRect.bottom) - Math.max(rect.top, viewerRect.top) > 8;
            });
            return visiblePages.length > 0 && visiblePages.every((page) => {
                const image = page.querySelector<HTMLImageElement>(
                    ':scope > [data-testid="document-page-source-image"]',
                );
                return page.dataset.pageSourceVisual === 'fresh'
                    && image?.complete
                    && (image.naturalWidth ?? 0) > 0
                    && (image.naturalHeight ?? 0) > 0;
            });
        }, {timeout: 35_000});

        const result = await session.page.evaluate(async (pressureDurationMs: number) => {
            type TPressureWindow = Window & {
                __getWorkspaceSurfaceBudgetForE2E?: () => {
                    effectiveMaxBytes: number;
                    leaseCount: number;
                    pressureLevel: string;
                    reservedBytes: number;
                    reservedBytesByCategory: Record<string, number>;
                };
                __setWorkspaceSurfacePressureForE2E?: (level: 'healthy' | 'critical') => void;
            };
            interface IContinuityFrame {
                imageCount: number;
                timeMs: number;
                visiblePages: Array<{
                    imageReady: boolean;
                    imageSource: string;
                    pageNumber: number;
                    visual: string;
                }>;
            }
            const probeWindow = window as TPressureWindow;
            if (!probeWindow.__setWorkspaceSurfacePressureForE2E) {
                throw new Error('Workspace surface pressure E2E hook is unavailable');
            }
            const surface = document.querySelector<HTMLElement>('[data-testid="document-page-source-viewer"]');
            const viewer = surface?.closest<HTMLElement>('[data-document-viewer-chassis-viewport]');
            if (!surface || !viewer) {
                throw new Error('DjVu viewer container was not found');
            }

            const shells = Array.from(viewer.querySelectorAll<HTMLElement>(
                '[data-testid="document-page-source-page"]',
            )).sort((left, right) => (
                Number(left.dataset.pageNumber) - Number(right.dataset.pageNumber)
            ));
            let adjacentGapPx: number | null = null;
            for (let index = 1; index < shells.length; index += 1) {
                if (Number(shells[index]!.dataset.pageNumber) !== Number(shells[index - 1]!.dataset.pageNumber) + 1) {
                    continue;
                }
                adjacentGapPx = Math.round(
                    shells[index]!.getBoundingClientRect().top
                    - shells[index - 1]!.getBoundingClientRect().bottom,
                );
                break;
            }
            const pageStyle = shells[0] ? window.getComputedStyle(shells[0]) : null;
            const expectedBackgroundProbe = document.createElement('div');
            expectedBackgroundProbe.style.background = 'var(--app-pdf-viewer-bg)';
            document.body.append(expectedBackgroundProbe);
            const expectedViewportBackground = window.getComputedStyle(expectedBackgroundProbe).backgroundColor;
            expectedBackgroundProbe.remove();
            const layout = {
                adjacentGapPx,
                pageBackground: pageStyle?.backgroundColor ?? '',
                pageBorderRadius: pageStyle?.borderRadius ?? '',
                pageShadow: pageStyle?.boxShadow ?? '',
                viewportBackground: window.getComputedStyle(viewer).backgroundColor,
                expectedViewportBackground,
            };

            const frames: IContinuityFrame[] = [];
            let active = true;
            const sample = () => {
                if (!active) {
                    return;
                }
                const viewerRect = viewer.getBoundingClientRect();
                const visiblePages = Array.from(viewer.querySelectorAll<HTMLElement>(
                    '[data-testid="document-page-source-page"]',
                )).flatMap((page) => {
                    const rect = page.getBoundingClientRect();
                    if (Math.min(rect.bottom, viewerRect.bottom) - Math.max(rect.top, viewerRect.top) <= 8) {
                        return [];
                    }
                    const image = page.querySelector<HTMLImageElement>(
                        ':scope > [data-testid="document-page-source-image"]',
                    );
                    return [{
                        imageReady: Boolean(
                            image?.complete
                            && (image.naturalWidth ?? 0) > 0
                            && (image.naturalHeight ?? 0) > 0,
                        ),
                        imageSource: image?.currentSrc || image?.src || '',
                        pageNumber: Number(page.dataset.pageNumber),
                        visual: page.dataset.pageSourceVisual ?? '',
                    }];
                });
                frames.push({
                    imageCount: viewer.querySelectorAll('[data-testid="document-page-source-image"]').length,
                    timeMs: Math.round(performance.now()),
                    visiblePages,
                });
                window.requestAnimationFrame(sample);
            };

            const applyPressure = () => probeWindow.__setWorkspaceSurfacePressureForE2E?.('critical');
            window.requestAnimationFrame(sample);
            applyPressure();
            const pressureTimer = window.setInterval(applyPressure, 150);
            await new Promise(resolve => setTimeout(resolve, pressureDurationMs));
            window.clearInterval(pressureTimer);
            active = false;
            const snapshot = probeWindow.__getWorkspaceSurfaceBudgetForE2E?.() ?? null;
            probeWindow.__setWorkspaceSurfacePressureForE2E('healthy');
            return {
                frames,
                layout,
                snapshot,
            };
        }, DJVU_HIGH_ZOOM_PRESSURE_DURATION_MS);

        const detail = JSON.stringify(result);
        expect(result.frames.length, detail).toBeGreaterThan(30);
        expect(result.frames.every(frame => frame.visiblePages.length > 0), detail).toBe(true);
        expect(result.frames.every(frame => frame.visiblePages.every(page => (
            page.visual === 'fresh' && page.imageReady
        ))), detail).toBe(true);
        expect(Math.max(...result.frames.map(frame => frame.imageCount)), detail).toBeLessThanOrEqual(5);

        const imageSourcesByPage = new Map<number, Set<string>>();
        for (const frame of result.frames) {
            for (const page of frame.visiblePages) {
                const sources = imageSourcesByPage.get(page.pageNumber) ?? new Set<string>();
                sources.add(page.imageSource);
                imageSourcesByPage.set(page.pageNumber, sources);
            }
        }
        expect(
            [...imageSourcesByPage.values()].every(sources => sources.size === 1 && !sources.has('')),
            detail,
        ).toBe(true);
        expect(result.snapshot?.reservedBytesByCategory['djvu-preview'] ?? Number.POSITIVE_INFINITY, detail)
            .toBeLessThan(512 * 1024 * 1024);

        expect(result.layout.adjacentGapPx, detail).toBe(20);
        expect(result.layout.viewportBackground, detail).toBe(result.layout.expectedViewportBackground);
        expect(result.layout.pageBackground, detail).not.toBe('rgba(0, 0, 0, 0)');
        expect(result.layout.pageShadow, detail).not.toBe('none');
        expect(result.layout.pageBorderRadius, detail).not.toBe('0px');
    }, 150_000);
});
