import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/getE2EWindow';
import {assertInactiveDocumentPressureReleased} from '@tests/e2e/electron/helpers/viewerPressure';
import {
    openDjvuInApp,
    openPdfInApp,
    setTabMemoryPolicyForE2E,
    waitForDjvuLoaded,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForTabCount} from '@tests/e2e/electron/helpers/viewerTabs';

interface IWorkspaceDjvuPressure {
    index: number;
    active: boolean;
    visible: boolean;
    pageShells: number;
    images: number;
}

const DJVU_E2E_TIMEOUT_MS = 90_000;

function readDjvuPressureFromPage(): IWorkspaceDjvuPressure[] {
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
                pageShells: host.querySelectorAll('.djvu-page-shell').length,
                images: host.querySelectorAll('.djvu-page-shell img').length,
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

async function waitForActiveDjvuImages(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        return (activeHost?.querySelectorAll('.djvu-page-shell img').length ?? 0) > 0;
    }, { timeout: 20_000 });
}

async function waitForVisibleDjvuImageHosts(session: IElectronE2ESession, expectedCount: number) {
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
            .filter(host => isVisible(host) && host.querySelectorAll('.djvu-page-shell img').length > 0)
            .length >= expected;
    }, { timeout: DJVU_E2E_TIMEOUT_MS }, expectedCount);
}

async function waitForInactiveDjvuImagesToRelease(session: IElectronE2ESession) {
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
        return Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(host => !isVisible(host))
            .every(host => host.querySelectorAll('.djvu-page-shell img').length === 0);
    }, { timeout: 20_000 });
}

const djvuFixture = resolveDjvuFixturePath();
const runOrSkip = selectFixtureDescribe(describe, djvuFixture);

runOrSkip('Electron E2E - Inactive DjVu Tabs', () => {
    let pdfFixturePath = '';

    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-inactive-djvu-tabs-${Date.now()}`});

    it('releases hidden DjVu page images and restores previews on activation', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await setTabMemoryPolicyForE2E(session.page, 'aggressive', DJVU_E2E_TIMEOUT_MS);
        pdfFixturePath = await createMultiPageTextFixturePdf(`inactive-djvu-other-tab-${Date.now()}.pdf`, 3);
        await openDjvuInApp(session.page, djvuFixture.path, DJVU_E2E_TIMEOUT_MS);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);

        const afterDjvuOpen = await session.page.evaluate(readDjvuPressureFromPage);
        expect(afterDjvuOpen).toHaveLength(1);
        expect(afterDjvuOpen[0]?.active).toBe(true);
        expect(afterDjvuOpen[0]?.images).toBeGreaterThan(0);

        await createNewTab(session);
        await openPdfInApp(session.page, pdfFixturePath);
        await waitForPdfLoaded(session.page);
        await waitForInactiveDjvuImagesToRelease(session);

        const afterPdfOpen = await session.page.evaluate(readDjvuPressureFromPage);
        expect(afterPdfOpen.length).toBeGreaterThanOrEqual(1);
        expect(afterPdfOpen.length).toBeLessThanOrEqual(2);
        expect(afterPdfOpen.filter(host => !host.active).every(host => host.images === 0)).toBe(true);

        await activateTab(session, 0);
        await waitForDjvuLoaded(session.page);
        await waitForActiveDjvuImages(session);

        const afterDjvuReactivation = await session.page.evaluate(readDjvuPressureFromPage);
        const activeAfterDjvuReactivation = afterDjvuReactivation.find(host => host.active);
        expect(activeAfterDjvuReactivation?.images).toBeGreaterThan(0);
        expect(afterDjvuReactivation.filter(host => !host.active).every(host => host.images === 0)).toBe(true);
    });

    it('keeps copied visible split-pane DjVu documents rendered', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await activateTab(session, 0);
        await waitForDjvuLoaded(session.page, DJVU_E2E_TIMEOUT_MS);
        await waitForActiveDjvuImages(session);

        await splitActiveDocument(session, 'right');
        await waitForVisibleDjvuImageHosts(session, 2);

        const pressure = await assertInactiveDocumentPressureReleased(session.page);
        expect(pressure.filter(host => host.active).length).toBeGreaterThanOrEqual(2);
        expect(pressure.filter(host => host.active).every(host => host.djvuImages > 0)).toBe(true);
    });
});
