import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyLargePdfFixture,
    resolveLargePdfFixturePath,
} from './helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/sessionHarness';
import {
    assertInactiveDocumentPressureReleased,
    openPdfInApp,
    waitForPdfLoaded,
    waitForTabCount,
} from './helpers/viewerHelpers';

const LARGE_PDF_TIMEOUT_MS = 360_000;
const runLargePdfTabPressure = process.env.EVB_E2E_LARGE_PDF === '1' && Boolean(resolveLargePdfFixturePath());
const largePdfIt = runLargePdfTabPressure ? it : it.skip;

async function createNewTab(session: IElectronE2ESession) {
    const nextCount = await session.page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.length + 1);
    await session.page.locator('.tab-list .tab-new').click();
    await waitForTabCount(session.page, nextCount);
}

async function activateTab(session: IElectronE2ESession, tabIndex: number) {
    await session.page.evaluate((index: number) => {
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
        tabs[index]?.click();
    }, tabIndex);
}

describe('Electron E2E - Phase 1 (Large PDF Tab Pressure)', () => {
    let session: IElectronE2ESession | null = null;
    let largePdfPath = '';

    beforeAll(async () => {
        if (!runLargePdfTabPressure) {
            return;
        }

        session = await startElectronE2ESession(`e2e-large-pdf-tab-pressure-${Date.now()}`);
        largePdfPath = copyLargePdfFixture(`large-tab-pressure-${Date.now()}.pdf`);
    });

    afterAll(async () => {
        await session?.stop();
    });

    largePdfIt('releases rendered resources while cycling two large PDF tabs', async () => {
        if (!session) {
            throw new Error('Large PDF tab pressure session was not initialized');
        }

        await openPdfInApp(session.page, largePdfPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, LARGE_PDF_TIMEOUT_MS);

        await createNewTab(session);
        await openPdfInApp(session.page, largePdfPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, LARGE_PDF_TIMEOUT_MS);
        await assertInactiveDocumentPressureReleased(session.page);

        await activateTab(session, 0);
        await waitForPdfLoaded(session.page, LARGE_PDF_TIMEOUT_MS);
        await assertInactiveDocumentPressureReleased(session.page);

        await activateTab(session, 1);
        await waitForPdfLoaded(session.page, LARGE_PDF_TIMEOUT_MS);
        const pressure = await assertInactiveDocumentPressureReleased(session.page);

        expect(pressure.filter(host => host.active)).toHaveLength(1);
        expect(pressure.filter(host => !host.active).every(host => host.canvases === 0)).toBe(true);
    });
});
