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
} from './helpers/session-harness';
import {
    ensureSidebarOpen,
    openPdfInApp,
    scrollViewerToPage,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
} from './helpers/viewer-helpers';

async function waitForActiveThumbnailInView(page: IElectronE2ESession['page'], expectedPage: number) {
    await page.waitForFunction((targetPage: number) => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
        };

        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = (activeHost && isVisibleHost(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .find(isVisibleHost);
        if (!host) {
            return false;
        }

        const container = host.querySelector<HTMLElement>('.pdf-sidebar-pages-thumbnails .pdf-thumbnails');
        const activeThumbnail = host.querySelector<HTMLElement>(`.pdf-thumbnail.is-active[data-page="${targetPage}"]`);
        if (!container || !activeThumbnail) {
            return false;
        }

        const containerRect = container.getBoundingClientRect();
        const thumbnailRect = activeThumbnail.getBoundingClientRect();
        const margin = 8;
        return (
            thumbnailRect.top >= containerRect.top + margin
            && thumbnailRect.bottom <= containerRect.bottom - margin
        );
    }, {}, expectedPage);
}

describe('Electron E2E - Phase 9 (Sidebar Resize Page Stability)', () => {
    let session: IElectronE2ESession | null = null;
    let fixturePath = '';

    beforeAll(async () => {
        session = await startElectronE2ESession(`e2e-phase9-${Date.now()}`);
        fixturePath = await createMultiPageTextFixturePdf(`phase9-${Date.now()}-multipage.pdf`, 30);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('keeps the active thumbnail visible when the main viewer page changes', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 9 session was not initialized');
        }

        await ensureSidebarOpen(page);

        await scrollViewerToPage(page, 10);
        await waitForToolbarCurrentPage(page, 10);
        await waitForActiveThumbnailInView(page, 10);

        await scrollViewerToPage(page, 2);
        await waitForToolbarCurrentPage(page, 2);
        await waitForActiveThumbnailInView(page, 2);
    });

    it('does not overlap visible thumbnails after repeated sidebar scroll churn', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 9 session was not initialized');
        }

        await ensureSidebarOpen(page);

        const thumbnailState = await page.evaluate(async () => {
            const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));
            const getVisibleHost = () => {
                const isVisibleHost = (element: HTMLElement) => {
                    const rect = element.getBoundingClientRect();
                    const style = window.getComputedStyle(element);
                    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 100;
                };

                const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
                return (activeHost && isVisibleHost(activeHost))
                    ? activeHost
                    : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                        .find(isVisibleHost)
                    ?? null;
            };
            const resolveContainer = () =>
                getVisibleHost()?.querySelector<HTMLElement>('.pdf-sidebar-pages-thumbnails .pdf-thumbnails')
                ?? null;
            const collectVisibleThumbnailState = () => {
                const container = resolveContainer();
                if (!container) {
                    return {
                        overlapCount: Number.POSITIVE_INFINITY,
                        unrenderedCanvasCount: Number.POSITIVE_INFINITY,
                    };
                }

                const containerRect = container.getBoundingClientRect();
                const visibleThumbnails = Array.from(
                    container.querySelectorAll<HTMLElement>('.pdf-thumbnail'),
                )
                    .map((thumbnail) => {
                        const canvas = thumbnail.querySelector<HTMLCanvasElement>('.pdf-thumbnail-canvas');
                        return {
                            top: thumbnail.getBoundingClientRect().top,
                            bottom: thumbnail.getBoundingClientRect().bottom,
                            isRendered: canvas?.dataset.thumbnailRendered === 'true',
                        };
                    })
                    .filter((thumbnail) =>
                        thumbnail.bottom > containerRect.top
                        && thumbnail.top < containerRect.bottom,
                    )
                    .sort((left, right) => left.top - right.top);

                let overlapCount = 0;
                for (let index = 1; index < visibleThumbnails.length; index += 1) {
                    if (visibleThumbnails[index]!.top < visibleThumbnails[index - 1]!.bottom - 1) {
                        overlapCount += 1;
                    }
                }

                const unrenderedCanvasCount = visibleThumbnails
                    .filter((thumbnail) => !thumbnail.isRendered)
                    .length;

                return {
                    overlapCount,
                    unrenderedCanvasCount,
                };
            };

            const container = resolveContainer();
            if (!container) {
                return {
                    overlapCount: Number.POSITIVE_INFINITY,
                    unrenderedCanvasCount: Number.POSITIVE_INFINITY,
                };
            }

            const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
            const scrollTargets = [
                maxScrollTop,
                0,
                Math.round(maxScrollTop * 0.55),
                Math.round(maxScrollTop * 0.12),
                Math.round(maxScrollTop * 0.82),
                Math.round(maxScrollTop * 0.33),
            ];

            for (let cycle = 0; cycle < 6; cycle += 1) {
                for (const target of scrollTargets) {
                    container.scrollTop = target;
                    container.dispatchEvent(new Event('scroll'));
                    await wait(70);
                }
            }

            for (let attempt = 0; attempt < 40; attempt += 1) {
                const state = collectVisibleThumbnailState();
                if (state.overlapCount === 0 && state.unrenderedCanvasCount === 0) {
                    return state;
                }
                await wait(120);
            }

            return collectVisibleThumbnailState();
        });

        expect(thumbnailState.overlapCount).toBe(0);
        expect(thumbnailState.unrenderedCanvasCount).toBeLessThanOrEqual(3);
    });
});
