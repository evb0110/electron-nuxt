import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcMainEvent } from 'electron';
import {
    CORE_IPC_EVENT_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
} from '@electron/platform-ipc/coreContract';
import {
    attachNativeWindowCloseHandshake,
    NATIVE_WINDOW_CLOSE_HANDSHAKE_TIMEOUT_MS,
} from '@electron/window/windowCloseHandshake';

function createHarness(options: {
    shouldBypass?: () => boolean;
    timeoutMs?: number
} = {}) {
    const windowHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const responseHandlers = new Set<(event: IpcMainEvent, payload: unknown) => void>();
    const webContents = {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
    };
    const logger = {warn: vi.fn()};

    const window = {
        id: 7,
        webContents,
        isDestroyed: vi.fn(() => false),
        on(event: string, handler: (...args: unknown[]) => void) {
            const handlers = windowHandlers.get(event) ?? [];
            handlers.push(handler);
            windowHandlers.set(event, handlers);
            return window;
        },
        once(event: string, handler: (...args: unknown[]) => void) {
            const wrapped = (...args: unknown[]) => {
                removeWindowHandler(event, wrapped);
                handler(...args);
            };
            const handlers = windowHandlers.get(event) ?? [];
            handlers.push(wrapped);
            windowHandlers.set(event, handlers);
            return window;
        },
        close: vi.fn(() => {
            const event = {preventDefault: vi.fn()};
            emitWindowEvent('close', event);
            if (event.preventDefault.mock.calls.length === 0) {
                emitWindowEvent('closed');
            }
        }),
    };

    function removeWindowHandler(event: string, handler: (...args: unknown[]) => void) {
        const handlers = windowHandlers.get(event) ?? [];
        windowHandlers.set(event, handlers.filter(candidate => candidate !== handler));
    }

    function emitWindowEvent(event: string, ...args: unknown[]) {
        for (const handler of [...(windowHandlers.get(event) ?? [])]) {
            handler(...args);
        }
    }

    const ipcMain = {
        on: vi.fn((channel: string, handler: (event: IpcMainEvent, payload: unknown) => void) => {
            if (channel === CORE_IPC_SEND_CHANNELS.windowCloseResponse) {
                responseHandlers.add(handler);
            }
            return ipcMain;
        }),
        removeListener: vi.fn((channel: string, handler: (event: IpcMainEvent, payload: unknown) => void) => {
            if (channel === CORE_IPC_SEND_CHANNELS.windowCloseResponse) {
                responseHandlers.delete(handler);
            }
            return ipcMain;
        }),
    };

    const cleanup = attachNativeWindowCloseHandshake(
        window as never,
        {
            createRequestId: (() => {
                let nextId = 0;
                return () => `close-request-${++nextId}`;
            })(),
            ipcMain: ipcMain as never,
            logger,
            ...(options.shouldBypass ? {shouldBypass: options.shouldBypass} : {}),
            ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs}),
        },
    );

    return {
        cleanup,
        emitResponse(payload: unknown, sender: unknown = webContents) {
            for (const handler of [...responseHandlers]) {
                handler({sender} as never, payload);
            }
        },
        emitWindowEvent,
        ipcMain,
        logger,
        webContents,
        window,
    };
}

describe('native window close handshake', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        'save',
        'discard',
    ] as const)('allows an explicit %s decision to close the window', decision => {
        const harness = createHarness();
        const closeEvent = {preventDefault: vi.fn()};

        harness.emitWindowEvent('close', closeEvent);
        expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
        expect(harness.webContents.send).toHaveBeenCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-1'},
        );

        harness.emitResponse({
            requestId: 'close-request-1',
            decision,
        });

        expect(harness.window.close).toHaveBeenCalledOnce();
        expect(harness.ipcMain.removeListener).toHaveBeenCalledWith(
            CORE_IPC_SEND_CHANNELS.windowCloseResponse,
            expect.any(Function),
        );
    });

    it('does not leave a one-shot approval armed when another listener vetoes close', () => {
        const harness = createHarness();
        harness.window.on('close', (...args: unknown[]) => {
            const event = args[0] as {preventDefault(): void};
            event.preventDefault();
        });

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-1',
            decision: 'save',
        });
        harness.webContents.send.mockClear();

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});

        expect(harness.webContents.send).toHaveBeenCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-2'},
        );
        harness.cleanup();
    });

    it('keeps the window open for cancel and retries after a timeout', async () => {
        vi.useFakeTimers();
        const harness = createHarness({timeoutMs: 25});
        const firstCloseEvent = {preventDefault: vi.fn()};

        harness.emitWindowEvent('close', firstCloseEvent);
        harness.emitResponse({
            requestId: 'close-request-1',
            decision: 'cancel',
        });
        expect(harness.window.close).not.toHaveBeenCalled();

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-2',
            decision: 'save',
        }, {});
        harness.emitResponse({
            requestId: 'close-request-2',
            decision: 'invalid',
        });
        await vi.advanceTimersByTimeAsync(25);

        expect(harness.window.close).not.toHaveBeenCalled();
        expect(harness.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('timed out after 25ms'),
        );

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        expect(harness.webContents.send).toHaveBeenLastCalledWith(
            CORE_IPC_EVENT_CHANNELS.windowCloseRequest,
            {requestId: 'close-request-3'},
        );
    });

    it('keeps the window open and logs an unavailable renderer decision', () => {
        const harness = createHarness();

        harness.emitWindowEvent('close', {preventDefault: vi.fn()});
        harness.emitResponse({
            requestId: 'close-request-1',
            status: 'unavailable',
            reason: 'multiple-handlers',
        });

        expect(harness.window.close).not.toHaveBeenCalled();
        expect(harness.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('multiple-handlers'),
        );
    });

    it('fails closed when sending the request fails', () => {
        const harness = createHarness();
        harness.webContents.send.mockImplementationOnce(() => {
            throw new Error('renderer unavailable');
        });

        const closeEvent = {preventDefault: vi.fn()};
        harness.emitWindowEvent('close', closeEvent);

        expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
        expect(harness.window.close).not.toHaveBeenCalled();
        expect(harness.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Failed to send close request'),
        );
    });

    it('lets coordinated shutdown bypass the user close handshake', () => {
        const harness = createHarness({shouldBypass: () => true});
        const closeEvent = {preventDefault: vi.fn()};

        harness.emitWindowEvent('close', closeEvent);

        expect(closeEvent.preventDefault).not.toHaveBeenCalled();
        expect(harness.webContents.send).not.toHaveBeenCalled();
    });

    it('uses a finite default timeout', () => {
        expect(NATIVE_WINDOW_CLOSE_HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(0);
    });
});
