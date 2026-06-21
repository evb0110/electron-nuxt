import { dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    getNativeToolPathCandidates,
    resolveNativeToolPath,
} from '@electron/native-tools/resolveNativeToolPath';

interface IResolvePageProcessorPathOptions {
    currentDir?: string;
    env?: NodeJS.ProcessEnv;
    envOverridePath?: string;
    exists?: (path: string) => boolean;
    isPackaged?: boolean;
    platform?: NodeJS.Platform;
    platformArch?: string;
    projectRoot?: string;
    resourcesBase?: string;
}

const PAGE_PROCESSOR_RESOURCE_ROOT = 'page-processing';
const PAGE_PROCESSOR_ONEDIR_NAME = 'page-processor';
const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');

function platformFromPlatformArch(platformArch: string | undefined): NodeJS.Platform {
    if (platformArch?.startsWith('win32-')) {
        return 'win32';
    }
    if (platformArch?.startsWith('darwin-')) {
        return 'darwin';
    }
    if (platformArch?.startsWith('linux-')) {
        return 'linux';
    }
    return process.platform;
}

export function getPageProcessorBinaryName(platform: NodeJS.Platform = process.platform) {
    return platform === 'win32'
        ? 'page-processor.exe'
        : 'page-processor';
}

export function getPageProcessorBinaryRelativePath(binaryName = getPageProcessorBinaryName()) {
    return [
        'bin',
        PAGE_PROCESSOR_ONEDIR_NAME,
        binaryName,
    ];
}

function getPageProcessorEnvOverridePath(env: NodeJS.ProcessEnv) {
    return env.EVB_PAGE_PROCESSOR_PATH ?? env.EVB_PAGE_PROCESSOR;
}

function createPageProcessorResolverOptions(options: IResolvePageProcessorPathOptions = {}) {
    const platform = options.platform ?? platformFromPlatformArch(options.platformArch);
    const binaryName = getPageProcessorBinaryName(platform);
    const envOverridePath = options.envOverridePath ?? getPageProcessorEnvOverridePath(options.env ?? process.env);

    return {
        binaryName,
        binaryRelativePath: getPageProcessorBinaryRelativePath(binaryName),
        crateName: PAGE_PROCESSOR_RESOURCE_ROOT,
        currentDir: options.currentDir ?? __dirname,
        envOverridePath,
        exists: options.exists,
        includeRustTargetCandidates: false,
        isPackaged: options.isPackaged ?? isPackaged,
        platformArch: options.platformArch,
        projectRoot: options.projectRoot,
        resourcesBase: options.resourcesBase,
    };
}

export function getPageProcessorPathCandidates(options: IResolvePageProcessorPathOptions = {}) {
    return getNativeToolPathCandidates(createPageProcessorResolverOptions(options));
}

export function resolvePageProcessorPath(options: IResolvePageProcessorPathOptions = {}) {
    return resolveNativeToolPath(createPageProcessorResolverOptions(options));
}
