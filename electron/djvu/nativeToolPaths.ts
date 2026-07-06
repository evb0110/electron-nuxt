import { app } from 'electron';
import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import { resolveNativeToolsBase } from '@electron/native-tools/resolveNativeToolsBase';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';

export interface IDjvuNativeToolPaths {
    ddjvu: string;
    djvudump: string;
    djvused: string;
}

export interface IResolveDjvuNativeToolPathsOptions {
    exists?: (path: string) => boolean;
    isPackaged: boolean;
    nativeToolsBase: string;
    platform?: NodeJS.Platform;
    platformArch: string;
}

export interface IGetDjvuNativeToolsBaseOptions {
    cwd?: string;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
    resourcesPath?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DJVU_RESOURCE_NAME = 'djvulibre';

function isElectronAppPackaged() {
    return app.isPackaged;
}

function getDjvuResourcesBaseCandidates(moduleDir: string, cwd = process.cwd()) {
    return [
        join(cwd, 'resources'),
        join(moduleDir, '..', '..', 'resources'),
        join(moduleDir, '..', '..', '..', 'resources'),
    ];
}

function hasExpectedDjvuResources(resourcesBase: string, pathExists: (path: string) => boolean) {
    return pathExists(join(resourcesBase, DJVU_RESOURCE_NAME));
}

function resolveDjvuResourcesBase(
    moduleDir: string,
    isPackaged: boolean,
    options: IGetDjvuNativeToolsBaseOptions,
) {
    if (isPackaged) {
        return options.resourcesPath ?? process.resourcesPath;
    }

    const pathExists = options.exists ?? existsSync;
    const candidates = getDjvuResourcesBaseCandidates(moduleDir, options.cwd);
    const resolved = candidates.find(candidate => hasExpectedDjvuResources(candidate, pathExists));
    return resolved ?? candidates[0]!;
}

function getDjvuToolBinaryPath(
    dir: string,
    name: string,
    isPackaged: boolean,
    options: {
        exists?: (path: string) => boolean;
        platform?: NodeJS.Platform;
    } = {},
) {
    const platform = options.platform ?? process.platform;
    const pathExists = options.exists ?? existsSync;
    const ext = platform === 'win32' ? '.exe' : '';
    const binPath = join(dir, 'bin', `${name}${ext}`);

    if (pathExists(binPath)) {
        return binPath;
    }

    if (isPackaged) {
        return binPath;
    }

    return name;
}

export function getDjvuNativeToolsBase(
    moduleDir: string = __dirname,
    isPackaged: boolean = isElectronAppPackaged(),
    options: IGetDjvuNativeToolsBaseOptions = {},
) {
    const resourcesBase = resolveDjvuResourcesBase(moduleDir, isPackaged, options);

    return resolveNativeToolsBase(moduleDir, isPackaged, {
        resourcesBase,
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
}

export function resolveDjvuNativeToolPaths(options: IResolveDjvuNativeToolPathsOptions): IDjvuNativeToolPaths {
    const djvuDir = join(options.nativeToolsBase, DJVU_RESOURCE_NAME, options.platformArch);
    const binaryPathOptions = {
        ...(options.exists !== undefined ? { exists: options.exists } : {}),
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
    };

    return {
        ddjvu: getDjvuToolBinaryPath(djvuDir, 'ddjvu', options.isPackaged, binaryPathOptions),
        djvudump: getDjvuToolBinaryPath(djvuDir, 'djvudump', options.isPackaged, binaryPathOptions),
        djvused: getDjvuToolBinaryPath(djvuDir, 'djvused', options.isPackaged, binaryPathOptions),
    };
}

export function getDjvuNativeToolPaths(): IDjvuNativeToolPaths {
    const appIsPackaged = isElectronAppPackaged();
    return resolveDjvuNativeToolPaths({
        isPackaged: appIsPackaged,
        nativeToolsBase: getDjvuNativeToolsBase(__dirname, appIsPackaged),
        platformArch: resolvePlatformArchTag(),
    });
}
