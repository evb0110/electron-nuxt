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
const RECENT_RETURN_TIMEOUT_MS = 5_000;

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

async function waitForRecentPdfOpen(session: IElectronE2ESession, fileName: string) {
    const returnedToPlaceholder = waitForFunctionInPage(session.page, (targetFileName: string) => {
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host');
        if (!activeHost) {
            return false;
        }

        const hasViewer = Boolean(activeHost.querySelector('#pdf-viewer'));
        const hasLoader = Boolean(activeHost.querySelector('.workspace-host__loading'));
        const recentRowVisible = Array.from(activeHost.querySelectorAll<HTMLButtonElement>('button.recent-row--data'))
            .some((row) => {
                const rect = row.getBoundingClientRect();
                const style = window.getComputedStyle(row);
                return (
                    row.textContent?.includes(targetFileName) === true
                    && rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                );
            });

        return recentRowVisible && !hasViewer && !hasLoader;
    }, { timeout: RECENT_RETURN_TIMEOUT_MS }, fileName)
        .then(() => {
            throw new Error(`Recent file "${fileName}" returned to the placeholder instead of opening`);
        })
        .catch((error: unknown) => {
            if (error instanceof Error && /Timed out|timeout|exceeded|Waiting failed/i.test(error.message)) {
                return new Promise<never>(() => {});
            }
            throw error;
        });

    await Promise.race([
        waitForPdfLoaded(session.page),
        returnedToPlaceholder,
    ]);
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
        await waitForRecentPdfOpen(session, basename(fixturePath));
    });
});
