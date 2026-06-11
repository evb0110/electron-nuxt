import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    createPngFixture,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';

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

const VIEWER_SMOKE_OPEN_TIMEOUT_MS = 45_000;

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
