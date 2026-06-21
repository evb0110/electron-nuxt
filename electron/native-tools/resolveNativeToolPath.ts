import { existsSync } from 'fs';
import { join } from 'path';
import { resolveOcrResourcesBase } from '@electron/ocr/resolveOcrResourcesBase';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';

interface IResolveNativeToolPathOptions {
    binaryName: string;
    binaryRelativePath?: string[] | undefined;
    crateName: string;
    currentDir: string;
    envOverridePath?: string | undefined;
    exists?: ((path: string) => boolean) | undefined;
    includeRustTargetCandidates?: boolean | undefined;
    isPackaged: boolean;
    platformArch?: string | undefined;
    projectRoot?: string | undefined;
    resourcesBase?: string | undefined;
}

const RUST_TARGET_BY_PLATFORM_ARCH: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc',
};

export function getNativeToolPathCandidates(options: IResolveNativeToolPathOptions) {
    const projectRoot = options.projectRoot ?? process.cwd();
    const platformArch = options.platformArch ?? resolvePlatformArchTag();
    const resourcesBase = options.resourcesBase ?? resolveOcrResourcesBase(
        options.currentDir,
        options.isPackaged,
    );
    const rustTarget = RUST_TARGET_BY_PLATFORM_ARCH[platformArch];
    const binaryRelativePath = options.binaryRelativePath ?? [
        'bin',
        options.binaryName,
    ];
    const candidates = [
        join(resourcesBase, options.crateName, platformArch, ...binaryRelativePath),
        join(projectRoot, '.tmp', options.crateName, platformArch, ...binaryRelativePath),
    ];

    if (options.includeRustTargetCandidates === false) {
        return candidates;
    }

    if (rustTarget) {
        candidates.push(join(
            projectRoot,
            'native',
            options.crateName,
            'target',
            rustTarget,
            'release',
            options.binaryName,
        ));
    }

    candidates.push(join(
        projectRoot,
        'native',
        options.crateName,
        'target',
        'release',
        options.binaryName,
    ));

    return candidates;
}

export function resolveNativeToolPath(options: IResolveNativeToolPathOptions) {
    const pathExists = options.exists ?? existsSync;
    const overridePath = options.envOverridePath?.trim();
    if (overridePath && pathExists(overridePath)) {
        return overridePath;
    }

    return getNativeToolPathCandidates(options).find(candidate => pathExists(candidate)) ?? null;
}
