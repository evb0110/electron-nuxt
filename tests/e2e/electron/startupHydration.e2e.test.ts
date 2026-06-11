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

interface IConsoleCommandResult { messages: Array<{
    type: string;
    text: string;
    timestamp: number;
}>; }

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
});
