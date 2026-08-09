import { execFileSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    basename,
    join,
} from 'node:path';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    getCurrentSessionName,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import type { PackageJson } from 'type-fest';

const TRUTHY_ENV_VALUES = new Set([
    '1',
    'true',
    'yes',
    'on',
]);

export const NUXT_BUILD_DIR_ENV = 'EVB_NUXT_BUILD_DIR';
export const NUXT_VITE_CACHE_DIR_ENV = 'EVB_NUXT_VITE_CACHE_DIR';

function normalizeOptionalPath(value: string | undefined) {
    const normalized = value?.trim();
    if (!normalized) {
        return undefined;
    }
    return normalized;
}

export function resolveNuxtDevServerArtifactDirs(
    env: NodeJS.ProcessEnv = process.env,
    sessionName = getCurrentSessionName(),
) {
    const explicitBuildDir = normalizeOptionalPath(env[NUXT_BUILD_DIR_ENV]);
    const explicitViteCacheDir = normalizeOptionalPath(env[NUXT_VITE_CACHE_DIR_ENV]);
    if (sessionName === 'default' && !explicitBuildDir && !explicitViteCacheDir) {
        return null;
    }

    const artifactsDir = sessionDir(sessionName);
    return {
        buildDir: explicitBuildDir ?? join(artifactsDir, 'nuxt-build'),
        viteCacheDir: explicitViteCacheDir ?? join(artifactsDir, 'vite-cache'),
    };
}

export function shouldDisableAutomationSandbox(
    env: NodeJS.ProcessEnv = process.env,
    platform = process.platform,
) {
    const explicitSetting = env.EVB_AUTOMATION_DISABLE_SANDBOX?.trim().toLowerCase();
    if (explicitSetting) {
        return TRUTHY_ENV_VALUES.has(explicitSetting);
    }

    return platform === 'linux' && env.CI === 'true';
}

export function buildElectronAutomationArgs(options: {
    cdpPort: number;
    automationUserDataDir: string;
    mainJs: string;
    initialOpenPaths?: string[];
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}) {
    const initialOpenPaths = options.initialOpenPaths ?? [];
    const forceNoReducedMotion = options.env?.EVB_E2E_FORCE_NO_REDUCED_MOTION === '1';
    const args = [
        `--remote-debugging-port=${options.cdpPort}`,
        `--user-data-dir=${options.automationUserDataDir}`,
        '--disable-http-cache',
        options.mainJs,
        ...(initialOpenPaths.length > 0
            ? [
                '--',
                ...initialOpenPaths,
            ]
            : []),
    ];

    if (shouldDisableAutomationSandbox(options.env, options.platform)) {
        args.unshift(
            '--disable-setuid-sandbox',
            '--no-sandbox',
        );
    }
    if (forceNoReducedMotion) {
        args.unshift('--force-prefers-no-reduced-motion');
    }

    return args;
}

export function sanitizeElectronLaunchEnv(env: NodeJS.ProcessEnv) {
    const launchEnv = { ...env };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    return launchEnv;
}

export function buildNuxtDevServerEnv(
    env: NodeJS.ProcessEnv,
    port: number,
    sessionName = getCurrentSessionName(),
) {
    const launchEnv: NodeJS.ProcessEnv = {};
    for (const [
        key,
        value,
    ] of Object.entries(env)) {
        if (key === 'VITEST' || key.startsWith('VITEST_')) {
            continue;
        }
        launchEnv[key] = value;
    }

    const artifactDirs = resolveNuxtDevServerArtifactDirs(env, sessionName);
    return {
        ...launchEnv,
        NODE_ENV: 'development',
        PORT: String(port),
        HOST: '127.0.0.1',
        NUXT_IGNORE_LOCK: env.NUXT_IGNORE_LOCK ?? '1',
        ...(artifactDirs
            ? {
                [NUXT_BUILD_DIR_ENV]: artifactDirs.buildDir,
                [NUXT_VITE_CACHE_DIR_ENV]: artifactDirs.viteCacheDir,
            }
            : {}),
    };
}

