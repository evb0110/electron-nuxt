import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFile } from 'node:fs/promises';
import {
    NUXT_BUILD_DIR_ENV,
    NUXT_VITE_CACHE_DIR_ENV,
    buildElectronAutomationArgs,
    buildElectronExecutablePath,
    buildHeadlessAutomationEnv,
    buildAutomationAppEntryPackage,
    buildAutomationAppEntryPaths,
    buildElectronE2EAutomationEnv,
    buildMacOSHiddenAppBundlePaths,
    buildNuxtDevServerEnv,
    resolveNuxtDevServerArtifactDirs,
    resolveAutomationRendererReadyEnv,
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
    getE2ESharedRendererSessionName,
    readE2ESharedRendererConfig,
} from '@scripts/electron-run/electronRunE2ESharedRenderer';
import {
    checkNuxtHttpReadiness,
    hasOtherAliveSessionUsingNuxt,
    resolveNuxtForceCleanCachePaths,
    resolveNuxtPortStrategy,
    selectOrphanedProjectNuxtRootCleanupTargets,
    selectStaleNuxtPortOwnerCleanupTargets,
    shouldCleanupOrphanedProjectNuxtRoots,
    warmupElectronAppDependencies,
    warmupElectronAppDependenciesBestEffort,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    DEFAULT_NUXT_PORT,
    getNuxtPort,
    setNuxtPort,
} from '@scripts/electron-run/electronRunPortConfig';
import {
    E2E_RUN_ID_ENV,
    E2E_STRICT_ISOLATION_ENV,
    NUXT_WARMUP_REQUIRED_ENV,
    createE2ERunScopedSessionName,
    shouldRequireNuxtWarmup,
    shouldUseStrictE2EIsolation,
} from '@scripts/electron-run/electronRunRunId';
import { isReusableNuxtResponse } from '@scripts/electron-run/isReusableNuxtResponse';
import {
    allocateAutomationPorts,
    buildElectronRuntimeEnv,
} from '@scripts/electron-run/electronLaunch';
import {
    electronFileLogDir,
    getCurrentSessionName,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    isElectronAppPageUrl,
    isNuxtDevServerUrl,
    isRendererReadinessError,
} from '@scripts/electron-run/rendererReadiness';
const rootPackage = JSON.parse(await readFile('package.json', 'utf8')) as {version: string};

