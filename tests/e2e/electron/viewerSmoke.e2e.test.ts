import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    createPngFixture,
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    clickVisibleToolbarButton,
    openDjvuInApp,
    openPdfInApp,
    waitForDjvuLoaded,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

interface IViewerSmokeSnapshot {
    hostHeight: number;
    viewerHeight: number;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    currentPage: number | null;
    visiblePages: number[];
    firstPageWidth: number;
    firstPageHeight: number;
}

interface IViewerScrollAttempt {
    maxScrollTop: number;
    scrollTop: number;
}

interface IDjvuWheelMetricSample {
    clientHeight: number;
    currentPage: number | null;
    imageCount: number;
    mountedRange: string;
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

const djvuFixture = resolveDjvuFixturePath();
const runDjvuSmokeOrSkip = selectFixtureDescribe(describe, djvuFixture);

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
            currentPage: Number.parseInt(
                visibleHost?.querySelector('.page-controls-current')?.textContent ?? '',
                10,
            ) || null,
            visiblePages,
            firstPageWidth: Math.round(firstPageRect?.width ?? 0),
            firstPageHeight: Math.round(firstPageRect?.height ?? 0),
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
        const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
        const firstPage = viewer?.querySelector<HTMLElement>('.page_container[data-page="1"]') ?? null;
        if (!viewer || !firstPage) {
            return false;
        }

        const viewerRect = viewer.getBoundingClientRect();
        const firstPageRect = firstPage.getBoundingClientRect();
        return viewerRect.height > expected.viewerHeight && firstPageRect.height > expected.firstPageHeight;
    }, { timeout: VIEWER_SMOKE_OPEN_TIMEOUT_MS }, minimums);

    return readViewerSmokeSnapshot(session);
}

async function scrollToBottomOfPageOne(session: IElectronE2ESession) {
    const attempt = await session.page.evaluate((): IViewerScrollAttempt => {
        const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
        const firstPage = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
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
        const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
        return Boolean(viewer && viewer.scrollTop > 20);
    }, { timeout: 5_000 });
    return attempt;
}

