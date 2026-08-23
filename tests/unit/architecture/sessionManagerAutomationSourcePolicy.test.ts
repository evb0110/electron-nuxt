import {readFile} from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('session manager automation source policy', () => {
    it('wires isolated artifact directories into Nuxt and Vite configuration', async () => {
        const source = await readFile('nuxt.config.ts', 'utf8');

        expect(source).toContain('process.env.EVB_NUXT_BUILD_DIR?.trim()');
        expect(source).toContain('{buildDir: isolatedNuxtBuildDir}');
        expect(source).toContain('process.env.EVB_NUXT_OUTPUT_DIR?.trim()');
        expect(source).toContain('dir: isolatedNuxtOutputDir');
        expect(source).toContain('publicDir: `${isolatedNuxtOutputDir}/public`');
        expect(source).toContain('serverDir: `${isolatedNuxtOutputDir}/server`');
        expect(source).toContain('process.env.EVB_NUXT_VITE_CACHE_DIR?.trim()');
        expect(source).toContain('{cacheDir: isolatedNuxtViteCacheDir}');
    });
});
