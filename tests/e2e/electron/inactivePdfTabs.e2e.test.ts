import {
    describe,
    expect,
    it,
} from 'vitest';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import {assertInactiveDocumentPressureReleased} from '@tests/e2e/electron/helpers/assertInactiveDocumentPressureReleased';
import {waitForWorkspaceToolbarSnapshot} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    goToPageViaToolbar,
    getToolbarCurrentPage,
    openPdfInApp,
    scrollViewerToPage,
    setTabMemoryPolicyForE2E,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForTabCount} from '@tests/e2e/electron/helpers/waitForTabCount';
import {
    expectSplitPaneCloseContinuity,
    runSplitPaneCloseContinuity,
} from '@tests/e2e/electron/helpers/splitPaneCloseContinuity';

interface IWorkspaceHostPressure {
    index: number;
    active: boolean;
    visible: boolean;
    canvases: number;
    renderedPages: number;
    textSpans: number;
    searchHighlights: number;
    annotationLayers: number;
    annotationEditorLayers: number;
    freeTextEditors: number;
    noteWindows: number;
    popups: number;
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
                active: visible,
                visible,
                canvases: host.querySelectorAll('.page_canvas canvas').length,
                renderedPages: host.querySelectorAll('.page_container--rendered').length,
                textSpans: host.querySelectorAll('.text-layer span, .textLayer span').length,
                searchHighlights: host.querySelectorAll('.pdf-search-highlight, .pdf-search-highlight-current').length,
                annotationLayers: host.querySelectorAll('.annotationLayer, .annotation-layer').length,
                annotationEditorLayers: host.querySelectorAll('.annotationEditorLayer, .annotation-editor-layer').length,
                freeTextEditors: host.querySelectorAll('.freeTextEditor').length,
                noteWindows: host.querySelectorAll('.pdf-annotation-note-window, .note-window').length,
                popups: host.querySelectorAll('.annotationLayer .popup, .annotation-layer .popup, .pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog').length,
            };
        });
}

async function createNewTab(session: IElectronE2ESession) {
    const nextCount = await session.page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.length + 1);
    const clicked = await session.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.tab-list .tab-new');
        button?.click();
        return Boolean(button);
    });
    expect(clicked).toBe(true);
    await waitForTabCount(session.page, nextCount);
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
                    active: visible,
                    canvases: host.querySelectorAll('.page_canvas canvas').length,
                    renderedPages: host.querySelectorAll('.page_container--rendered').length,
                    textSpans: host.querySelectorAll('.text-layer span, .textLayer span').length,
                    searchHighlights: host.querySelectorAll('.pdf-search-highlight, .pdf-search-highlight-current').length,
                    annotationLayers: host.querySelectorAll('.annotationLayer, .annotation-layer').length,
                    annotationEditorLayers: host.querySelectorAll('.annotationEditorLayer, .annotation-editor-layer').length,
                    freeTextEditors: host.querySelectorAll('.freeTextEditor').length,
                    noteWindows: host.querySelectorAll('.pdf-annotation-note-window, .note-window').length,
                    popups: host.querySelectorAll('.annotationLayer .popup, .annotation-layer .popup, .pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog').length,
                };
            });
        return pressures.some(host => host.active && host.canvases > 0 && host.renderedPages > 0)
            && pressures
                .filter(host => !host.active)
                .every(host =>
                    host.canvases === 0
                    && host.renderedPages === 0
                    && host.textSpans === 0
                    && host.searchHighlights === 0
                    && host.annotationLayers === 0
                    && host.annotationEditorLayers === 0
                    && host.freeTextEditors === 0
                    && host.noteWindows === 0
                    && host.popups === 0,
                );
    }, { timeout: 30_000 });
}

async function splitActiveDocument(session: IElectronE2ESession, direction: 'right' | 'down' = 'right') {
    const split = await session.page.evaluate(async (targetDirection: 'right' | 'down') => {
        const splitEditor = (window as IE2EWindow & {__splitEditorForE2E?: (direction: 'right' | 'down') => Promise<void> | void;}).__splitEditorForE2E;
        if (typeof splitEditor === 'function') {
            await splitEditor(targetDirection);
            return true;
        }
        return false;
    }, direction);

    expect(split).toBe(true);
    await session.page.waitForFunction(() => document.querySelectorAll('.editor-pane').length >= 2);
}

