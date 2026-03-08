import {
    afterAll,
    beforeAll,
    describe,
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
        fixturePath = await createMultiPageTextFixturePdf(`phase9-${Date.now()}-multipage.pdf`, 12);
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
});
