import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildDjvuRuntimeEnv } from '@electron/djvu/paths';
import {
    getDjvuNativeToolsBase,
    resolveDjvuNativeToolPaths,
} from '@electron/djvu/nativeToolPaths';

describe('DjVu native tool path boundary', () => {
    it('resolves ddjvu and djvused from the DjVuLibre resource root', () => {
        const djvuBase = path.join('/repo/resources/djvulibre/darwin-arm64');
        const existingPaths = new Set([
            path.join(djvuBase, 'bin', 'ddjvu'),
            path.join(djvuBase, 'bin', 'djvused'),
        ]);

        expect(resolveDjvuNativeToolPaths({
            exists: candidate => existingPaths.has(candidate),
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platform: 'darwin',
            platformArch: 'darwin-arm64',
        })).toEqual({
            ddjvu: path.join(djvuBase, 'bin', 'ddjvu'),
            djvused: path.join(djvuBase, 'bin', 'djvused'),
        });
    });

    it('keeps the existing development fallback to command names when bundled tools are absent', () => {
        expect(resolveDjvuNativeToolPaths({
            exists: () => false,
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platform: 'linux',
            platformArch: 'linux-x64',
        })).toEqual({
            ddjvu: 'ddjvu',
            djvused: 'djvused',
        });
    });

    it('keeps packaged DjVu binaries on the native-tools root', () => {
        expect(getDjvuNativeToolsBase('/app/Contents/Resources/app.asar/dist-electron/djvu', true, {
            platform: 'darwin',
            resourcesPath: '/app/Contents/Resources',
        })).toBe(path.join('/app/Contents/MacOS/native-tools'));
    });

    it('keeps the previous development DjVuLibre resource lookup order', () => {
        const currentDirectoryResource = path.join('/worktree/resources/djvulibre');
        const repoResource = path.join('/repo/resources/djvulibre');
        const skippedElectronResource = path.join('/repo/electron/resources/djvulibre');

        expect(getDjvuNativeToolsBase('/repo/electron/djvu', false, {
            cwd: '/worktree',
            exists: candidate => candidate === skippedElectronResource || candidate === repoResource,
        })).toBe(path.join('/repo/resources'));
        expect(getDjvuNativeToolsBase('/repo/electron/djvu', false, {
            cwd: '/worktree',
            exists: candidate => candidate === currentDirectoryResource,
        })).toBe(path.join('/worktree/resources'));
    });
});

describe('buildDjvuRuntimeEnv', () => {
    it('prepends DjVu bin and lib directories to PATH on Windows', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'win32',
            baseEnv: { Path: 'C:\\Windows\\System32' },
            binDir: 'C:\\bundle\\djvu\\bin',
            libDir: 'C:\\bundle\\djvu\\lib',
        });

        expect(env.Path).toBe('C:\\bundle\\djvu\\bin;C:\\bundle\\djvu\\lib;C:\\Windows\\System32');
    });

    it('normalizes mixed-case PATH keys on Windows to a single Path key', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'win32',
            baseEnv: {
                PATH: 'C:\\Windows\\System32',
                Path: 'C:\\Windows',
            },
            binDir: 'C:\\bundle\\djvu\\bin',
            libDir: 'C:\\bundle\\djvu\\lib',
        });

        expect(env.Path).toBe('C:\\bundle\\djvu\\bin;C:\\bundle\\djvu\\lib;C:\\Windows\\System32;C:\\Windows');
        expect(env.PATH).toBeUndefined();
    });

    it('prepends DjVu lib directory to Unix dynamic loader variables', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'linux',
            baseEnv: {
                LD_LIBRARY_PATH: '/usr/lib',
                DYLD_LIBRARY_PATH: '/opt/lib',
            },
            libDir: '/opt/evb/djvu/lib',
        });

        expect(env.LD_LIBRARY_PATH).toBe('/opt/evb/djvu/lib:/usr/lib');
        expect(env.DYLD_LIBRARY_PATH).toBe('/opt/evb/djvu/lib:/opt/lib');
    });

    it('adds a deterministic UTF-8 locale for Unix DjVuLibre filename decoding', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'darwin',
            baseEnv: {},
            libDir: '/opt/evb/djvu/lib',
        });

        expect(env.LC_ALL).toBe('C.UTF-8');
        expect(env.LC_CTYPE).toBe('C.UTF-8');
        expect(env.LANG).toBe('C.UTF-8');
    });

    it('overrides inherited Unix locale settings for DjVuLibre filename decoding', () => {
        const env = buildDjvuRuntimeEnv({
            platform: 'darwin',
            baseEnv: {
                LC_ALL: 'UTF-8',
                LC_CTYPE: 'en_US.UTF-8',
                LANG: 'en_US.UTF-8',
            },
            libDir: '/opt/evb/djvu/lib',
        });

        expect(env.LC_ALL).toBe('C.UTF-8');
        expect(env.LC_CTYPE).toBe('C.UTF-8');
        expect(env.LANG).toBe('C.UTF-8');
    });
});
