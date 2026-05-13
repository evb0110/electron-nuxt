import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import { createMultiPageTextFixturePdf } from './helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/sessionHarness';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
} from './helpers/viewerHelpers';

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

async function scrollToBottomOfPageOne(session: IElectronE2ESession) {
    await session.page.evaluate(() => {
        const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
        const firstPage = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
        if (!viewer || !firstPage) {
            return;
        }

        viewer.scrollTop = Math.max(0, firstPage.offsetTop + firstPage.offsetHeight - viewer.clientHeight);
        viewer.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
}

describe('Electron E2E - Phase 0 (Viewer Smoke)', () => {
    let session: IElectronE2ESession | null = null;
    let fixturePath = '';

    beforeAll(async () => {
        session = await startElectronE2ESession(`e2e-viewer-smoke-${Date.now()}`);
        fixturePath = await createMultiPageTextFixturePdf(`viewer-smoke-${Date.now()}.pdf`, 4);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('keeps the PDF viewport scrollable, navigable, and scalable', async () => {
        if (!session) {
            throw new Error('Viewer smoke session was not initialized');
        }

        const initial = await readViewerSmokeSnapshot(session);
        expect(initial.hostHeight).toBeGreaterThan(300);
        expect(initial.viewerHeight).toBeGreaterThan(300);
        expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight + 100);
        expect(initial.visiblePages).toContain(1);

        await scrollToBottomOfPageOne(session);
        await session.page.waitForFunction(() => {
            const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
            return Boolean(viewer && viewer.scrollTop > 100);
        }, { timeout: 5_000 });

        await clickVisibleToolbarButton(session.page, 'Next Page');
        await session.page.waitForFunction(() => {
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
            return viewer.scrollTop > 100
                && Math.min(pageRect.bottom, viewerRect.bottom) - Math.max(pageRect.top, viewerRect.top) > 100;
        }, { timeout: 5_000 });

        const beforeZoom = await readViewerSmokeSnapshot(session);
        await clickVisibleToolbarButton(session.page, 'Zoom In');
        await session.page.waitForFunction((previousWidth: number) => {
            const pageElement = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
            return Boolean(pageElement && pageElement.getBoundingClientRect().width > previousWidth + 5);
        }, { timeout: 5_000 }, beforeZoom.firstPageWidth);

        await clickVisibleToolbarButton(session.page, 'Fit Height');
        await session.page.waitForFunction((previousHeight: number) => {
            const pageElement = document.querySelector<HTMLElement>('.page_container[data-page="1"]');
            return Boolean(pageElement && Math.abs(pageElement.getBoundingClientRect().height - previousHeight) > 5);
        }, { timeout: 5_000 }, beforeZoom.firstPageHeight);
    });
});