async function zoomInUntilScrollable(session: IElectronE2ESession, start: IViewerSmokeSnapshot) {
    let previous = start;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        await clickVisibleToolbarButton(session.page, 'Zoom In');
        await waitForFunctionInPage(session.page, (previousWidth: number) => {
            const pageElement = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
            return Boolean(pageElement && pageElement.getBoundingClientRect().width > previousWidth + 5);
        }, { timeout: 5_000 }, previous.firstPageWidth);

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
    const viewerRect = viewer?.getBoundingClientRect() ?? null;
    const pageShells = Array.from(surface?.querySelectorAll<HTMLElement>('[data-testid="document-page-source-page"]') ?? []);
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
        currentPage: typeof toolbarCurrentPage === 'number' && Number.isFinite(toolbarCurrentPage)
            ? Math.trunc(toolbarCurrentPage)
            : Number.parseInt(
                visibleHost?.querySelector('.page-controls-current')?.textContent
                    ?? document.querySelector('.page-controls-current')?.textContent
                    ?? '',
                10,
            ) || null,
        imageCount: surface?.querySelectorAll('[data-testid="document-page-source-image"]').length ?? 0,
        mountedRange: pageNumbers.length > 0 ? `${pageNumbers[0]}-${pageNumbers.at(-1)}` : 'empty',
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

    const scrollResult = await callWorkspaceCommand(session.page, 'scrollToPage', [startPage]);
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

    it('keeps the PDF viewport scrollable, navigable, and scalable', async () => {
        const session = sessionFixture.getSession();
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
        expect(initial.visiblePages).toContain(1);

        const zoomed = await zoomInUntilScrollable(session, initial);
        expect(zoomed.scrollHeight).toBeGreaterThan(zoomed.clientHeight + 20);

        const scrollAttempt = await scrollToBottomOfPageOne(session);
        expect(scrollAttempt.maxScrollTop).toBeGreaterThan(20);

        await clickVisibleToolbarButton(session.page, 'Fit Height');
        await waitForFunctionInPage(session.page, (previousHeight: number) => {
            const pageElement = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
            return Boolean(pageElement && Math.abs(pageElement.getBoundingClientRect().height - previousHeight) > 5);
        }, { timeout: 5_000 }, zoomed.firstPageHeight);

        await clickVisibleToolbarButton(session.page, 'Next Page');
        await waitForToolbarCurrentPage(session.page, 2);
        await waitForFunctionInPage(session.page, () => {
            const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
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

    it('opens a PNG image through the same document entrypoint', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({sessionName: () => `e2e-viewer-smoke-image-${Date.now()}`});
        if (!session) {
            return;
        }

        const pngPath = createPngFixture(`viewer-smoke-image-${Date.now()}.png`);
        await openPdfInApp(session.page, pngPath, VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, VIEWER_SMOKE_OPEN_TIMEOUT_MS);

        const snapshot = await waitForViewerSmokeSnapshot(session, {
            viewerHeight: 300,
            firstPageHeight: 0,
        });
        expect(snapshot.hostHeight).toBeGreaterThan(300);
        expect(snapshot.viewerHeight).toBeGreaterThan(300);
        expect(snapshot.visiblePages).toEqual([1]);
        expect(snapshot.firstPageWidth).toBeGreaterThan(0);
        expect(snapshot.firstPageHeight).toBeGreaterThan(0);
    });
});

runDjvuSmokeOrSkip('Electron E2E - DjVu Viewer Smoke', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-djvu-viewer-smoke-${Date.now()}`});

    it('keeps DjVu continuous wheel scroll geometry stable on the exact fixture', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await session.page.setViewport(DJVU_VIDEO_LIKE_VIEWPORT);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_VIEWER_SMOKE_OPEN_TIMEOUT_MS);
        await configureDjvuWheelMetricStart(session);

        const samples = await collectDjvuWheelMetricSamples(session);
        const summary = summarizeDjvuWheelMetrics(samples);
        const summaryDetail = JSON.stringify(summary);

        expect(summary.sampleCount, summaryDetail).toBeGreaterThan(40);
        expect(samples[0]?.currentPage ?? 0, summaryDetail).toBeGreaterThanOrEqual(DJVU_VIDEO_START_PAGE - 1);
        expect(summary.finalPage ?? 0, summaryDetail).toBeGreaterThanOrEqual(30);
        expect(samples.at(-1)!.scrollTop, summaryDetail).toBeGreaterThan(samples[0]!.scrollTop);
        expect(summary.monotonicScrollViolations, summaryDetail).toBe(0);
        expect(summary.virtualSpacerCount, summaryDetail).toBe(0);
        expect(summary.virtualSpacerHeight, summaryDetail).toBe(0);
        expect(summary.maxScrollHeightDelta, summaryDetail).toBeLessThanOrEqual(2);
        expect(summary.maxSurfaceHeightDelta, summaryDetail).toBeLessThanOrEqual(2);
        expect(summary.maxMountedPages, summaryDetail).toBeLessThanOrEqual(36);
        expect(summary.rangeTransitions, summaryDetail).toBeGreaterThan(3);
        expect(summary.maxVisibleGapPx, summaryDetail).toBeLessThanOrEqual(240);
        expect(summary.maxVisibleUnloadedFraction, summaryDetail).toBeLessThanOrEqual(0.85);
        for (const sample of samples) {
            expect(sample.visibleShellCount, summaryDetail).toBeGreaterThan(0);
            expect(sample.visibleImageCount, summaryDetail).toBeGreaterThan(0);
            expect(sample.pageNumbers).toEqual([...sample.pageNumbers].sort((left, right) => left - right));
            expect(sample.pageNumbers.at(-1)! - sample.pageNumbers[0]! + 1).toBe(sample.pageNumbers.length);
        }
    }, 120_000);

    it('keeps the DjVu render window ahead of monotonic projected trackpad scrolling', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await sessionFixture.restart({sessionName: () => `e2e-djvu-projected-scroll-${Date.now()}`});
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
});
