import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createMultiPageTextFixturePdf,
    isDjvuFixtureRequired,
    resolveDjvuFixturePath,
} from './helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/sessionHarness';
import {
    openDjvuInApp,
    openPdfInApp,
    waitForDjvuLoaded,
    waitForPdfLoaded,
    waitForTabCount,
} from './helpers/viewerHelpers';

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
                active: visible && Boolean(host.closest('.editor-group-pane.is-active')),
                visible,
                pageShells: host.querySelectorAll('.djvu-page-shell').length,
                images: host.querySelectorAll('.djvu-page-shell img').length,
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

async function waitForActiveDjvuImages(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => {
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        return (activeHost?.querySelectorAll('.djvu-page-shell img').length ?? 0) > 0;
    }, { timeout: 20_000 });
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
            .filter((host) => !(isVisible(host) && host.closest('.editor-group-pane.is-active')))
            .every(host => host.querySelectorAll('.djvu-page-shell img').length === 0);
    }, { timeout: 20_000 });
}

const djvuFixture = resolveDjvuFixturePath();
const runOrSkip = djvuFixture.path || isDjvuFixtureRequired() ? describe : describe.skip;

runOrSkip('Electron E2E - Phase 0 (Inactive DjVu Tabs)', () => {
    let session: IElectronE2ESession | null = null;
    let pdfFixturePath = '';

    beforeAll(async () => {
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        session = await startElectronE2ESession(`e2e-inactive-djvu-tabs-${Date.now()}`);
        pdfFixturePath = await createMultiPageTextFixturePdf(`inactive-djvu-other-tab-${Date.now()}.pdf`, 3);
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('releases hidden DjVu page images and restores previews on activation', async () => {
        if (!session || !djvuFixture.path) {
            throw new Error('Inactive DjVu tabs session was not initialized');
        }

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
        expect(afterPdfOpen).toHaveLength(2);
        expect(afterPdfOpen[0]?.active).toBe(false);
        expect(afterPdfOpen[0]?.images).toBe(0);

        await activateTab(session, 0);
        await waitForDjvuLoaded(session.page);
        await waitForActiveDjvuImages(session);

        const afterDjvuReactivation = await session.page.evaluate(readDjvuPressureFromPage);
        expect(afterDjvuReactivation[0]?.active).toBe(true);
        expect(afterDjvuReactivation[0]?.images).toBeGreaterThan(0);
        expect(afterDjvuReactivation[1]?.active).toBe(false);
    });
});
