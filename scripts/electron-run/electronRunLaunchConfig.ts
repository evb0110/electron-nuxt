import { execFileSync } from 'node:child_process';
import {
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    basename,
    join,
} from 'node:path';
import { projectRoot } from './electronRunProjectPaths';
import { getCurrentSessionName } from './electronRunSessionPaths';

const TRUTHY_ENV_VALUES = new Set([
    '1',
    'true',
    'yes',
    'on',
]);

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
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}) {
    const args = [
        `--remote-debugging-port=${options.cdpPort}`,
        `--user-data-dir=${options.automationUserDataDir}`,
        '--disable-http-cache',
        options.mainJs,
    ];

    if (shouldDisableAutomationSandbox(options.env, options.platform)) {
        args.unshift(
            '--disable-setuid-sandbox',
            '--no-sandbox',
        );
    }

    return args;
}

export function sanitizeElectronLaunchEnv(env: NodeJS.ProcessEnv) {
    const launchEnv = { ...env };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    return launchEnv;
}

export function buildNuxtDevServerEnv(env: NodeJS.ProcessEnv, port: number) {
    return {
        ...env,
        PORT: String(port),
        HOST: '127.0.0.1',
        NUXT_IGNORE_LOCK: env.NUXT_IGNORE_LOCK ?? '1',
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

export function shouldUseMacOSHiddenAppLauncher(
    env: NodeJS.ProcessEnv,
    platform = process.platform,
) {
    return platform === 'darwin'
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
    const automationWindowEnv = options.automationWindowEnv ?? resolveAutomationWindowEnv(env, { isTTY: options.isTTY });

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

export function buildMacOSAutomationAppEntryPaths(destinationRoot: string) {
    const appPath = join(destinationRoot, 'automation-app');
    return {
        appPath,
        packageJsonPath: join(appPath, 'package.json'),
        mainJsPath: join(appPath, 'main.js'),
    };
}

export function prepareMacOSAutomationAppEntry(options: {
    destinationRoot: string;
    mainJs: string;
}) {
    const entryPaths = buildMacOSAutomationAppEntryPaths(options.destinationRoot);
    rmSync(entryPaths.appPath, {
        recursive: true,
        force: true,
    });
    mkdirSync(entryPaths.appPath, { recursive: true });
    writeFileSync(entryPaths.packageJsonPath, JSON.stringify({
        name: 'evb-automation-app',
        main: 'main.js',
    }, null, 2));
    writeFileSync(entryPaths.mainJsPath, [
        '(async () => {',
        `  await import(${JSON.stringify(options.mainJs)});`,
        '})();',
        '',
    ].join('\n'));
    return entryPaths;
}
