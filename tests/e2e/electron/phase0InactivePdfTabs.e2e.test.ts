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
    openPdfInApp,
    getToolbarCurrentPage,
    scrollViewerToPage,
    waitForPdfLoaded,
    waitForTabCount,
} from './helpers/viewerHelpers';

interface IWorkspaceHostPressure {
    index: number;
    active: boolean;
    visible: boolean;
    canvases: number;
    renderedPages: number;
    textSpans: number;
}

function readHostPressureFromPage(): IWorkspaceHostPressure[] {
    const isVisible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
            style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || '1') > 0
            && rect.width > 100
            && rect.height > 100
        );
    };

    return Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
        .map((host, index) => {
            const visible = isVisible(host);
            return {
                index,
                active: visible && Boolean(host.closest('.editor-group-pane.is-active')),
                visible,
                canvases: host.querySelectorAll('.page_canvas canvas').length,
                renderedPages: host.querySelectorAll('.page_container--rendered').length,
                textSpans: host.querySelectorAll('.text-layer span, .textLayer span').length,
            };
        });
}

async function createNewTab(session: IElectronE2ESession) {
    await session.page.locator('.tab-list .tab-new').click();
    await waitForTabCount(session.page, 2);
}

async function activateTab(session: IElectronE2ESession, tabIndex: number) {
    await session.page.evaluate((index: number) => {
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
        tabs[index]?.click();
    }, tabIndex);
}

async function waitForInactiveHostsToReleaseRenderedPages(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100
            );
        };
        const pressures = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .map((host) => {
                const visible = isVisible(host);
                return {
                    active: visible && Boolean(host.closest('.editor-group-pane.is-active')),
                    canvases: host.querySelectorAll('.page_canvas canvas').length,
                    renderedPages: host.querySelectorAll('.page_container--rendered').length,
                    textSpans: host.querySelectorAll('.text-layer span, .textLayer span').length,
                };
            });
        return pressures.some(host => host.active && host.canvases > 0 && host.renderedPages > 0)
            && pressures
                .filter(host => !host.active)
                .every(host => host.canvases === 0 && host.renderedPages === 0 && host.textSpans === 0);
    }, { timeout: 10_000 });
}

describe('Electron E2E - Phase 0 (Inactive PDF Tabs)', () => {
    let session: IElectronE2ESession | null = null;
    let firstFixturePath = '';
    let secondFixturePath = '';

    beforeAll(async () => {
        session = await startElectronE2ESession(`e2e-inactive-pdf-tabs-${Date.now()}`);
        firstFixturePath = await createMultiPageTextFixturePdf(`inactive-tabs-first-${Date.now()}.pdf`, 3);
        secondFixturePath = await createMultiPageTextFixturePdf(`inactive-tabs-second-${Date.now()}.pdf`, 3);
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('releases rendered page resources from hidden PDF tabs and restores them on activation', async () => {
        if (!session) {
            throw new Error('Inactive PDF tabs session was not initialized');
        }

        await openPdfInApp(session.page, firstFixturePath);
        await waitForPdfLoaded(session.page);
        await scrollViewerToPage(session.page, 3);
        expect(await getToolbarCurrentPage(session.page)).toBe(3);

        await createNewTab(session);
        await openPdfInApp(session.page, secondFixturePath);
        await waitForPdfLoaded(session.page);
        await scrollViewerToPage(session.page, 2);
        expect(await getToolbarCurrentPage(session.page)).toBe(2);

        await waitForInactiveHostsToReleaseRenderedPages(session);
        const afterSecondOpen = await session.page.evaluate(readHostPressureFromPage);
        expect(afterSecondOpen).toHaveLength(2);
        expect(afterSecondOpen.filter(host => host.active)).toHaveLength(1);
        expect(afterSecondOpen.filter(host => !host.active).every(host => host.canvases === 0)).toBe(true);
        expect(afterSecondOpen.filter(host => !host.active).every(host => host.renderedPages === 0)).toBe(true);

        await activateTab(session, 0);
        await waitForPdfLoaded(session.page);
        expect(await getToolbarCurrentPage(session.page)).toBe(3);
        await waitForInactiveHostsToReleaseRenderedPages(session);

        const afterFirstReactivation = await session.page.evaluate(readHostPressureFromPage);
        expect(afterFirstReactivation[0]?.active).toBe(true);
        expect(afterFirstReactivation[0]?.canvases).toBeGreaterThan(0);
        expect(afterFirstReactivation[0]?.renderedPages).toBeGreaterThan(0);
        expect(afterFirstReactivation[1]?.active).toBe(false);
        expect(afterFirstReactivation[1]?.canvases).toBe(0);
        expect(afterFirstReactivation[1]?.renderedPages).toBe(0);

        await activateTab(session, 1);
        await waitForPdfLoaded(session.page);
        expect(await getToolbarCurrentPage(session.page)).toBe(2);
        await waitForInactiveHostsToReleaseRenderedPages(session);

        const afterSecondReactivation = await session.page.evaluate(readHostPressureFromPage);
        expect(afterSecondReactivation[0]?.active).toBe(false);
        expect(afterSecondReactivation[0]?.canvases).toBe(0);
        expect(afterSecondReactivation[0]?.renderedPages).toBe(0);
        expect(afterSecondReactivation[1]?.active).toBe(true);
        expect(afterSecondReactivation[1]?.canvases).toBeGreaterThan(0);
        expect(afterSecondReactivation[1]?.renderedPages).toBeGreaterThan(0);
    });
});
