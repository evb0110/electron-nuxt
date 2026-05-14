import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import { basename } from 'node:path';
import { stopSingleSession } from '../../../scripts/electron-run/sessionManager';
import { createMultiPageTextFixturePdf } from './helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/sessionHarness';
import {
    openPdfInApp,
    waitForPdfLoaded,
} from './helpers/viewerHelpers';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from './helpers/pageRuntime';

const RECENT_ROW_TIMEOUT_MS = 15_000;

async function clickRecentFile(session: IElectronE2ESession, fileName: string) {
    await waitForFunctionInPage(session.page, (targetFileName: string) => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('button.recent-row--data'))
            .some(row => row.textContent?.includes(targetFileName));
    }, { timeout: RECENT_ROW_TIMEOUT_MS }, fileName);

    const clicked = await evaluateInPage(session.page, (targetFileName: string) => {
        const row = Array.from(document.querySelectorAll<HTMLButtonElement>('button.recent-row--data'))
            .find(candidate => candidate.textContent?.includes(targetFileName));
        row?.click();
        return Boolean(row);
    }, fileName);

    expect(clicked).toBe(true);
}

describe('Electron E2E - Phase 0 (Recent Files)', () => {
    let session: IElectronE2ESession | null = null;
    const sessionName = `e2e-recent-files-${Date.now()}`;
    let fixturePath = '';

    beforeAll(async () => {
        session = await startElectronE2ESession(sessionName);
        fixturePath = await createMultiPageTextFixturePdf(`recent-file-${Date.now()}.pdf`, 2);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);

        session.browser.disconnect();
        await stopSingleSession(sessionName, { keepNuxt: true });
        session = await startElectronE2ESession(sessionName, { clean: false });
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('opens a persisted recent PDF after restarting Electron', async () => {
        if (!session) {
            throw new Error('Recent files session was not initialized');
        }

        await clickRecentFile(session, basename(fixturePath));
        await waitForPdfLoaded(session.page);
    });
});
