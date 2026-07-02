import {
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';

const HYDRATION_CONSOLE_QUIET_WINDOW_MS = 1_500;
const HYDRATION_CONSOLE_POLL_INTERVAL_MS = 100;
const HYDRATION_CONSOLE_MAX_WAIT_MS = 10_000;
const TOOLBAR_STARTUP_SAMPLE_WINDOW_MS = 1_800;
const TOOLBAR_MIN_VISIBLE_HEIGHT_PX = 40;
const TOOLBAR_MAX_STARTUP_SHIFT_PX = 2;

interface IConsoleCommandResult { messages: Array<{
    type: string;
    text: string;
    timestamp: number;
}>; }
interface IToolbarStartupRect {
    height: number;
    top: number;
    width: number;
}
interface IToolbarStartupSample {
    elapsedMs: number;
    hasShell: boolean;
    hasWorkspace: boolean;
    shell: IToolbarStartupRect | null;
    toolbar: IToolbarStartupRect | null;
    workspace: IToolbarStartupRect | null;
    toolbarText: string;
    toolbarVisible: boolean;
}

function findHydrationWarnings(messages: IConsoleCommandResult['messages']) {
    return messages.filter(message => {
        const text = message.text.toLowerCase();
        return text.includes('hydration node mismatch')
            || text.includes('hydration text content mismatch')
            || text.includes('hydration completed but contains mismatches');
    });
}

async function waitForHydrationConsoleQuiet(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => (
        document.readyState !== 'loading'
        && Boolean(document.querySelector('.app-shell-root'))
    ), { timeout: 10_000 });

    const startedAt = Date.now();
    let consoleResult = await session.command<IConsoleCommandResult>('console', [
        'all',
        200,
    ]);

    while (Date.now() - startedAt < HYDRATION_CONSOLE_MAX_WAIT_MS) {
        if (findHydrationWarnings(consoleResult.messages).length > 0) {
            return consoleResult;
        }

        const latestConsoleTimestamp = Math.max(
            startedAt,
            ...consoleResult.messages.map(message => message.timestamp),
        );
        const quietForMs = Date.now() - latestConsoleTimestamp;
        if (quietForMs >= HYDRATION_CONSOLE_QUIET_WINDOW_MS) {
            return consoleResult;
        }

        await delay(Math.min(
            HYDRATION_CONSOLE_POLL_INTERVAL_MS,
            HYDRATION_CONSOLE_QUIET_WINDOW_MS - quietForMs,
        ));
        consoleResult = await session.command<IConsoleCommandResult>('console', [
            'all',
            200,
        ]);
    }

    return consoleResult;
}

async function installToolbarStartupSampler(session: IElectronE2ESession) {
    await session.page.evaluateOnNewDocument((durationMs: number) => {
        const samples: IToolbarStartupSample[] = [];
        const startedAt = performance.now();

        function readRect(selector: string): IToolbarStartupRect | null {
            const element = document.querySelector(selector);
            if (!element) {
                return null;
            }

            const rect = element.getBoundingClientRect();
            return {
                height: rect.height,
                top: rect.top,
                width: rect.width,
            };
        }

        function isVisible(element: Element | null) {
            if (!element) {
                return false;
            }

            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.height > 0
                && rect.width > 0;
        }

        function sampleToolbarStartup() {
            const toolbar = document.querySelector('.editor-global-toolbar-shell .toolbar');
            samples.push({
                elapsedMs: Math.round(performance.now() - startedAt),
                hasShell: Boolean(document.querySelector('.editor-global-toolbar-shell')),
                hasWorkspace: Boolean(document.querySelector('.workspace-main-shell')),
                shell: readRect('.editor-global-toolbar-shell'),
                toolbar: readRect('.editor-global-toolbar-shell .toolbar'),
                workspace: readRect('.workspace-main-shell'),
                toolbarText: toolbar?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                toolbarVisible: isVisible(toolbar),
            });

            if (performance.now() - startedAt < durationMs) {
                requestAnimationFrame(sampleToolbarStartup);
            }
        }

        Object.defineProperty(window, '__evbToolbarStartupSamples', {
            configurable: true,
            value: samples,
        });
        requestAnimationFrame(sampleToolbarStartup);
    }, TOOLBAR_STARTUP_SAMPLE_WINDOW_MS);
}

async function readToolbarStartupSamples(session: IElectronE2ESession) {
    return session.page.evaluate(() => (
        (window as Window & {__evbToolbarStartupSamples?: IToolbarStartupSample[];}).__evbToolbarStartupSamples ?? []
    ));
}

function getShellStartupSamples(samples: IToolbarStartupSample[]) {
    return samples.filter(sample => (
        sample.hasShell
        && sample.hasWorkspace
        && sample.shell
        && sample.workspace
    ));
}

describe('Electron E2E - Startup Hydration', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-startup-hydration-${Date.now()}`});

    it('does not emit Vue hydration mismatch warnings on initial desktop startup', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        const consoleResult = await waitForHydrationConsoleQuiet(session);
        const hydrationWarnings = findHydrationWarnings(consoleResult.messages);

        expect(hydrationWarnings).toEqual([]);
        expect(session.page.url()).toContain('/electron');
    });

    it('keeps the start-page toolbar row stable across startup hydration', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        await installToolbarStartupSampler(session);
        await session.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForHydrationConsoleQuiet(session);
        await delay(TOOLBAR_STARTUP_SAMPLE_WINDOW_MS + 100);

        const shellSamples = getShellStartupSamples(await readToolbarStartupSamples(session));
        expect(shellSamples.length).toBeGreaterThan(0);

        const collapsedSamples = shellSamples.filter(sample => (
            (sample.shell?.height ?? 0) < TOOLBAR_MIN_VISIBLE_HEIGHT_PX
        ));
        expect(collapsedSamples).toEqual([]);

        const hiddenToolbarSamples = shellSamples.filter(sample => !sample.toolbarVisible);
        expect(hiddenToolbarSamples).toEqual([]);

        const workspaceTops = shellSamples.map(sample => sample.workspace?.top ?? 0);
        const workspaceTopShift = Math.max(...workspaceTops) - Math.min(...workspaceTops);
        expect(workspaceTopShift).toBeLessThanOrEqual(TOOLBAR_MAX_STARTUP_SHIFT_PX);

        const finalSample = shellSamples.at(-1);
        expect(finalSample?.toolbarVisible).toBe(true);
        expect(finalSample?.toolbar).not.toBeNull();
    });
});
