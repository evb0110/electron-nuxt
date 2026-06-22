import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';

const mocks = vi.hoisted(() => ({pushDebugLogMessage: vi.fn()}));

vi.mock('@electron/preload/debugLogBuffer', () => ({pushDebugLogMessage: mocks.pushDebugLogMessage}));

describe('installDebugLogListener', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        delete (globalThis as Record<string, unknown>).__preloadDebugLogListenerInstalled;
    });

    it('pushes decoded debug log entries from the trusted channel', async () => {
        const on = vi.fn();
        const { installDebugLogListener } = await import('@electron/preload/installDebugLogListener');

        installDebugLogListener({on});
        const listener = getDebugLogListener(on);
        listener({}, {
            source: 'main',
            message: 'hello',
            timestamp: '2026-03-21T00:00:00.000Z',
            level: 'INFO',
        });

        expect(mocks.pushDebugLogMessage).toHaveBeenCalledWith({
            source: 'main',
            message: 'hello',
            timestamp: '2026-03-21T00:00:00.000Z',
            level: 'INFO',
        });
    });

    it('drops malformed debug log payloads', async () => {
        const on = vi.fn();
        const { installDebugLogListener } = await import('@electron/preload/installDebugLogListener');

        installDebugLogListener({on});
        const listener = getDebugLogListener(on);
        listener({}, {
            source: 'main',
            message: 'unknown level',
            timestamp: '2026-03-21T00:00:00.000Z',
            level: 'TRACE',
        });
        listener({}, {
            source: 'main',
            message: 42,
            timestamp: '2026-03-21T00:00:00.000Z',
        });
        listener({}, null);

        expect(mocks.pushDebugLogMessage).not.toHaveBeenCalled();
    });
});

function getDebugLogListener(on: ReturnType<typeof vi.fn>) {
    const listener = on.mock.calls.find(call => call[0] === CORE_IPC_EVENT_CHANNELS.debugLog)?.[1];
    if (typeof listener !== 'function') {
        throw new Error('Expected debug log listener to be registered');
    }
    return listener as (_event: unknown, data: unknown) => void;
}
