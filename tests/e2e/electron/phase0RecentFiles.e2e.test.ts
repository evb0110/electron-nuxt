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
const RECENT_OPEN_TIMEOUT_MS = 12_000;
const RECENT_STARTUP_STABILITY_MS = 1_500;
const RECENT_OPEN_STABILITY_MS = 2_500;
const RECENT_POLL_INTERVAL_MS = 50;

interface IRecentOpenDomState {
    hasHost: boolean;
    hasLoader: boolean;
    hasViewer: boolean;
    hasRenderedContent: boolean;
    recentRowVisible: boolean;
    visibleRecentRows: number;
    visibleText: string;
}

function delay(ms: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function readRecentOpenDomState(
    session: IElectronE2ESession,
    fileName: string,
): Promise<IRecentOpenDomState> {
    return evaluateInPage(session.page, (targetFileName: string) => {
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host');
        if (!activeHost) {
            return {
                hasHost: false,
                hasLoader: false,
                hasViewer: false,
                hasRenderedContent: false,
                recentRowVisible: false,
                visibleRecentRows: 0,
                visibleText: '',
            };
        }

        const recentRows = Array.from(activeHost.querySelectorAll<HTMLButtonElement>('button.recent-row--data'))
            .filter(isVisible);
        const viewer = activeHost.querySelector<HTMLElement>('#pdf-viewer');

        return {
            hasHost: true,
            hasLoader: Array.from(activeHost.querySelectorAll<HTMLElement>('.workspace-host__loading')).some(isVisible),
            hasViewer: Boolean(viewer && isVisible(viewer)),
            hasRenderedContent: Boolean(viewer?.querySelector('.page_canvas canvas, .text-layer span, .textLayer span')),
            recentRowVisible: recentRows.some(row => row.textContent?.includes(targetFileName)),
            visibleRecentRows: recentRows.length,
            visibleText: (activeHost.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        };
    }, fileName);
}

function describeRecentOpenDomState(state: IRecentOpenDomState) {
    return JSON.stringify(state);
}

async function waitForRecentFileRow(session: IElectronE2ESession, fileName: string) {
    await waitForFunctionInPage(session.page, (targetFileName: string) => {
        return Array.from(document.querySelectorAll<HTMLButtonElement>('button.recent-row--data'))
            .some(row => row.textContent?.includes(targetFileName));
    }, { timeout: RECENT_ROW_TIMEOUT_MS }, fileName);
}

async function clickRecentFile(session: IElectronE2ESession, fileName: string) {
    await waitForRecentFileRow(session, fileName);

    const clicked = await evaluateInPage(session.page, (targetFileName: string) => {
        const row = Array.from(document.querySelectorAll<HTMLButtonElement>('button.recent-row--data'))
            .find(candidate => candidate.textContent?.includes(targetFileName));
        row?.click();
        return Boolean(row);
    }, fileName);

    expect(clicked).toBe(true);
}

async function assertRecentListStaysStableBeforeOpen(session: IElectronE2ESession, fileName: string) {
    await waitForRecentFileRow(session, fileName);

    const deadline = Date.now() + RECENT_STARTUP_STABILITY_MS;
    while (Date.now() < deadline) {
        const state = await readRecentOpenDomState(session, fileName);
        if (state.hasLoader) {
            throw new Error(`Recent files list returned to loader after first render: ${describeRecentOpenDomState(state)}`);
        }
        if (!state.recentRowVisible || state.hasViewer) {
            throw new Error(`Recent files list did not remain stable before click: ${describeRecentOpenDomState(state)}`);
        }
        await delay(RECENT_POLL_INTERVAL_MS);
    }
}

async function waitForRecentPdfOpen(session: IElectronE2ESession, fileName: string) {
    const deadline = Date.now() + RECENT_OPEN_TIMEOUT_MS;
    let sawOpenAttempt = false;
    let lastState: IRecentOpenDomState | null = null;

    while (Date.now() < deadline) {
        const state = await readRecentOpenDomState(session, fileName);
        lastState = state;

        if (state.hasLoader || state.hasViewer) {
            sawOpenAttempt = true;
        }

        if (sawOpenAttempt && state.recentRowVisible && !state.hasViewer && !state.hasLoader) {
            throw new Error(`Recent file "${fileName}" returned to the placeholder instead of opening: ${describeRecentOpenDomState(state)}`);
        }

        if (state.hasViewer && state.hasRenderedContent) {
            await waitForPdfLoaded(session.page, RECENT_OPEN_TIMEOUT_MS);
            return;
        }

        await delay(RECENT_POLL_INTERVAL_MS);
    }

    throw new Error(`Recent file "${fileName}" did not settle into a loaded viewer: ${describeRecentOpenDomState(lastState ?? {
        hasHost: false,
        hasLoader: false,
        hasViewer: false,
        hasRenderedContent: false,
        recentRowVisible: false,
        visibleRecentRows: 0,
        visibleText: '',
    })}`);
}

async function assertRecentPdfStaysLoaded(session: IElectronE2ESession, fileName: string) {
    const deadline = Date.now() + RECENT_OPEN_STABILITY_MS;
    while (Date.now() < deadline) {
        const state = await readRecentOpenDomState(session, fileName);
        if (!state.hasViewer || state.recentRowVisible || state.hasLoader) {
            throw new Error(`Recent file "${fileName}" did not remain loaded after open: ${describeRecentOpenDomState(state)}`);
        }
        await delay(RECENT_POLL_INTERVAL_MS);
    }
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

        await assertRecentListStaysStableBeforeOpen(session, basename(fixturePath));
        await clickRecentFile(session, basename(fixturePath));
        await waitForRecentPdfOpen(session, basename(fixturePath));
        await assertRecentPdfStaysLoaded(session, basename(fixturePath));
    });
});
