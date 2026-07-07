import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createWindowSecurity } from '@electron/window/createWindowSecurity';

const mocks = vi.hoisted(() => ({openExternal: vi.fn(async () => {})}));

vi.mock('electron', () => ({shell: {openExternal: mocks.openExternal}}));

function createWindowMock() {
    return {
        once: vi.fn(),
        webContents: {
            on: vi.fn(),
            setWindowOpenHandler: vi.fn(),
        },
    };
}

function createLoggerMock() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

describe('createWindowSecurity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.setSystemTime(new Date('2026-06-21T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('tracks the current trusted renderer URL instead of a startup snapshot', () => {
        let trustedUrl = 'evb-viewer://app/electron';
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => trustedUrl,
            logger: createLoggerMock(),
        });

        expect(security.isTrustedRendererUrl('evb-viewer://app/electron/settings')).toBe(true);

        trustedUrl = 'http://127.0.0.1:41001/electron';

        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/electron/settings')).toBe(true);
        expect(security.isTrustedRendererUrl('evb-viewer://app/electron/settings')).toBe(false);
    });

    it('rejects same-origin renderer URLs outside the configured app route', () => {
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'http://127.0.0.1:41001/electron',
            logger: createLoggerMock(),
        });

        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/electron')).toBe(true);
        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/electron/viewer')).toBe(true);
        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/admin')).toBe(false);
        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/electronic')).toBe(false);
    });

    it('blocks unsupported protocols before delegating to shell.openExternal', () => {
        const logger = createLoggerMock();
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'evb-viewer://app/electron',
            logger,
        });
        const window = createWindowMock();

        security.hardenWindowWebContents(window as never);

        const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
            | ((details: {url: string;}) => {action: 'deny';})
            | undefined;

        expect(openHandler).toBeTypeOf('function');
        expect(openHandler?.({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
        expect(mocks.openExternal).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            'Blocked window-open URL with unsupported protocol: javascript:alert(1)',
        );
    });

    it('throttles repeated window-open attempts by source and window instead of full URL', () => {
        vi.useFakeTimers();
        const logger = createLoggerMock();
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'evb-viewer://app/electron',
            logger,
        });
        const window = createWindowMock();

        security.hardenWindowWebContents(window as never);

        const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
            | ((details: {url: string;}) => {action: 'deny';})
            | undefined;
        expect(openHandler).toBeTypeOf('function');

        openHandler?.({url: 'https://example.com/docs?nonce=1'});
        openHandler?.({url: 'https://example.com/other?nonce=2'});
        openHandler?.({url: 'https://other.example.test/path?nonce=3'});

        expect(mocks.openExternal).toHaveBeenCalledOnce();
        expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/docs?nonce=1');
        expect(logger.warn).toHaveBeenCalledWith(
            'Blocked repeated window-open URL open: https://example.com/other?nonce=2',
        );
        expect(logger.warn).toHaveBeenCalledWith(
            'Blocked repeated window-open URL open: https://other.example.test/path?nonce=3',
        );

        vi.advanceTimersByTime(1_000);
        openHandler?.({url: 'https://example.com/after'});

        expect(mocks.openExternal).toHaveBeenCalledTimes(2);
        expect(mocks.openExternal).toHaveBeenLastCalledWith('https://example.com/after');
    });

    it('keeps external-open throttles scoped to each window and source', () => {
        vi.useFakeTimers();
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'evb-viewer://app/electron',
            logger: createLoggerMock(),
        });
        const firstWindow = createWindowMock();
        const secondWindow = createWindowMock();

        security.hardenWindowWebContents(firstWindow as never);
        security.hardenWindowWebContents(secondWindow as never);

        const firstOpenHandler = firstWindow.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
            | ((details: {url: string;}) => {action: 'deny';})
            | undefined;
        const secondOpenHandler = secondWindow.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
            | ((details: {url: string;}) => {action: 'deny';})
            | undefined;
        const firstWillNavigate = firstWindow.webContents.on.mock.calls
            .find(([event]) => event === 'will-navigate')?.[1] as
            | ((event: {preventDefault: () => void;}, url: string) => void)
            | undefined;

        firstOpenHandler?.({url: 'https://example.com/from-first-window'});
        secondOpenHandler?.({url: 'https://example.com/from-second-window'});
        firstWillNavigate?.({preventDefault: vi.fn()}, 'https://example.com/from-navigation');

        expect(mocks.openExternal).toHaveBeenCalledTimes(3);
        expect(mocks.openExternal).toHaveBeenNthCalledWith(1, 'https://example.com/from-first-window');
        expect(mocks.openExternal).toHaveBeenNthCalledWith(2, 'https://example.com/from-second-window');
        expect(mocks.openExternal).toHaveBeenNthCalledWith(3, 'https://example.com/from-navigation');
    });

    it('hardens top-level navigation without blocking trusted renderer routes', async () => {
        vi.useFakeTimers();
        const logger = createLoggerMock();
        const security = createWindowSecurity({
            getTrustedRendererUrl: () => 'evb-viewer://app/electron',
            logger,
        });
        const window = createWindowMock();

        security.hardenWindowWebContents(window as never);

        const willNavigate = window.webContents.on.mock.calls.find(([event]) => event === 'will-navigate')?.[1] as
            | ((event: {preventDefault: () => void;}, url: string) => void)
            | undefined;
        expect(willNavigate).toBeTypeOf('function');

        const trustedEvent = {preventDefault: vi.fn()};
        willNavigate?.(trustedEvent, 'evb-viewer://app/electron/viewer');
        willNavigate?.(trustedEvent, 'about:blank');
        expect(trustedEvent.preventDefault).not.toHaveBeenCalled();

        const externalEvent = {preventDefault: vi.fn()};
        willNavigate?.(externalEvent, 'https://example.com/docs');
        expect(externalEvent.preventDefault).toHaveBeenCalledOnce();
        expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/docs');

        const javascriptEvent = {preventDefault: vi.fn()};
        willNavigate?.(javascriptEvent, 'javascript:alert(1)');
        expect(javascriptEvent.preventDefault).toHaveBeenCalledOnce();
        expect(mocks.openExternal).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            'Blocked navigation URL with unsupported protocol: javascript:alert(1)',
        );

        mocks.openExternal.mockRejectedValueOnce(new Error('launch failed'));
        vi.setSystemTime(new Date('2026-06-21T00:00:02Z'));
        willNavigate?.({preventDefault: vi.fn()}, 'https://example.com/fail');
        await vi.runAllTimersAsync();
        expect(logger.warn).toHaveBeenCalledWith(
            'Failed to open external URL (navigation): launch failed',
        );
    });
});
