import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { startElectronE2ESession } from '@tests/e2e/electron/helpers/sessionHarness';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/sessionHarness';

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

describe('Electron E2E - Phase 0 (Startup Hydration)', () => {
    let session: IElectronE2ESession | null = null;

    beforeAll(async () => {
        session = await startElectronE2ESession(`e2e-phase0-${Date.now()}`);
        await delay(1500);
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('does not emit Vue hydration mismatch warnings on initial desktop startup', async () => {
        if (!session) {
            throw new Error('Phase 0 session was not initialized');
        }

        const consoleResult = await session.command<IConsoleCommandResult>('console', [
            'all',
            200,
        ]);
        const hydrationWarnings = findHydrationWarnings(consoleResult.messages);

        expect(hydrationWarnings).toEqual([]);
        expect(session.page.url()).toContain('/electron');
    });
});
