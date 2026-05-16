import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildDjvuRuntimeEnv } from '@electron/djvu/paths';

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