async function waitForVisibleRenderedPdfHosts(session: IElectronE2ESession, expectedCount: number) {
    await session.page.waitForFunction((expected: number) => {
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
            .filter(host => isVisible(host) && host.querySelectorAll('.page_container--rendered').length > 0)
            .length >= expected;
    }, { timeout: 30_000 }, expectedCount);
}

describe('Electron E2E - Inactive PDF Tabs', () => {
    let firstFixturePath = '';
    let secondFixturePath = '';

    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-inactive-pdf-tabs-${Date.now()}`});

    it('releases rendered page resources from hidden PDF tabs and restores them on activation', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        await setTabMemoryPolicyForE2E(session.page, 'aggressive');
        firstFixturePath = await createMultiPageTextFixturePdf(`inactive-tabs-first-${Date.now()}.pdf`, 3);
        secondFixturePath = await createMultiPageTextFixturePdf(`inactive-tabs-second-${Date.now()}.pdf`, 3);
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
        expect(afterSecondOpen.length).toBeGreaterThanOrEqual(1);
        expect(afterSecondOpen.length).toBeLessThanOrEqual(2);
        expect(afterSecondOpen.filter(host => host.active)).toHaveLength(1);
        expect(afterSecondOpen.filter(host => !host.active).every(host => host.canvases === 0)).toBe(true);
        expect(afterSecondOpen.filter(host => !host.active).every(host => host.renderedPages === 0)).toBe(true);

        await activateTab(session, 0);
        await waitForPdfLoaded(session.page);
        await waitForInactiveHostsToReleaseRenderedPages(session);

        const afterFirstReactivation = await session.page.evaluate(readHostPressureFromPage);
        const activeAfterFirstReactivation = afterFirstReactivation.find(host => host.active);
        expect(activeAfterFirstReactivation?.renderedPages).toBeGreaterThan(0);
        expect(afterFirstReactivation.filter(host => !host.active).every(host => host.canvases === 0)).toBe(true);
        expect(afterFirstReactivation.filter(host => !host.active).every(host => host.renderedPages === 0)).toBe(true);

        await activateTab(session, 1);
        await waitForPdfLoaded(session.page);
        await waitForInactiveHostsToReleaseRenderedPages(session);

        const afterSecondReactivation = await session.page.evaluate(readHostPressureFromPage);
        const activeAfterSecondReactivation = afterSecondReactivation.find(host => host.active);
        expect(afterSecondReactivation.filter(host => !host.active).every(host => host.canvases === 0)).toBe(true);
        expect(afterSecondReactivation.filter(host => !host.active).every(host => host.renderedPages === 0)).toBe(true);
        expect(activeAfterSecondReactivation?.renderedPages).toBeGreaterThan(0);
    });

    it('keeps every visible split-pane document rendered while releasing hidden resources', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        await activateTab(session, 0);
        await waitForPdfLoaded(session.page);
        await splitActiveDocument(session, 'right');
        await openPdfInApp(session.page, firstFixturePath);
        await waitForPdfLoaded(session.page);
        await waitForVisibleRenderedPdfHosts(session, 2);

        await activateTab(session, 0);
        await waitForPdfLoaded(session.page);
        await waitForInactiveHostsToReleaseRenderedPages(session);
        const pressure = await assertInactiveDocumentPressureReleased(session.page);

        expect(pressure.filter(host => host.active).length).toBeGreaterThanOrEqual(2);
        expect(pressure.filter(host => host.active).every(host => host.renderedPages > 0)).toBe(true);
    });

    it('keeps the exact PDF pane, tab, document surface, and viewport anchor while closing an empty split', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-pdf-empty-split-continuity-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const fixturePath = await createMultiPageTextFixturePdf(
            `pdf-empty-split-continuity-${Date.now()}.pdf`,
            8,
        );
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        await goToPageViaToolbar(session.page, 4);
        await waitForWorkspaceToolbarSnapshot(session.page, {currentPage: 4});
        expect(await getToolbarCurrentPage(session.page)).toBe(4);

        const continuity = await runSplitPaneCloseContinuity(session, {
            documentKind: 'pdf',
            expectedPageNumber: 4,
        });
        expectSplitPaneCloseContinuity(continuity);
    }, 120_000);
});
