import {
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { basename } from 'node:path';
import {
    createMultiPageTextFixturePdf,
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    openDjvuInApp,
    openPdfInApp,
    waitForDjvuLoaded,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';

const RECENT_ROW_TIMEOUT_MS = 15_000;
const RECENT_OPEN_TIMEOUT_MS = 12_000;
const RECENT_STARTUP_STABILITY_MS = 1_500;
const RECENT_OPEN_STABILITY_MS = 2_500;
const RECENT_POLL_INTERVAL_MS = 50;
const TOOLBAR_OPEN_TRANSITION_POLL_MS = 25;
const TOOLBAR_MIN_VISIBLE_HEIGHT_PX = 40;
const TOOLBAR_MAX_OPEN_SHIFT_PX = 2;
const TOOLBAR_MIN_VISIBLE_CONTROL_COUNT = 4;

interface IRecentOpenDomState {
    hasHost: boolean;
    hasLoader: boolean;
    hasViewer: boolean;
    hasRenderedContent: boolean;
    recentRowVisible: boolean;
    visibleRecentRows: number;
    visibleText: string;
}
interface IToolbarTransitionSample {
    atMs: number;
    hasShell: boolean;
    hasWorkspace: boolean;
    owner: 'shell' | 'workspace' | 'none';
    shellHeight: number;
    workspaceTop: number;
    toolbarHeight: number;
    toolbarText: string;
    toolbarVisible: boolean;
    visibleControlCount: number;
    visibleIconCount: number;
}

async function startToolbarTransitionSampling(session: IElectronE2ESession) {
    await evaluateInPage(session.page, (pollMs: number) => {
        const transitionWindow = window as Window & {
            __evbToolbarOpenTransitionInterval?: number;
            __evbToolbarOpenTransitionSamples?: IToolbarTransitionSample[];
        };
        const samples: IToolbarTransitionSample[] = [];
        const startedAt = performance.now();

        function isVisible(element: HTMLElement | null) {
            if (!element?.isConnected) {
                return false;
            }

            let current: HTMLElement | null = element;
            while (current) {
                const style = window.getComputedStyle(current);
                if (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') <= 0.05
                ) {
                    return false;
                }
                current = current.parentElement;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function countVisible(toolbar: HTMLElement | null, selector: string) {
            if (!toolbar) {
                return 0;
            }
            return Array.from(toolbar.querySelectorAll<HTMLElement>(selector))
                .filter(isVisible)
                .length;
        }

        function sampleToolbar() {
            const shell = document.querySelector<HTMLElement>('.editor-global-toolbar-shell');
            const workspace = document.querySelector<HTMLElement>('.workspace-main-shell');
            const shellToolbar = shell?.querySelector<HTMLElement>(':scope > .toolbar') ?? null;
            const hostToolbar = document.querySelector<HTMLElement>('#editor-global-toolbar-host .toolbar');
            const visibleHostToolbar = isVisible(hostToolbar);
            const visibleShellToolbar = isVisible(shellToolbar);
            const toolbar = visibleHostToolbar ? hostToolbar : (visibleShellToolbar ? shellToolbar : null);
            const shellRect = shell?.getBoundingClientRect();
            const workspaceRect = workspace?.getBoundingClientRect();
            const toolbarRect = toolbar?.getBoundingClientRect();
            const owner = visibleHostToolbar ? 'workspace' : (visibleShellToolbar ? 'shell' : 'none');

            samples.push({
                atMs: Math.round(performance.now() - startedAt),
                hasShell: Boolean(shell),
                hasWorkspace: Boolean(workspace),
                owner,
                shellHeight: shellRect?.height ?? 0,
                workspaceTop: workspaceRect?.top ?? 0,
                toolbarHeight: toolbarRect?.height ?? 0,
                toolbarText: toolbar?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                toolbarVisible: Boolean(toolbar && isVisible(toolbar)),
                visibleControlCount: countVisible(toolbar, 'button, [role="button"], input, select'),
                visibleIconCount: countVisible(toolbar, '.iconify, svg, [class*="i-ph-"]'),
            });
        }

        window.clearInterval(transitionWindow.__evbToolbarOpenTransitionInterval);
        sampleToolbar();
        transitionWindow.__evbToolbarOpenTransitionSamples = samples;
        transitionWindow.__evbToolbarOpenTransitionInterval = window.setInterval(sampleToolbar, pollMs);
    }, TOOLBAR_OPEN_TRANSITION_POLL_MS);
}

async function stopToolbarTransitionSampling(session: IElectronE2ESession) {
    return evaluateInPage(session.page, () => {
        const transitionWindow = window as Window & {
            __evbToolbarOpenTransitionInterval?: number;
            __evbToolbarOpenTransitionSamples?: IToolbarTransitionSample[];
        };
        window.clearInterval(transitionWindow.__evbToolbarOpenTransitionInterval);
        delete transitionWindow.__evbToolbarOpenTransitionInterval;
        return transitionWindow.__evbToolbarOpenTransitionSamples ?? [];
    });
}

function assertToolbarTransitionStable(samples: IToolbarTransitionSample[]) {
    const relevantSamples = samples.filter(sample => sample.hasShell && sample.hasWorkspace);
    expect(relevantSamples.length, JSON.stringify(samples)).toBeGreaterThan(5);

    const collapsedSamples = relevantSamples.filter(sample => sample.shellHeight < TOOLBAR_MIN_VISIBLE_HEIGHT_PX);
    expect(collapsedSamples, JSON.stringify(samples)).toEqual([]);

    const absentToolbarSamples = relevantSamples.filter(sample => (
        !sample.toolbarVisible
        || sample.owner === 'none'
        || sample.toolbarHeight < TOOLBAR_MIN_VISIBLE_HEIGHT_PX
    ));
    expect(absentToolbarSamples, JSON.stringify(samples)).toEqual([]);

    const sparseToolbarSamples = relevantSamples.filter(sample => (
        sample.visibleControlCount < TOOLBAR_MIN_VISIBLE_CONTROL_COUNT
        && sample.visibleIconCount < TOOLBAR_MIN_VISIBLE_CONTROL_COUNT
    ));
    expect(sparseToolbarSamples, JSON.stringify(samples)).toEqual([]);

    const workspaceTops = relevantSamples.map(sample => sample.workspaceTop);
    const workspaceTopDelta = Math.max(...workspaceTops) - Math.min(...workspaceTops);
    expect(workspaceTopDelta, JSON.stringify(samples)).toBeLessThanOrEqual(TOOLBAR_MAX_OPEN_SHIFT_PX);

    expect(relevantSamples.some(sample => sample.owner === 'shell'), JSON.stringify(samples)).toBe(true);
    expect(relevantSamples.some(sample => sample.owner === 'workspace'), JSON.stringify(samples)).toBe(true);
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
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host')
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

async function waitForRecentDjvuOpen(session: IElectronE2ESession, fileName: string) {
    const deadline = Date.now() + RECENT_OPEN_TIMEOUT_MS;
    let sawOpenAttempt = false;
    let lastState: IRecentOpenDomState | null = null;

    while (Date.now() < deadline) {
        const state = await readRecentOpenDomState(session, fileName);
        lastState = state;

        if (state.hasLoader || state.visibleText.includes('.djvu') || state.visibleText.includes('.djv')) {
            sawOpenAttempt = true;
        }

        if (sawOpenAttempt && state.recentRowVisible && !state.hasLoader) {
            throw new Error(`Recent DjVu "${fileName}" returned to the placeholder instead of opening: ${describeRecentOpenDomState(state)}`);
        }

        const loaded = await evaluateInPage(session.page, () => {
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host')
                ?? document.querySelector<HTMLElement>('.workspace-host');
            return (activeHost?.querySelectorAll('[data-testid="document-page-source-image"]').length ?? 0) > 0;
        });
        if (loaded) {
            await waitForDjvuLoaded(session.page, RECENT_OPEN_TIMEOUT_MS);
            return;
        }

        await delay(RECENT_POLL_INTERVAL_MS);
    }

    throw new Error(`Recent DjVu "${fileName}" did not settle into a loaded viewer: ${describeRecentOpenDomState(lastState ?? {
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

describe('Electron E2E - Recent Files', () => {
    const sessionName = `e2e-recent-files-${Date.now()}`;

    const sessionFixture = createElectronE2ESessionFixture({sessionName});

    it('opens a persisted recent PDF after restarting Electron', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        const fixturePath = await createMultiPageTextFixturePdf(`recent-file-${Date.now()}.pdf`, 2);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        session = await sessionFixture.restart({
            clean: false,
            keepNuxt: true,
        });
        if (!session) {
            return;
        }

        await assertRecentListStaysStableBeforeOpen(session, basename(fixturePath));
        await startToolbarTransitionSampling(session);
        await clickRecentFile(session, basename(fixturePath));
        await waitForRecentPdfOpen(session, basename(fixturePath));
        assertToolbarTransitionStable(await stopToolbarTransitionSampling(session));
        await assertRecentPdfStaysLoaded(session, basename(fixturePath));
    });
});

const djvuFixture = resolveDjvuFixturePath();
const runDjvuRecentOrSkip = selectFixtureDescribe(describe, djvuFixture);

runDjvuRecentOrSkip('Electron E2E - Recent DjVu Files', () => {
    const sessionName = `e2e-recent-djvu-files-${Date.now()}`;

    const sessionFixture = createElectronE2ESessionFixture({sessionName});

    it('opens a persisted recent DjVu after restarting Electron', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await openDjvuInApp(session.page, djvuFixture.path, 90_000);
        await waitForDjvuLoaded(session.page, 90_000);
        session = await sessionFixture.restart({
            clean: false,
            keepNuxt: true,
        });
        if (!session) {
            return;
        }

        await assertRecentListStaysStableBeforeOpen(session, basename(djvuFixture.path));
        await clickRecentFile(session, basename(djvuFixture.path));
        await waitForRecentDjvuOpen(session, basename(djvuFixture.path));
    });
});