describe('sessionManager automation launch args', () => {
    it('passes a session-specific default log directory to Electron', () => {
        const previousSessionName = getCurrentSessionName();
        setCurrentSessionName('session-log-default');
        try {
            const launch = buildElectronRuntimeEnv(9222, '/tmp/main.js');
            expect(launch.electronRuntimeEnv.EVB_FILE_LOG_DIR).toBe(electronFileLogDir('session-log-default'));
        } finally {
            setCurrentSessionName(previousSessionName);
        }
    });

    it('preserves an explicit log directory override in the Electron environment', () => {
        const previous = process.env.EVB_FILE_LOG_DIR;
        process.env.EVB_FILE_LOG_DIR = '/tmp/explicit-electron-logs';
        try {
            const launch = buildElectronRuntimeEnv(9222, '/tmp/main.js');
            expect(launch.electronRuntimeEnv.EVB_FILE_LOG_DIR).toBe('/tmp/explicit-electron-logs');
        } finally {
            if (previous === undefined) {
                delete process.env.EVB_FILE_LOG_DIR;
            } else {
                process.env.EVB_FILE_LOG_DIR = previous;
            }
        }
    });

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

    it('can force a neutral reduced-motion baseline for profile E2E sessions', () => {
        expect(buildElectronAutomationArgs({
            cdpPort: 9222,
            automationUserDataDir: '/tmp/evb-user-data',
            mainJs: '/tmp/main.js',
            env: {EVB_E2E_FORCE_NO_REDUCED_MOTION: '1'},
            platform: 'darwin',
        })).toEqual([
            '--force-prefers-no-reduced-motion',
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

    it('isolates non-default Nuxt build and Vite caches from the live developer renderer', () => {
        expect(resolveNuxtDevServerArtifactDirs({}, 'default')).toBeNull();

        const isolated = resolveNuxtDevServerArtifactDirs({}, 'e2e-coexistence-shared-renderer');
        expect(isolated).toEqual({
            buildDir: expect.stringMatching(/\.devkit\/sessions\/e2e-coexistence-shared-renderer\/nuxt-build$/u),
            viteCacheDir: expect.stringMatching(/\.devkit\/sessions\/e2e-coexistence-shared-renderer\/vite-cache$/u),
        });
        expect(buildNuxtDevServerEnv({}, 3125, 'e2e-coexistence-shared-renderer')).toMatchObject({
            [NUXT_BUILD_DIR_ENV]: isolated?.buildDir,
            [NUXT_VITE_CACHE_DIR_ENV]: isolated?.viteCacheDir,
        });
    });

    it('preserves explicit isolated Nuxt artifact directories', () => {
        expect(resolveNuxtDevServerArtifactDirs({
            [NUXT_BUILD_DIR_ENV]: '/tmp/custom-nuxt',
            [NUXT_VITE_CACHE_DIR_ENV]: '/tmp/custom-vite',
        }, 'e2e-custom')).toEqual({
            buildDir: '/tmp/custom-nuxt',
            viteCacheDir: '/tmp/custom-vite',
        });
    });

    it('force-cleans only the active isolated Nuxt artifacts', () => {
        expect(resolveNuxtForceCleanCachePaths('/repo', {
            buildDir: '/repo/.devkit/sessions/e2e-clean/nuxt-build',
            viteCacheDir: '/repo/.devkit/sessions/e2e-clean/vite-cache',
        })).toEqual([
            '/repo/.devkit/sessions/e2e-clean/nuxt-build',
            '/repo/.devkit/sessions/e2e-clean/vite-cache',
        ]);
        expect(resolveNuxtForceCleanCachePaths('/repo', null)).toEqual([
            '/repo/node_modules/.vite',
            '/repo/node_modules/.cache/vite',
            '/repo/.nuxt',
        ]);
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

    it('waits for renderer readiness only for hidden automation by default', () => {
        expect(resolveAutomationRendererReadyEnv({}, {
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_HIDE_WINDOW: '0',
        })).toBe('0');

        expect(resolveAutomationRendererReadyEnv({}, {
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_HIDE_WINDOW: '0',
        })).toBe('1');

        expect(resolveAutomationRendererReadyEnv({}, {
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
        })).toBe('1');
    });

    it('respects explicit renderer readiness overrides', () => {
        const visibleWindowEnv = {
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_HIDE_WINDOW: '0',
        };

        expect(resolveAutomationRendererReadyEnv({ EVB_WAIT_RENDERER_READY: '1' }, visibleWindowEnv)).toBe('1');

        expect(resolveAutomationRendererReadyEnv({ EVB_WAIT_RENDERER_READY: '0' }, {
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
        })).toBe('0');
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

    it('gives the dedicated visible-window E2E lane the real show and focus lifecycle', () => {
        expect(buildElectronE2EAutomationEnv({ PATH: '/bin' }, 'visible')).toEqual({
            PATH: '/bin',
            EVB_AUTOMATION_NO_FOCUS: '0',
            EVB_AUTOMATION_HIDE_WINDOW: '0',
            EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '0',
        });
        expect(buildElectronE2EAutomationEnv({ PATH: '/bin' }, 'hidden')).toEqual({
            PATH: '/bin',
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '1',
        });
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

    it('builds wrapper app entry paths for managed development launches', () => {
        expect(buildAutomationAppEntryPaths('/tmp/evb-automation-entry')).toEqual({
            appPath: '/tmp/evb-automation-entry/automation-app',
            packageJsonPath: '/tmp/evb-automation-entry/automation-app/package.json',
            mainJsPath: '/tmp/evb-automation-entry/automation-app/main.js',
        });
    });

    it('pins every development wrapper to the canonical EVB Viewer version', () => {
        expect(rootPackage.version).toMatch(/^0\.1\.\d+$/u);
        expect(buildAutomationAppEntryPackage(rootPackage.version)).toEqual({
            name: 'evb-automation-app',
            version: rootPackage.version,
            main: 'main.js',
        });
        expect(() => buildAutomationAppEntryPackage('   ')).toThrow(
            'requires the canonical application version',
        );
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

    it('recognizes only the Electron route as an Electron app page', () => {
        expect(isElectronAppPageUrl('http://127.0.0.1:3235/electron')).toBe(true);
        expect(isElectronAppPageUrl('http://localhost:3235/electron/settings')).toBe(true);
        expect(isElectronAppPageUrl('evb-viewer://app/electron')).toBe(true);
        expect(isElectronAppPageUrl('evb-viewer://app/electron/settings')).toBe(true);

        expect(isElectronAppPageUrl('http://127.0.0.1:3235/')).toBe(false);
        expect(isElectronAppPageUrl('http://localhost:3235/workspace')).toBe(false);
        expect(isElectronAppPageUrl('evb-viewer://app/')).toBe(false);
        expect(isElectronAppPageUrl('about:blank')).toBe(false);
    });

    it('keeps Nuxt dev-server asset URLs eligible for optimize-dep recovery', () => {
        expect(isNuxtDevServerUrl('http://127.0.0.1:3235/_nuxt/app.js')).toBe(true);
        expect(isNuxtDevServerUrl('http://localhost:3235/')).toBe(true);
        expect(isNuxtDevServerUrl('http://127.0.0.1:3236/_nuxt/app.js')).toBe(false);
        expect(isNuxtDevServerUrl('evb-viewer://app/electron')).toBe(false);
    });

    it('classifies renderer readiness failures as non-transient launch failures', () => {
        expect(isRendererReadinessError(new Error('Renderer readiness timeout (electronAPI=undefined)'))).toBe(true);
        expect(isRendererReadinessError(new Error('Renderer startup timed out after 30000ms'))).toBe(true);
        expect(isRendererReadinessError(new Error('frame was detached'))).toBe(false);
        expect(isRendererReadinessError(new Error('VITE_OPTIMIZE_DEP_504'))).toBe(false);
    });

    it('treats failed Nuxt HTTP readiness probes as not ready', async () => {
        const fetchImpl = (async () => {
            throw new Error('connection refused');
        }) as typeof fetch;

        await expect(checkNuxtHttpReadiness({fetchImpl})).resolves.toBe(false);
    });

    it('warms the Electron route only after stable reusable Nuxt responses', async () => {
        const calls: Array<Parameters<typeof fetch>> = [];
        const responses = [
            new Response('Outdated Optimize Dep', {
                status: 504,
                headers: {'x-powered-by': 'Nuxt'},
            }),
            new Response('<script type="module" src="/_nuxt/app.js"></script>', {
                status: 200,
                headers: {'x-powered-by': 'Nuxt'},
            }),
            new Response('<script type="module" src="/_nuxt/app.js"></script>', {
                status: 200,
                headers: {'x-powered-by': 'Nuxt'},
            }),
        ];
        const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
            calls.push(args);
            return responses.shift() ?? new Response('', {status: 500});
        }) as typeof fetch;
        const timings: string[] = [];

        await expect(warmupElectronAppDependencies(
            message => timings.push(message),
            {
                fetchImpl,
                stablePolls: 2,
                pollIntervalMs: 0,
                timeoutMs: 5_000,
            },
        )).resolves.toEqual({
            ok: true,
            stablePolls: 2,
        });

        expect(calls.map(([url]) => url)).toEqual([
            'http://127.0.0.1:3235/electron',
            'http://127.0.0.1:3235/electron',
            'http://127.0.0.1:3235/electron',
        ]);
        expect(timings).toEqual(['Nuxt dependency warmup complete']);
    });

    it('returns a bounded failure result when Electron route warmup does not settle', async () => {
        const fetchImpl = (async () => new Response(
            '<main>Failed to fetch dynamically imported module</main>',
            {
                status: 200,
                headers: {'x-powered-by': 'Nuxt'},
            },
        )) as typeof fetch;

        await expect(warmupElectronAppDependencies(
            () => {},
            {
                fetchImpl,
                pollIntervalMs: 0,
                timeoutMs: 5,
            },
        )).resolves.toMatchObject({
            ok: false,
            reason: 'Electron app dependencies did not warm within 0s',
            status: 200,
            bodySnippet: '<main>Failed to fetch dynamically imported module</main>',
        });
    });

    it('logs and continues when best-effort Electron route warmup misses', async () => {
        const fetchImpl = (async () => new Response('Outdated Optimize Dep', {
            status: 504,
            headers: {'x-powered-by': 'Nuxt'},
        })) as typeof fetch;
        const originalWarn = console.warn;
        const warnings: string[] = [];
        console.warn = (message?: unknown) => {
            warnings.push(String(message));
        };
        try {
            await expect(warmupElectronAppDependenciesBestEffort(
                () => {},
                {
                    fetchImpl,
                    pollIntervalMs: 0,
                    timeoutMs: 5,
                },
            )).resolves.toMatchObject({
                ok: false,
                status: 504,
            });
        } finally {
            console.warn = originalWarn;
        }

        expect(warnings.some(message => message.includes('Dependency warmup did not settle; continuing anyway'))).toBe(true);
    });

    it('fails best-effort Electron route warmup when warmup is required', async () => {
        const previous = process.env[NUXT_WARMUP_REQUIRED_ENV];
        process.env[NUXT_WARMUP_REQUIRED_ENV] = '1';
        const fetchImpl = (async () => new Response('Outdated Optimize Dep', {
            status: 504,
            headers: {'x-powered-by': 'Nuxt'},
        })) as typeof fetch;
        try {
            await expect(warmupElectronAppDependenciesBestEffort(
                () => {},
                {
                    fetchImpl,
                    pollIntervalMs: 0,
                    timeoutMs: 5,
                },
            )).rejects.toThrow(/Electron app dependencies did not warm/);
        } finally {
            if (previous === undefined) {
                Reflect.deleteProperty(process.env, NUXT_WARMUP_REQUIRED_ENV);
            } else {
                process.env[NUXT_WARMUP_REQUIRED_ENV] = previous;
            }
        }
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
        const previousRunId = process.env[E2E_RUN_ID_ENV];
        process.env[E2E_RUN_ID_ENV] = 'test-run';
        expect(buildE2ESharedRendererEnv(4345)).toEqual({
            [E2E_RUN_ID_ENV]: 'test-run',
            [E2E_STRICT_ISOLATION_ENV]: '1',
            [E2E_SHARED_RENDERER_ENABLED_ENV]: '1',
            [E2E_SHARED_RENDERER_PORT_ENV]: '4345',
            [NUXT_WARMUP_REQUIRED_ENV]: '1',
        });
        if (previousRunId === undefined) {
            Reflect.deleteProperty(process.env, E2E_RUN_ID_ENV);
        } else {
            process.env[E2E_RUN_ID_ENV] = previousRunId;
        }
    });

    it('scopes e2e session names and strict env by run id', () => {
        const env = {[E2E_RUN_ID_ENV]: 'run/with spaces'};
        expect(createE2ERunScopedSessionName('e2e-viewer-smoke', env)).toBe('e2e-run-with-spaces-viewer-smoke');
        expect(createE2ERunScopedSessionName('e2e-run-with-spaces-viewer-smoke', env)).toBe('e2e-run-with-spaces-viewer-smoke');
        expect(getE2ESharedRendererSessionName(env)).toBe('e2e-run-with-spaces-shared-renderer');
        expect(shouldUseStrictE2EIsolation({CI: 'true'})).toBe(true);
        expect(shouldUseStrictE2EIsolation({[E2E_STRICT_ISOLATION_ENV]: '1'})).toBe(true);
        expect(shouldRequireNuxtWarmup({[NUXT_WARMUP_REQUIRED_ENV]: 'true'})).toBe(true);
    });

    it('uses isolated Nuxt and distinct automation ports for non-default sessions', async () => {
        expect(resolveNuxtPortStrategy('default')).toBe('fixed-default');
        expect(resolveNuxtPortStrategy('e2e-coexistence-viewer-smoke')).toBe('isolated-free');
        expect(shouldCleanupOrphanedProjectNuxtRoots('default')).toBe(true);
        expect(shouldCleanupOrphanedProjectNuxtRoots('e2e-coexistence-shared-renderer')).toBe(false);

        const ports = await allocateAutomationPorts(() => {});
        expect(ports.serverPort).toBeGreaterThan(0);
        expect(ports.cdpPort).toBeGreaterThan(0);
        expect(ports.cdpPort).not.toBe(ports.serverPort);
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
