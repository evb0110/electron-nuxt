import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    PackageJson,
    SetRequired,
    Simplify,
} from 'type-fest';

type TPackageJsonWithScripts = Simplify<SetRequired<PackageJson, 'scripts'>>;

const removedScriptNames = [
    'test:smoke',
    'gate:pre-release',
    'test:e2e:electron:smoke',
    'test:e2e:electron:smoke:no-build',
    [
        'test',
        'integration',
    ].join(':'),
];

const unitTestProjects = [
    'unit-core',
    'unit-app',
    'unit-electron',
    'unit-scripts',
    'unit-policy',
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

function packageScript(packageJson: PackageJson, scriptName: string) {
    const script = getPackageScripts(packageJson)[scriptName];
    if (script === undefined) {
        throw new Error(`Missing package script: ${scriptName}`);
    }

    return script;
}

function scriptCommands(packageJson: PackageJson, scriptName: string) {
    return packageScript(packageJson, scriptName).split(/\s*&&\s*/u)
        .map(command => command.trim())
        .filter(Boolean);
}

function scriptRunTargets(packageJson: PackageJson, scriptName: string) {
    return Array.from(packageScript(packageJson, scriptName).matchAll(/(?:^|\s)pnpm\s+run\s+([^\s&]+)/gu))
        .flatMap(match => match[1] !== undefined ? [match[1]] : []);
}

function scriptAndNestedRunTargets(
    packageJson: PackageJson,
    scriptName: string,
    seen = new Set<string>(),
): string[] {
    if (seen.has(scriptName)) {
        return [];
    }
    seen.add(scriptName);

    const scripts = getPackageScripts(packageJson);

    return scriptRunTargets(packageJson, scriptName).flatMap((target) => [
        target,
        ...(scripts[target] === undefined
            ? []
            : scriptAndNestedRunTargets(packageJson, target, seen)),
    ]);
}

function scriptAndNestedCommandText(packageJson: PackageJson, scriptName: string) {
    return [
        scriptName,
        ...scriptAndNestedRunTargets(packageJson, scriptName),
    ]
        .filter((target, index, allTargets) => allTargets.indexOf(target) === index)
        .flatMap((target) => {
            const script = getPackageScripts(packageJson)[target];
            return script === undefined ? [] : [script];
        })
        .join('\n');
}

function scriptVitestProjects(packageJson: PackageJson, scriptName: string) {
    return Array.from(packageScript(packageJson, scriptName).matchAll(/(?:^|\s)--project(?:=|\s+)([^\s]+)/gu))
        .flatMap(match => match[1] !== undefined ? [match[1]] : []);
}

function scriptAndNestedVitestProjects(packageJson: PackageJson, scriptName: string) {
    return [
        scriptName,
        ...scriptAndNestedRunTargets(packageJson, scriptName),
    ].flatMap(target => getPackageScripts(packageJson)[target] === undefined
        ? []
        : scriptVitestProjects(packageJson, target));
}

function expectSelectsSplitUnitProjects(packageJson: PackageJson, scriptName: string) {
    const projects = scriptAndNestedVitestProjects(packageJson, scriptName);

    expect(projects).not.toContain('unit');
    if (projects.includes('unit-*')) {
        expect(projects).toEqual(['unit-*']);
        return;
    }

    expect(projects).toEqual(unitTestProjects);
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

    it('keeps desktop builds separating wasm freshness checks from native staging', async () => {
        const packageJson = await readPackageJson();
        const scripts = getPackageScripts(packageJson);

        expect(scriptRunTargets(packageJson, 'build:desktop')).toEqual([
            'check:wasm:portable',
            'build:desktop:no-wasm-check',
        ]);
        expect(scriptRunTargets(packageJson, 'build:desktop:no-wasm-check')).toEqual([
            'build',
            'build:electron',
            'build:pdf-image-combine',
            'build:pdf-page-ops',
            'build:pdf-search',
        ]);
        expect(scripts['build:strict']).toBe('node scripts/run-build-strict.mjs');
        expect(scripts['build:strict:no-wasm-check']).toBe('node scripts/run-build-strict.mjs --skip-wasm-check');
    });

    it('keeps split lint scripts running dependency and generated-source checks', async () => {
        const packageJson = await readPackageJson();
        const scripts = getPackageScripts(packageJson);
        const lintTargets = scriptRunTargets(packageJson, 'lint');
        const lintFixTargets = scriptRunTargets(packageJson, 'lint:fix');
        const lintCommandText = scriptAndNestedCommandText(packageJson, 'lint');
        const lintFixCommandText = scriptAndNestedCommandText(packageJson, 'lint:fix');

        expect(lintTargets).toEqual([
            'lint:eslint',
            'lint:style',
            'check:static:fast',
        ]);
        expect(lintFixTargets).toEqual([
            'lint:eslint:fix',
            'lint:style:fix',
            'check:static:fast',
        ]);
        expect(scripts['lint:eslint']).toContain('eslint app electron packages scripts server tests');
        expect(scripts['lint:eslint']).toContain('--max-warnings=0 --report-unused-disable-directives');
        expect(scripts['lint:eslint:cache']).toContain('eslint app electron packages scripts server tests');
        expect(scripts['lint:eslint:cache']).toContain('--cache --cache-location .cache/eslint/');
        expect(scripts['lint:eslint:cache']).not.toContain('pnpm run lint:eslint -- --cache');
        expect(lintCommandText).toContain('stylelint "app/**/*.{vue,scss,css}"');
        expect(lintFixCommandText).toContain('--fix --max-warnings=0');
        expect(lintFixCommandText).toContain('stylelint "app/**/*.{vue,scss,css}" --fix');
        expect(scriptAndNestedRunTargets(packageJson, 'lint')).toEqual(expect.arrayContaining([
            'check:platform-api-generated',
            'check:style-assets',
            'check:pdfjs-viewer-css',
            'check:css-custom-properties',
            'check:css-important',
            'check:locales',
            'check:icons:bundle',
            'check:commonjs-imports',
            'check:dependency-lockstep',
            'check:native-tool-protocols',
            'check:naming',
            'check:architecture:imports',
        ]));
        expect(scripts['check:native-tool-protocols']).toBe('pnpm exec tsx scripts/checkNativeToolProtocols.ts');
        expect(scriptRunTargets(packageJson, 'check:static:assets')).toEqual([
            'check:web-deploy-source',
            'check:ocr-language-model-registry',
            'check:vendor-sync',
        ]);
        expect(scriptRunTargets(packageJson, 'check:static:reports')).toEqual(['check:platform-manifest-consumers:report']);
        expect(lintCommandText).not.toContain('|| true');
        expect(lintCommandText).not.toContain('landing');
        expect(lintCommandText).not.toContain(':all');
    });

    it('keeps landing style checks opt-in outside main lint', async () => {
        const packageJson = await readPackageJson();
        const scripts = getPackageScripts(packageJson);
        const lintAllCommandText = scriptAndNestedCommandText(packageJson, 'lint:all');

        expect(scripts['check:style-assets']).toBe('pnpm exec tsx scripts/checkStyleAssetConventions.ts --target=app');
        expect(scripts['check:style-assets:landing']).toBe('pnpm exec tsx scripts/checkStyleAssetConventions.ts --target=landing');
        expect(scripts['check:style-assets:all']).toBe('pnpm exec tsx scripts/checkStyleAssetConventions.ts --target=all');
        expect(scripts['check:css-important']).toBe('pnpm exec tsx scripts/checkCssImportantPolicy.ts --target=app');
        expect(scripts['check:css-important:landing']).toBe('pnpm exec tsx scripts/checkCssImportantPolicy.ts --target=landing');
        expect(scripts['check:css-important:all']).toBe('pnpm exec tsx scripts/checkCssImportantPolicy.ts --target=all');
        expect(scriptRunTargets(packageJson, 'lint:all')).toEqual([
            'lint:eslint',
            'lint:style',
            'check:static:fast:all',
            'check:static:reports',
            'check:static:assets',
        ]);
        expect(scriptAndNestedRunTargets(packageJson, 'lint:all')).toEqual(expect.arrayContaining([
            'check:style-assets:all',
            'check:css-important:all',
        ]));
        expect(scriptAndNestedRunTargets(packageJson, 'lint:all')).toEqual(expect.arrayContaining([
            'check:locales:all',
            'check:icons:bundle:all',
            'check:naming:all',
        ]));
        expect(lintAllCommandText).toContain('pnpm --dir landing run lint');
    });

    it('keeps focused release and diagnostic test scripts mapped to first-class commands', async () => {
        const packageJson = await readPackageJson();
        const scripts = getPackageScripts(packageJson);

        expect(scriptCommands(packageJson, 'validate')).toEqual([
            'pnpm run lint',
            'pnpm run check:static:reports',
            'pnpm run check:static:assets',
            'pnpm run typecheck',
            'pnpm run test:unit',
            'pnpm run typecheck:coverage',
            'pnpm run build:strict',
            'pnpm run fallow:all',
        ]);
        expect(scriptRunTargets(packageJson, 'typecheck')).toEqual([
            'typecheck:app',
            'typecheck:electron',
            'typecheck:tests',
            'typecheck:scripts',
            'typecheck:packages',
            'typecheck:server',
        ]);
        expect(scripts['typecheck:packages']).toBe('node scripts/run-workspace-package-typecheck.mjs');
        expect(scripts['test:coverage']).toBe('pnpm run test:coverage:run && pnpm run check:coverage-ratchet');
        expect(scripts['release:verify']).toBe('node scripts/release/verify-local.mjs');
        expectSelectsSplitUnitProjects(packageJson, 'test');
        expectSelectsSplitUnitProjects(packageJson, 'test:unit');
        expectSelectsSplitUnitProjects(packageJson, 'test:coverage:run');
        expectSelectsSplitUnitProjects(packageJson, 'test:changed');
        expect(scripts['test:coverage:run']).toContain('--coverage');
        expect(scripts['test:changed']).toContain('--changed');
        expect(scriptCommands(packageJson, 'test:bundle-integrity')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:bundle-integrity:no-build',
            'node scripts/prune-build-artifacts.mjs',
            'pnpm run check:build-artifacts:hygiene',
        ]);
        expect(scripts['test:bundle-integrity:no-build']).toBe('vitest run --project bundle-integrity');
        expect(scripts['release:artifacts']).toBe('HUSKY=0 node scripts/release/build-artifacts.mjs');
        expect(scripts['db:generate']).toBe('pnpm --dir landing exec drizzle-kit generate --config ../drizzle.config.ts');
        expect(scripts['db:migrate']).toBe('pnpm --dir landing exec drizzle-kit migrate --config ../drizzle.config.ts');
        expect(scripts['db:check']).toBe('pnpm --dir landing exec drizzle-kit check --config ../drizzle.config.ts');
        expect(scripts['check:coverage-ratchet']).toBe('pnpm exec tsx scripts/checkCoverageRatchet.ts');
        expect(scripts['check:coverage-ratchet:update']).toBe('pnpm exec tsx scripts/checkCoverageRatchet.ts --update-baseline');
        expect(scripts['check:drizzle-schema']).toBe('node scripts/check-drizzle-schema.mjs');
        expect(scripts['check:electron-builder:asar-unpack']).toBe('node scripts/check-electron-builder-asar-unpack.mjs');
        expect(scripts['check:generated-native-resources:host']).toBe('node scripts/check-generated-native-resources.mjs --host');
        expect(scripts['check:pdfjs-viewer-css']).toBe('node scripts/sync-pdfjs-viewer-css.mjs --check');
        expect(scripts['release:resume']).toBe('HUSKY=0 node scripts/release/cut-release.mjs --resume');
        expect(scripts['test:python-page-processor']).toBe('python3 scripts/check-page-processor-smoke.py');
        expect(scripts['check:wasm:freshness']).toBe('node scripts/check-wasm-freshness.mjs --mode=strict');
        expect(scripts['check:wasm:portable']).toBe('node scripts/check-wasm-freshness.mjs --mode=portable');
        expect(scripts['check:architecture:dep-graph']).toBe('node scripts/architecture/dep-graph.mjs --scope=focused --output=.tmp/dep-graph.json');
        expect(scripts['check:architecture:boundaries']).toBe('node scripts/architecture/boundary-check.mjs --scope=focused');
        expect(scripts['check:architecture:source-size']).toBe('node scripts/architecture/source-size-check.mjs');
        expect(scriptCommands(packageJson, 'test:e2e:electron')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:regression:no-build',
        ]);
        expect(scriptCommands(packageJson, 'test:e2e:electron:regression')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:regression:no-build',
        ]);
        expect(scripts['test:e2e:electron:regression:no-build']).toBe('vitest run --project e2e-regression --reporter verbose');
        expect(scripts['test:e2e:electron:watch']).toBe('vitest --project e2e-regression --reporter verbose');
        expect(scriptCommands(packageJson, 'test:e2e:electron:draw-shapes')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:draw-shapes:no-build',
        ]);
        expect(scripts['test:e2e:electron:draw-shapes:no-build']).toBe('vitest run --project e2e-draw-shapes --reporter verbose');
        expect(scriptCommands(packageJson, 'test:e2e:electron:quarantine')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:quarantine:no-build',
        ]);
        expect(scripts['test:e2e:electron:quarantine:no-build']).toBe('vitest run --project e2e-quarantine --passWithNoTests --reporter verbose');
        expect(scriptCommands(packageJson, 'test:e2e:electron:rapid-navigation')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:rapid-navigation:no-build',
        ]);
        expect(scripts['test:e2e:electron:rapid-navigation:no-build']).toBe('vitest run --project e2e-rapid-navigation --reporter verbose');
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
