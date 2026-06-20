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
});
