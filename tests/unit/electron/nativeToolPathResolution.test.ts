import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getNativeToolPathCandidates,
    resolveNativeToolPath,
} from '@electron/native-tools/resolveNativeToolPath';
import {
    getPageProcessorBinaryName,
    getPageProcessorBinaryRelativePath,
    getPageProcessorPathCandidates,
    resolvePageProcessorPath,
} from '@electron/native-tools/pageProcessorPath';

const baseOptions = {
    binaryName: 'evb-pdf-page-ops.exe',
    crateName: 'pdf-page-ops',
    currentDir: '/repo/electron/features/page-ops/main',
    isPackaged: false,
    platformArch: 'win32-arm64',
    projectRoot: '/repo',
    resourcesBase: '/repo/resources',
};

describe('native tool path resolution', () => {
    it('probes packaged resources, staged dev binaries, cross targets, and host release output', () => {
        expect(getNativeToolPathCandidates(baseOptions)).toEqual([
            path.join('/repo/resources', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe'),
            path.join('/repo', '.tmp', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe'),
            path.join('/repo', 'native', 'pdf-page-ops', 'target', 'aarch64-pc-windows-msvc', 'release', 'evb-pdf-page-ops.exe'),
            path.join('/repo', 'native', 'pdf-page-ops', 'target', 'release', 'evb-pdf-page-ops.exe'),
        ]);
    });

    it('prefers the override path when it exists', () => {
        expect(resolveNativeToolPath({
            ...baseOptions,
            envOverridePath: '/custom/evb-pdf-page-ops.exe',
            exists: candidate => candidate === '/custom/evb-pdf-page-ops.exe',
        })).toBe('/custom/evb-pdf-page-ops.exe');
    });

    it('falls through to the staged dev binary before raw Cargo outputs', () => {
        const stagedPath = path.join('/repo', '.tmp', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe');
        const crossTargetPath = path.join('/repo', 'native', 'pdf-page-ops', 'target', 'aarch64-pc-windows-msvc', 'release', 'evb-pdf-page-ops.exe');

        expect(resolveNativeToolPath({
            ...baseOptions,
            exists: candidate => candidate === stagedPath || candidate === crossTargetPath,
        })).toBe(stagedPath);
    });

    it('supports nested non-Rust binary layouts without Cargo fallbacks', () => {
        expect(getNativeToolPathCandidates({
            ...baseOptions,
            binaryName: 'page-processor.exe',
            binaryRelativePath: [
                'bin',
                'page-processor',
                'page-processor.exe',
            ],
            crateName: 'page-processing',
            includeRustTargetCandidates: false,
        })).toEqual([
            path.join('/repo/resources', 'page-processing', 'win32-arm64', 'bin', 'page-processor', 'page-processor.exe'),
            path.join('/repo', '.tmp', 'page-processing', 'win32-arm64', 'bin', 'page-processor', 'page-processor.exe'),
        ]);
    });
});

describe('page-processor path resolution', () => {
    it('uses the PyInstaller onedir binary layout under resource and staged dev roots', () => {
        expect(getPageProcessorPathCandidates({
            currentDir: '/repo/electron/native-tools',
            isPackaged: true,
            platformArch: 'win32-arm64',
            projectRoot: '/repo',
            resourcesBase: '/app/resources',
        })).toEqual([
            path.join('/app/resources', 'page-processing', 'win32-arm64', 'bin', 'page-processor', 'page-processor.exe'),
            path.join('/repo', '.tmp', 'page-processing', 'win32-arm64', 'bin', 'page-processor', 'page-processor.exe'),
        ]);
    });

    it('keeps the nested binary relative path explicit for callers that need packaging checks', () => {
        expect(getPageProcessorBinaryRelativePath('page-processor.exe')).toEqual([
            'bin',
            'page-processor',
            'page-processor.exe',
        ]);
    });

    it('resolves the first existing nested page-processor candidate', () => {
        const resourcePath = path.join('/repo/resources', 'page-processing', 'darwin-arm64', 'bin', 'page-processor', 'page-processor');
        const stagedPath = path.join('/repo', '.tmp', 'page-processing', 'darwin-arm64', 'bin', 'page-processor', 'page-processor');

        expect(resolvePageProcessorPath({
            currentDir: '/repo/electron/native-tools',
            isPackaged: false,
            platform: 'darwin',
            platformArch: 'darwin-arm64',
            projectRoot: '/repo',
            resourcesBase: '/repo/resources',
            exists: candidate => candidate === resourcePath || candidate === stagedPath,
        })).toBe(resourcePath);
    });

    it('supports the existing EVB_PAGE_PROCESSOR override and the native-tool PATH override name', () => {
        expect(resolvePageProcessorPath({
            currentDir: '/repo/electron/native-tools',
            env: {
                EVB_PAGE_PROCESSOR: '/old/page-processor',
                EVB_PAGE_PROCESSOR_PATH: '/new/page-processor',
            },
            isPackaged: false,
            platform: 'darwin',
            platformArch: 'darwin-arm64',
            projectRoot: '/repo',
            resourcesBase: '/repo/resources',
            exists: candidate => candidate === '/new/page-processor',
        })).toBe('/new/page-processor');

        expect(resolvePageProcessorPath({
            currentDir: '/repo/electron/native-tools',
            env: {EVB_PAGE_PROCESSOR: '/old/page-processor'},
            isPackaged: false,
            platform: 'darwin',
            platformArch: 'darwin-arm64',
            projectRoot: '/repo',
            resourcesBase: '/repo/resources',
            exists: candidate => candidate === '/old/page-processor',
        })).toBe('/old/page-processor');
    });

    it('uses the platform arch tag to choose the Windows executable name', () => {
        expect(getPageProcessorBinaryName('win32')).toBe('page-processor.exe');
        expect(getPageProcessorPathCandidates({
            currentDir: '/repo/electron/native-tools',
            isPackaged: false,
            platformArch: 'win32-x64',
            projectRoot: '/repo',
            resourcesBase: '/repo/resources',
        })[0]).toBe(path.join(
            '/repo/resources',
            'page-processing',
            'win32-x64',
            'bin',
            'page-processor',
            'page-processor.exe',
        ));
    });
});
