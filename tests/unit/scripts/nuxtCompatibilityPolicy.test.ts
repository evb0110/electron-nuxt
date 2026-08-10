import { readFile } from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';

async function readProjectFile(path: string) {
    return readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

describe('Nuxt compatibility policy', () => {
    it('pins Nuxt 4.5.2 in both independently deployed applications', async () => {
        const rootPackage = JSON.parse(await readProjectFile('package.json')) as {devDependencies?: Record<string, string>;};
        const landingPackage = JSON.parse(await readProjectFile('landing/package.json')) as {dependencies?: Record<string, string>;};
        const lockfile = await readProjectFile('pnpm-lock.yaml');

        expect(rootPackage.devDependencies?.nuxt).toBe('4.5.2');
        expect(landingPackage.dependencies?.nuxt).toBe('4.5.2');
        expect(lockfile).toContain('nuxt@4.5.2:');
        expect(lockfile).not.toContain('nuxt@4.5.1:');
    });

    it('keeps compatibility v5 opt-in for both configs', async () => {
        const rootConfig = await readProjectFile('nuxt.config.ts');

        for (const configPath of [
            'nuxt.config.ts',
            'landing/nuxt.config.ts',
        ]) {
            const config = await readProjectFile(configPath);
            expect(config).toContain('process.env.EVB_NUXT_COMPATIBILITY_VERSION === \'5\'');
            expect(config).toContain('enableNuxtCompatibilityV5 ? {future: {compatibilityVersion: 5 as const}} : {}');
        }

        expect(rootConfig).toContain('noUncheckedSideEffectImports: false');
        expect(rootConfig).toContain('worker: {format: \'es\'}');
        expect(rootConfig).toContain('EVB_NUXT_VITE_CACHE_DIR');
    });

    it('runs an advisory root and landing typecheck lane', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const job = workflow.match(/ {2}nuxt_compatibility_v5:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_]+:|$)/u)?.[1] ?? '';

        expect(job).toContain('continue-on-error: true');
        expect(job).toContain('fail-fast: false');
        expect(job).toContain('project: [root, landing]');
        expect(job).toContain('EVB_NUXT_COMPATIBILITY_VERSION: \'5\'');
        expect(job).toContain('node scripts/run-nuxt-typecheck.mjs');
        expect(job).toContain('node scripts/run-nuxt-typecheck.mjs landing');
        expect(job).toContain('nuxt-compat-v5-root');
        expect(job).toContain('nuxt-compat-v5-landing');
    });
});
