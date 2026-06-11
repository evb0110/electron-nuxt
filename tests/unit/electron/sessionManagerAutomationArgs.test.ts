import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildElectronAutomationArgs,
    buildElectronExecutablePath,
    buildHeadlessAutomationEnv,
    buildMacOSAutomationAppEntryPaths,
    buildMacOSHiddenAppBundlePaths,
    buildNuxtDevServerEnv,
    resolveAutomationWindowEnv,
    sanitizeElectronLaunchEnv,
    shouldBootstrapInteractiveDevProfile,
    shouldDisableAutomationSandbox,
    shouldUseMacOSHiddenAppLauncher,
} from '@scripts/electron-run/electronRunLaunchConfig';
import {
    E2E_SHARED_RENDERER_ENABLED_ENV,
    E2E_SHARED_RENDERER_PORT_ENV,
    applyE2ESharedRendererPort,
    buildE2ESharedRendererEnv,
    readE2ESharedRendererConfig,
} from '@scripts/electron-run/electronRunE2ESharedRenderer';
import { checkNuxtHttpReadiness } from '@scripts/electron-run/electronRunNuxtServer';
import {
    DEFAULT_NUXT_PORT,
    getNuxtPort,
    setNuxtPort,
} from '@scripts/electron-run/electronRunPortConfig';
import { isReusableNuxtResponse } from '@scripts/electron-run/isReusableNuxtResponse';
import {
    hasOtherAliveSessionUsingNuxt,
    selectOrphanedProjectNuxtRootCleanupTargets,
    selectStaleNuxtPortOwnerCleanupTargets,
} from '@scripts/electron-run/sessionManager';
import { shouldWaitForExternalDevServer } from '@electron/shouldWaitForExternalDevServer';