export function resolveAutomationWindowEnv(
    env: NodeJS.ProcessEnv = process.env,
    options?: { isTTY?: boolean },
) {
    const isTTY = options?.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    const defaultFlag = isTTY ? '0' : '1';
    const noFocus = env.EVB_AUTOMATION_NO_FOCUS ?? defaultFlag;
    const hideWindow = env.EVB_AUTOMATION_HIDE_WINDOW ?? env.EVB_AUTOMATION_NO_FOCUS ?? defaultFlag;

    return {
        EVB_AUTOMATION_NO_FOCUS: noFocus,
        EVB_AUTOMATION_HIDE_WINDOW: hideWindow,
    };
}

export function resolveAutomationRendererReadyEnv(
    env: NodeJS.ProcessEnv,
    automationWindowEnv: ReturnType<typeof resolveAutomationWindowEnv>,
) {
    if (env.EVB_WAIT_RENDERER_READY !== undefined) {
        return env.EVB_WAIT_RENDERER_READY;
    }
    return automationWindowEnv.EVB_AUTOMATION_HIDE_WINDOW === '1'
        || automationWindowEnv.EVB_AUTOMATION_NO_FOCUS === '1'
        ? '1'
        : '0';
}

export function buildHeadlessAutomationEnv(env: NodeJS.ProcessEnv = process.env) {
    return {
        ...env,
        EVB_AUTOMATION_NO_FOCUS: '1',
        EVB_AUTOMATION_HIDE_WINDOW: '1',
        EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: env.EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE === '0'
            ? '0'
            : '1',
    } satisfies NodeJS.ProcessEnv;
}

export type TElectronE2EWindowMode = 'hidden' | 'visible';

export function buildElectronE2EAutomationEnv(
    env: NodeJS.ProcessEnv = process.env,
    windowMode: TElectronE2EWindowMode = 'hidden',
) {
    if (windowMode === 'hidden') {
        return buildHeadlessAutomationEnv(env);
    }

    return {
        ...env,
        EVB_AUTOMATION_NO_FOCUS: '0',
        EVB_AUTOMATION_HIDE_WINDOW: '0',
        EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '0',
    } satisfies NodeJS.ProcessEnv;
}

export function shouldUseMacOSHiddenAppLauncher(
    env: NodeJS.ProcessEnv,
    platform = process.platform,
) {
    // JS-level dock hiding runs after launch, which can still flash a Dock icon.
    // The copied LSUIElement bundle is opt-in for automation paths that need
    // truly dockless macOS startup.
    return platform === 'darwin'
        && env.EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE === '1'
        && (env.EVB_AUTOMATION_HIDE_WINDOW === '1' || env.EVB_AUTOMATION_NO_FOCUS === '1');
}

export function shouldBootstrapInteractiveDevProfile(options: {
    env?: NodeJS.ProcessEnv;
    sessionName?: string;
    automationWindowEnv?: ReturnType<typeof resolveAutomationWindowEnv>;
    isTTY?: boolean;
}) {
    const env = options.env ?? process.env;
    const sessionName = options.sessionName ?? getCurrentSessionName();
    const automationWindowEnv = options.automationWindowEnv ?? resolveAutomationWindowEnv(env, {...(options.isTTY === undefined ? {} : { isTTY: options.isTTY })});

    return env.CI !== 'true'
        && sessionName === 'default'
        && automationWindowEnv.EVB_AUTOMATION_NO_FOCUS === '0'
        && automationWindowEnv.EVB_AUTOMATION_HIDE_WINDOW === '0';
}

