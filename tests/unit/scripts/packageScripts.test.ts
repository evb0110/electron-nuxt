import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type { PackageJson } from 'type-fest';

type TPackageJsonWithScripts = PackageJson & { scripts: Record<string, string> };

const removedScriptNames = [
    'test:smoke',
    'gate:pre-release',
    [
        'test',
        'integration',
    ].join(':'),
];

async function readPackageJson(): Promise<TPackageJsonWithScripts> {
    const packageJson = JSON.parse(
        await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as PackageJson;
    if (!packageJson.scripts) {
        throw new Error('Missing package scripts');
    }

    return packageJson as TPackageJsonWithScripts;
}

function getPackageScripts(packageJson: PackageJson) {
    const scripts = packageJson.scripts;
    if (!scripts) {
        throw new Error('Missing package scripts');
    }
    return scripts;
}

function scriptCommands(packageJson: PackageJson, scriptName: string) {
    const script = getPackageScripts(packageJson)[scriptName];
    if (script === undefined) {
        throw new Error(`Missing package script: ${scriptName}`);
    }

    return script.split(/\s*&&\s*/u)
        .map(command => command.trim())
        .filter(Boolean);
}

function scriptRunTargets(packageJson: PackageJson, scriptName: string) {
    const script = getPackageScripts(packageJson)[scriptName];
    if (script === undefined) {
        throw new Error(`Missing package script: ${scriptName}`);
    }

    return Array.from(script.matchAll(/(?:^|\s)pnpm\s+run\s+([^\s&]+)/gu))
        .flatMap(match => match[1] !== undefined ? [match[1]] : []);
}

describe('package scripts', () => {
    it('keeps the web build output checked after Nuxt build artifacts are pruned', async () => {
        const packageJson = await readPackageJson();

        expect(scriptCommands(packageJson, 'build')).toEqual([
            'pnpm exec nuxi build',
            'node scripts/prune-build-artifacts.mjs',
            'node scripts/check-web-deploy-assets.mjs',
        ]);
    });

    it('keeps desktop builds staging every Rust native tool', async () => {
        const packageJson = await readPackageJson();

        expect(scriptRunTargets(packageJson, 'build:desktop')).toEqual([
            'check:wasm:portable',
            'build',
            'build:electron',
            'build:pdf-image-combine',
            'build:pdf-page-ops',
            'build:pdf-search',
        ]);
    });

    it('keeps dependency lockstep checks in lint', async () => {
        const packageJson = await readPackageJson();

        expect(scriptRunTargets(packageJson, 'lint')).toEqual(expect.arrayContaining([
            'check:css-custom-properties',
            'check:web-deploy-source',
            'check:dependency-lockstep',
            'check:naming',
        ]));
        expect(getPackageScripts(packageJson).lint).not.toContain('|| true');
    });

    it('keeps focused release and diagnostic test scripts mapped to first-class commands', async () => {
        const packageJson = await readPackageJson();

        expect(packageJson.scripts['test:coverage']).toBe('pnpm run test:coverage:run && pnpm run check:coverage-ratchet');
        expect(packageJson.scripts['release:verify']).toBe('node scripts/release/verify-local.mjs');
        expect(packageJson.scripts.test).toBe('vitest run --project unit');
        expect(packageJson.scripts['test:unit']).toBe('vitest run --project unit');
        expect(packageJson.scripts['test:coverage:run']).toBe('vitest run --coverage --project unit');
        expect(packageJson.scripts['test:bundle-integrity']).toBe('pnpm run build:electron && vitest run --project bundle-integrity && node scripts/prune-build-artifacts.mjs && pnpm run check:build-artifacts:hygiene');
        expect(packageJson.scripts['check:coverage-ratchet']).toBe('pnpm exec tsx scripts/checkCoverageRatchet.ts');
        expect(packageJson.scripts['check:coverage-ratchet:update']).toBe('pnpm exec tsx scripts/checkCoverageRatchet.ts --update-baseline');
        expect(packageJson.scripts['test:python-page-processor']).toBe('python3 scripts/check-page-processor-smoke.py');
        expect(packageJson.scripts['check:wasm:freshness']).toBe('node scripts/check-wasm-freshness.mjs --mode=strict');
        expect(packageJson.scripts['check:wasm:portable']).toBe('node scripts/check-wasm-freshness.mjs --mode=portable');
        expect(scriptCommands(packageJson, 'test:e2e:electron')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:smoke:no-build',
        ]);
        expect(packageJson.scripts['test:e2e:electron:smoke:no-build']).toBe('vitest run --project e2e-smoke --reporter verbose');
        expect(scriptCommands(packageJson, 'test:e2e:electron:draw-shapes')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:draw-shapes:no-build',
        ]);
        expect(packageJson.scripts['test:e2e:electron:draw-shapes:no-build']).toBe('vitest run --project e2e-draw-shapes --reporter verbose');
        expect(scriptCommands(packageJson, 'test:e2e:electron:quarantine')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:quarantine:no-build',
        ]);
        expect(packageJson.scripts['test:e2e:electron:quarantine:no-build']).toBe('vitest run --project e2e-quarantine --passWithNoTests --reporter verbose');
        expect(scriptCommands(packageJson, 'test:e2e:electron:rapid-navigation')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:rapid-navigation:no-build',
        ]);
        expect(packageJson.scripts['test:e2e:electron:rapid-navigation:no-build']).toBe('vitest run --project e2e-rapid-navigation --reporter verbose');
        expect(scriptCommands(packageJson, 'diag:pdf-navigation-blink-trace')).toEqual([
            'pnpm run build:electron',
            'pnpm exec tsx scripts/diagnostics/pdfNavigationBlinkTrace.ts',
        ]);
        expect(scriptCommands(packageJson, 'diag:pdf-skeleton-navigation')).toEqual([
            'pnpm run build:electron',
            'pnpm exec tsx scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts',
        ]);
        expect(scriptCommands(packageJson, 'diag:arnold-pdf-open')).toEqual([
            'pnpm run build:electron',
            'pnpm exec tsx scripts/diagnostics/runArnoldPdfOpenDiagnostics.ts',
        ]);
    });

    it('keeps opt-in fixture and PDF tab diagnostic tripwires explicit', async () => {
        const packageJson = await readPackageJson();
        const largeFixtureScript = packageJson.scripts['test:e2e:electron:large'] ?? '';
        const largeFixtureNoBuildScript = packageJson.scripts['test:e2e:electron:large:no-build'] ?? '';
        const pdfTabsCiScript = packageJson.scripts['diag:pdf-tabs:ci'] ?? '';

        expect(largeFixtureScript).toContain('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1');
        expect(largeFixtureScript).toContain('pnpm run test:e2e:electron:large:no-build');
        expect(largeFixtureScript).not.toContain('EVB_E2E_LARGE_PDF=1');
        expect(largeFixtureScript).not.toContain('EVB_E2E_LARGE_PDF_ANNOTATION_SAVE=1');
        expect(largeFixtureNoBuildScript).toBe('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1 vitest run --project e2e-large-pdf --reporter verbose');
        expect(pdfTabsCiScript).toContain('pdf-tabs-ci');
        expect(pdfTabsCiScript).toContain('pnpm diag:pdf-tabs --session pdf-tabs-ci');
        expect(pdfTabsCiScript).toContain('--max-inactive-canvases 0');
        expect(pdfTabsCiScript).toContain('--max-inactive-rendered-pages 0');
        expect(pdfTabsCiScript).toContain('--max-inactive-djvu-images 0');
        expect(pdfTabsCiScript).toContain('--max-inactive-canvas-pixels 0');
    });

    it('keeps informational fallow health out of failing gates', async () => {
        const packageJson = await readPackageJson();

        expect(scriptRunTargets(packageJson, 'fallow:all')).toEqual([
            'fallow',
            'fallow:dupes',
        ]);
        expect(packageJson.scripts['fallow:all']).not.toContain('fallow:health');
        expect(packageJson.scripts['fallow:health:summary']).toBe('fallow health --summary || true');
    });

    it('keeps obsolete pseudo-gates removed from package scripts', async () => {
        const packageJson = await readPackageJson();

        for (const scriptName of removedScriptNames) {
            expect(packageJson.scripts[scriptName]).toBeUndefined();
        }
    });
});
