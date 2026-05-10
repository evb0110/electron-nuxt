import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createWindowSecurity } from '@electron/window/security';

const mocks = vi.hoisted(() => ({openExternal: vi.fn(async () => {})}));

vi.mock('electron', () => ({shell: {openExternal: mocks.openExternal}}));

function createWindowMock() {
    return {webContents: {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
    }};
}

describe('createWindowSecurity', () => {
    it('tracks the current trusted renderer origin instead of a startup snapshot', () => {
        let trustedOrigin = 'evb-viewer://app';
        const security = createWindowSecurity({
            getTrustedRendererOrigin: () => trustedOrigin,
            logger: { warn: vi.fn() },
        });

        expect(security.isTrustedRendererUrl('evb-viewer://app/electron/settings')).toBe(true);

        trustedOrigin = 'http://127.0.0.1:41001';

        expect(security.isTrustedRendererUrl('http://127.0.0.1:41001/electron/settings')).toBe(true);
        expect(security.isTrustedRendererUrl('evb-viewer://app/electron/settings')).toBe(false);
    });

    it('blocks unsupported protocols before delegating to shell.openExternal', () => {
        const logger = { warn: vi.fn() };
        const security = createWindowSecurity({
            getTrustedRendererOrigin: () => 'evb-viewer://app',
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