describe('sessionManager automation launch args', () => {
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

    it('strips ELECTRON_RUN_AS_NODE before launching Electron automation', () => {
        expect(sanitizeElectronLaunchEnv({
            ELECTRON_RUN_AS_NODE: '1',
            EVB_SERVER_PORT: '3100',
        })).toEqual({ EVB_SERVER_PORT: '3100' });
    });

    it('lets isolated automation Nuxt servers bypass the global dev lock', () => {
        expect(buildNuxtDevServerEnv({ PATH: '/bin' }, 3123)).toEqual({
            PATH: '/bin',
            NODE_ENV: 'development',
            PORT: '3123',
            HOST: '127.0.0.1',
            NUXT_IGNORE_LOCK: '1',
        });

        expect(buildNuxtDevServerEnv({ NUXT_IGNORE_LOCK: '0' }, 3124).NUXT_IGNORE_LOCK).toBe('0');
    });

    it('does not leak Vitest worker mode into the Nuxt dev server', () => {
        expect(buildNuxtDevServerEnv({
            NODE_ENV: 'test',
            VITEST: 'true',
            VITEST_POOL_ID: '1',
            VITEST_WORKER_ID: '1',
            CI: 'true',
        }, 3125)).toEqual({
            NODE_ENV: 'development',
            CI: 'true',
            PORT: '3125',
            HOST: '127.0.0.1',
            NUXT_IGNORE_LOCK: '1',
        });
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

    it('forces e2e automation into dockless hidden mode even from interactive env defaults', () => {
        expect(buildHeadlessAutomationEnv({
            PATH: '/bin',
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_HIDE_WINDOW: '0',
        })).toEqual({
            PATH: '/bin',
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '1',
        });

        expect(buildHeadlessAutomationEnv({ EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '0' }).EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE).toBe('0');
    });

    it('uses the hidden macOS app bundle only when explicitly requested', () => {
        expect(shouldUseMacOSHiddenAppLauncher({
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
        }, 'darwin')).toBe(false);

        expect(shouldUseMacOSHiddenAppLauncher({
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '1',
        }, 'darwin')).toBe(true);

        expect(shouldUseMacOSHiddenAppLauncher({
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '1',
        }, 'linux')).toBe(false);
    });

    it('bootstraps canonical dev recents only for the visible default session', () => {
        expect(shouldBootstrapInteractiveDevProfile({
            env: {},
            sessionName: 'default',
            automationWindowEnv: {
                EVB_AUTOMATION_NO_FOCUS: '0',
                EVB_AUTOMATION_HIDE_WINDOW: '0',
            },
        })).toBe(true);

        expect(shouldBootstrapInteractiveDevProfile({
            env: { CI: 'true' },
            sessionName: 'default',
            automationWindowEnv: {
                EVB_AUTOMATION_NO_FOCUS: '0',
                EVB_AUTOMATION_HIDE_WINDOW: '0',
            },
        })).toBe(false);

        expect(shouldBootstrapInteractiveDevProfile({
            env: {},
            sessionName: 'smoke-test',
            automationWindowEnv: {
                EVB_AUTOMATION_NO_FOCUS: '0',
                EVB_AUTOMATION_HIDE_WINDOW: '0',
            },
        })).toBe(false);

        expect(shouldBootstrapInteractiveDevProfile({
            env: {},
            sessionName: 'default',
            automationWindowEnv: {
                EVB_AUTOMATION_NO_FOCUS: '1',
                EVB_AUTOMATION_HIDE_WINDOW: '1',
            },
        })).toBe(false);
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

    it('prefers real Electron executables instead of the npm shim on supported platforms', () => {
        expect(buildElectronExecutablePath({
            platform: 'linux',
            rootDir: '/repo',
        })).toBe('/repo/node_modules/electron/dist/electron');

        expect(buildElectronExecutablePath({
            platform: 'win32',
            rootDir: 'C:/repo',
        })).toBe('C:/repo/node_modules/electron/dist/electron.exe');

        expect(buildElectronExecutablePath({
            platform: 'darwin',
            rootDir: '/repo',
        })).toBe('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    });

    it('waits for an external dev server only for fixed-port dev automation', () => {
        expect(shouldWaitForExternalDevServer({
            isDev: true,
            hasFixedServerPort: true,
            waitForExternalDevServer: true,
        })).toBe(true);

        expect(shouldWaitForExternalDevServer({
            isDev: false,
            hasFixedServerPort: true,
            waitForExternalDevServer: true,
        })).toBe(false);

        expect(shouldWaitForExternalDevServer({
            isDev: true,
            hasFixedServerPort: false,
            waitForExternalDevServer: true,
        })).toBe(false);

        expect(shouldWaitForExternalDevServer({
            isDev: true,
            hasFixedServerPort: true,
            waitForExternalDevServer: false,
        })).toBe(false);
    });

    it('reuses only Nuxt-looking dev server responses', () => {
        expect(isReusableNuxtResponse({
            poweredBy: 'Nuxt',
            body: '<script type="module" src="/_nuxt/app.js"></script>',
        })).toBe(true);

        expect(isReusableNuxtResponse({
            poweredBy: 'Express',
            body: '<script type="module" src="/_nuxt/app.js"></script>',
        })).toBe(false);

        expect(isReusableNuxtResponse({
            poweredBy: 'Nuxt',
            body: '<main>unrelated app</main>',
        })).toBe(false);
    });

    it('checks the Electron route for Nuxt HTTP readiness', async () => {
        const calls: Array<Parameters<typeof fetch>> = [];
        const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
            calls.push(args);
            return {ok: true} as Response;
        }) as typeof fetch;

        await expect(checkNuxtHttpReadiness({
            fetchImpl,
            timeoutMs: 1234,
        })).resolves.toBe(true);

        expect(calls).toHaveLength(1);
        const [
            url,
            init,
        ] = calls[0] ?? [];
        expect(url).toBe('http://127.0.0.1:3235/electron');
        expect(init).toMatchObject({method: 'GET'});
        expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it('treats failed Nuxt HTTP readiness probes as not ready', async () => {
        const fetchImpl = (async () => {
            throw new Error('connection refused');
        }) as typeof fetch;

        await expect(checkNuxtHttpReadiness({fetchImpl})).resolves.toBe(false);
    });

    it('ignores shared renderer metadata unless the e2e signal is enabled', () => {
        const env = { [E2E_SHARED_RENDERER_PORT_ENV]: '4123' };

        expect(readE2ESharedRendererConfig(env)).toBeNull();
    });

    it('parses the shared e2e renderer port from explicit metadata', () => {
        expect(readE2ESharedRendererConfig({
            [E2E_SHARED_RENDERER_ENABLED_ENV]: '1',
            [E2E_SHARED_RENDERER_PORT_ENV]: '4123',
        })).toEqual({ port: 4123 });
    });

    it('rejects invalid shared e2e renderer ports', () => {
        expect(() => readE2ESharedRendererConfig({
            [E2E_SHARED_RENDERER_ENABLED_ENV]: '1',
            [E2E_SHARED_RENDERER_PORT_ENV]: '70000',
        })).toThrow(/requires a valid/);
    });

    it('applies the shared e2e renderer port for Electron launch metadata', () => {
        try {
            expect(applyE2ESharedRendererPort({
                [E2E_SHARED_RENDERER_ENABLED_ENV]: 'true',
                [E2E_SHARED_RENDERER_PORT_ENV]: '4234',
            })).toEqual({ port: 4234 });
            expect(getNuxtPort()).toBe(4234);
        } finally {
            setNuxtPort(DEFAULT_NUXT_PORT);
        }
    });

    it('builds the shared e2e renderer environment for detached sessions', () => {
        expect(buildE2ESharedRendererEnv(4345)).toEqual({
            [E2E_SHARED_RENDERER_ENABLED_ENV]: '1',
            [E2E_SHARED_RENDERER_PORT_ENV]: '4345',
        });
    });

    it('cleans only stale session-owned Nuxt port owners', () => {
        expect(selectStaleNuxtPortOwnerCleanupTargets([
            1111,
            2222,
            3333,
        ], [
            {
                name: 'running-session',
                sessionPid: 9001,
                nuxtPid: 1111,
                nuxtPort: 3000,
                sessionAlive: true,
                nuxtAlive: true,
                descendantPids: [],
            },
            {
                name: 'stale-session',
                sessionPid: 9002,
                nuxtPid: 2222,
                nuxtPort: 3000,
                sessionAlive: false,
                nuxtAlive: true,
                descendantPids: [2223],
            },
            {
                name: 'other-port-stale-session',
                sessionPid: 9003,
                nuxtPid: 3333,
                nuxtPort: 3100,
                sessionAlive: false,
                nuxtAlive: true,
                descendantPids: [],
            },
        ], 3000)).toEqual([2222]);
    });

    it('does not select unrelated Nuxt port owners with no stale session metadata', () => {
        expect(selectStaleNuxtPortOwnerCleanupTargets([4444], [], 3000)).toEqual([]);
    });

    it('preserves a Nuxt server only for live sessions sharing its process or port', () => {
        const sessions = [
            {
                name: 'current',
                sessionAlive: true,
                nuxtPid: 1111,
                nuxtPort: 3000,
            },
            {
                name: 'same-process',
                sessionAlive: true,
                nuxtPid: 1111,
                nuxtPort: 3100,
            },
            {
                name: 'same-port',
                sessionAlive: true,
                nuxtPid: 2222,
                nuxtPort: 3000,
            },
            {
                name: 'other-isolated',
                sessionAlive: true,
                nuxtPid: 3333,
                nuxtPort: 3200,
            },
            {
                name: 'stale-same-port',
                sessionAlive: false,
                nuxtPid: 4444,
                nuxtPort: 3000,
            },
        ];

        expect(hasOtherAliveSessionUsingNuxt(sessions, 'current', 1111, 3000)).toBe(true);
        expect(hasOtherAliveSessionUsingNuxt(sessions, 'current', 5555, 3000)).toBe(true);
        expect(hasOtherAliveSessionUsingNuxt(sessions, 'current', 3333, 3200)).toBe(true);
        expect(hasOtherAliveSessionUsingNuxt(sessions, 'current', 4444, 3300)).toBe(false);
        expect(hasOtherAliveSessionUsingNuxt(sessions, 'current', 5555, 3400)).toBe(false);
    });

    it('cleans orphaned project Nuxt roots while preserving the active reusable dev-server port', () => {
        expect(selectOrphanedProjectNuxtRootCleanupTargets([
            {
                pid: 1001,
                ppid: 1,
                devServerPort: 3235,
                descendantPids: [
                    1002,
                    1003,
                ],
            },
            {
                pid: 2001,
                ppid: 1,
                devServerPort: 50054,
                descendantPids: [
                    2002,
                    2003,
                ],
            },
            {
                pid: 3001,
                ppid: 9000,
                devServerPort: 3235,
                descendantPids: [3002],
            },
            {
                pid: 4001,
                ppid: 1,
                devServerPort: 3235,
                descendantPids: [4002],
            },
        ], [4002], 3235)).toEqual([
            1001,
            2001,
        ]);
    });
});