export function buildMacOSHiddenAppBundlePaths(options: {
    sourceAppPath: string;
    destinationRoot: string;
}) {
    const appPath = join(options.destinationRoot, basename(options.sourceAppPath));
    return {
        appPath,
        executablePath: join(
            appPath,
            'Contents',
            'MacOS',
            basename(options.sourceAppPath, '.app'),
        ),
        infoPlistPath: join(appPath, 'Contents', 'Info.plist'),
    };
}

export function buildElectronExecutablePath(options?: {
    platform?: NodeJS.Platform;
    rootDir?: string;
}) {
    const platform = options?.platform ?? process.platform;
    const rootDir = options?.rootDir ?? projectRoot;
    const distDir = join(rootDir, 'node_modules', 'electron', 'dist');

    // Automation must launch the real Electron binary here.
    // The npm shim can fail in CI/package environments before Electron starts.
    if (platform === 'darwin') {
        return join(distDir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    }

    if (platform === 'win32') {
        return join(distDir, 'electron.exe');
    }

    return join(distDir, 'electron');
}

function setMacOSAutomationAgentMode(infoPlistPath: string) {
    const replaceArgs = [
        '-replace',
        'LSUIElement',
        '-bool',
        'YES',
        infoPlistPath,
    ];
    const insertArgs = [
        '-insert',
        'LSUIElement',
        '-bool',
        'YES',
        infoPlistPath,
    ];

    try {
        execFileSync('/usr/bin/plutil', replaceArgs, { stdio: 'ignore' });
    } catch {
        execFileSync('/usr/bin/plutil', insertArgs, { stdio: 'ignore' });
    }
}

export function prepareMacOSHiddenAppBundle(options: {
    sourceAppPath: string;
    destinationRoot: string;
}) {
    const bundlePaths = buildMacOSHiddenAppBundlePaths(options);
    if (existsSync(bundlePaths.executablePath) && existsSync(bundlePaths.infoPlistPath)) {
        return bundlePaths;
    }
    rmSync(bundlePaths.appPath, {
        recursive: true,
        force: true,
    });
    mkdirSync(options.destinationRoot, { recursive: true });
    execFileSync('/usr/bin/ditto', [
        options.sourceAppPath,
        bundlePaths.appPath,
    ], { stdio: 'ignore' });
    setMacOSAutomationAgentMode(bundlePaths.infoPlistPath);
    return bundlePaths;
}

export function buildAutomationAppEntryPaths(destinationRoot: string) {
    const appPath = join(destinationRoot, 'automation-app');
    return {
        appPath,
        packageJsonPath: join(appPath, 'package.json'),
        mainJsPath: join(appPath, 'main.js'),
    };
}

export function buildAutomationAppEntryPackage(appVersion: string) {
    const version = appVersion.trim();
    if (!version) {
        throw new Error('The development app entry requires the canonical application version.');
    }

    return {
        name: 'evb-automation-app',
        version,
        main: 'main.js',
    } satisfies PackageJson;
}

function readCanonicalApplicationVersion() {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as PackageJson;
    if (typeof packageJson.version !== 'string') {
        throw new Error('The root package.json must define the canonical application version.');
    }
    return packageJson.version;
}

export function prepareAutomationAppEntry(options: {
    destinationRoot: string;
    mainJs: string;
    appVersion?: string;
}) {
    const entryPaths = buildAutomationAppEntryPaths(options.destinationRoot);
    rmSync(entryPaths.appPath, {
        recursive: true,
        force: true,
    });
    mkdirSync(entryPaths.appPath, { recursive: true });
    const packageJson = buildAutomationAppEntryPackage(
        options.appVersion ?? readCanonicalApplicationVersion(),
    );
    writeFileSync(entryPaths.packageJsonPath, JSON.stringify(packageJson, null, 2));
    writeFileSync(entryPaths.mainJsPath, [
        '(async () => {',
        `  await import(${JSON.stringify(options.mainJs)});`,
        '})();',
        '',
    ].join('\n'));
    return entryPaths;
}
