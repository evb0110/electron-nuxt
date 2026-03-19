import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildMacOSAutomationAppEntryPaths,
    buildMacOSHiddenAppBundlePaths,
    buildElectronAutomationArgs,
    resolveAutomationWindowEnv,
    shouldUseMacOSHiddenAppLauncher,
    shouldDisableAutomationSandbox,
} from '../../../scripts/electron-run/session-manager';

describe('session-manager automation launch args', () => {
    it('disables the Electron sandbox on Linux CI by default', () => {
        expect(shouldDisableAutomationSandbox({ CI: 'true' }, 'linux')).toBe(true);

        expect(buildElectronAutomationArgs({
            cdpPort: 9222,
            automationUserDataDir: '/tmp/evb-user-data',
            mainJs: '/tmp/main.js',
            env: { CI: 'true' },
            platform: 'linux',
        })).toEqual([
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--remote-debugging-port=9222',
            '--user-data-dir=/tmp/evb-user-data',
            '--disable-http-cache',
            '/tmp/main.js',
        ]);
    });

    it('keeps the sandbox enabled outside Linux CI unless explicitly overridden', () => {
        expect(shouldDisableAutomationSandbox({ CI: 'true' }, 'darwin')).toBe(false);

        expect(buildElectronAutomationArgs({
            cdpPort: 9222,
            automationUserDataDir: '/tmp/evb-user-data',
            mainJs: '/tmp/main.js',
            env: { CI: 'true' },
            platform: 'darwin',
        })).toEqual([
            '--remote-debugging-port=9222',
            '--user-data-dir=/tmp/evb-user-data',
            '--disable-http-cache',
            '/tmp/main.js',
        ]);
    });

    it('allows an explicit opt-in override on any platform', () => {
        expect(shouldDisableAutomationSandbox({ EVB_AUTOMATION_DISABLE_SANDBOX: 'true' }, 'darwin')).toBe(true);
    });

    it('defaults to hidden windows in non-interactive (CI) environments', () => {
        expect(resolveAutomationWindowEnv({}, { isTTY: false })).toEqual({
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
        });
    });

    it('defaults to visible, focused windows in interactive terminals', () => {
        expect(resolveAutomationWindowEnv({}, { isTTY: true })).toEqual({
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_HIDE_WINDOW: '0',
        });
    });

    it('keeps hide-window aligned with the explicit no-focus override unless hide-window is set', () => {
        expect(resolveAutomationWindowEnv({ EVB_AUTOMATION_NO_FOCUS: '0' }, { isTTY: false })).toEqual({
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_HIDE_WINDOW: '0',
        });

        expect(resolveAutomationWindowEnv({
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
        }, { isTTY: false })).toEqual({
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
        });
    });

    it('prefers the hidden app launcher for macOS automation sessions', () => {
        expect(shouldUseMacOSHiddenAppLauncher({
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
        }, 'darwin')).toBe(true);

        expect(shouldUseMacOSHiddenAppLauncher({
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
        }, 'linux')).toBe(false);
    });

    it('builds hidden macOS app bundle paths inside a dedicated automation directory', () => {
        expect(buildMacOSHiddenAppBundlePaths({
            sourceAppPath: '/Applications/Electron.app',
            destinationRoot: '/tmp/evb-automation-app',
        })).toEqual({
            appPath: '/tmp/evb-automation-app/Electron.app',
            executablePath: '/tmp/evb-automation-app/Electron.app/Contents/MacOS/Electron',
            infoPlistPath: '/tmp/evb-automation-app/Electron.app/Contents/Info.plist',
        });
    });

    it('builds wrapper app entry paths for dockless macOS automation launches', () => {
        expect(buildMacOSAutomationAppEntryPaths('/tmp/evb-automation-entry')).toEqual({
            appPath: '/tmp/evb-automation-entry/automation-app',
            packageJsonPath: '/tmp/evb-automation-entry/automation-app/package.json',
            mainJsPath: '/tmp/evb-automation-entry/automation-app/main.js',
        });
    });
});
