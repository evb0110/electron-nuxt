import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    configureMacKeychainAccess,
    MAC_SAFE_STORAGE_KEYCHAIN_SWITCH,
    MAC_SYSTEM_KEYCHAIN_ENV,
} from '@electron/security/macKeychainAccess';

function createApp(options: {hasSwitch?: boolean} = {}) {
    const commandLine = {
        appendSwitch: vi.fn(),
        hasSwitch: vi.fn(() => options.hasSwitch === true),
    };
    return {commandLine};
}

describe('macOS keychain access configuration', () => {
    it('uses Chromium mock keychain on macOS to avoid Safe Storage prompts', () => {
        const app = createApp();

        const configured = configureMacKeychainAccess(app, {
            platform: 'darwin',
            env: {},
        });

        expect(configured).toBe(true);
        expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(MAC_SAFE_STORAGE_KEYCHAIN_SWITCH);
    });

    it('does not change non-macOS startup', () => {
        const app = createApp();

        const configured = configureMacKeychainAccess(app, {
            platform: 'linux',
            env: {},
        });

        expect(configured).toBe(false);
        expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
    });

    it('allows the system keychain when explicitly requested', () => {
        const app = createApp();

        const configured = configureMacKeychainAccess(app, {
            platform: 'darwin',
            env: {[MAC_SYSTEM_KEYCHAIN_ENV]: '1'},
        });

        expect(configured).toBe(false);
        expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
    });

    it('does not append the switch twice', () => {
        const app = createApp({hasSwitch: true});

        const configured = configureMacKeychainAccess(app, {
            platform: 'darwin',
            env: {},
        });

        expect(configured).toBe(false);
        expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
    });
});
