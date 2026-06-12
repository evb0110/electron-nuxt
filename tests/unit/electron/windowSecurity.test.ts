import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createWindowSecurity } from '@electron/window/createWindowSecurity';

const mocks = vi.hoisted(() => ({openExternal: vi.fn(async () => {})}));

vi.mock('electron', () => ({shell: {openExternal: mocks.openExternal}}));

function createWindowMock() {
    return {webContents: {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
    }};
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
});
