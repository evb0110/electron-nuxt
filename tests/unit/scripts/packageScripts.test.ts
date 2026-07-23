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
            'build:scan-cleanup',
        ]);
        for (const tool of [
            'pdf-image-combine',
            'pdf-page-ops',
            'pdf-search',
            'scan-cleanup',
        ]) {
            expect(scripts[`build:${tool}`]).toBe(`node scripts/build-native-tool.mjs ${tool}`);
        }
        expect(scripts['build:pdf-image-combine-wasm']).toBe(
            'node scripts/build-wasm-tool.mjs pdf-image-combine',
        );
        expect(scripts['build:pdf-page-ops-wasm']).toBe(
            'node scripts/build-wasm-tool.mjs pdf-page-ops',
        );
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
            'check:locales',
            'check:icons:bundle',
            'check:dependency-lockstep',
            'check:native-tool-protocols',
            'check:architecture:imports',
        ]));
        expect(scriptAndNestedRunTargets(packageJson, 'lint')).not.toEqual(expect.arrayContaining([
            'check:css-custom-properties',
            'check:css-important',
            'check:commonjs-imports',
            'check:layout-tokens',
            'check:naming',
        ]));
        expect(scripts['check:native-tool-protocols']).toBe('node --import tsx scripts/checkNativeToolProtocols.ts');
        expect(scriptRunTargets(packageJson, 'check:static:assets')).toEqual([
            'check:web-deploy-source',
            'check:ocr-language-model-registry',
            'check:vendor-sync',
        ]);
        expect(scriptRunTargets(packageJson, 'check:static:reports')).toEqual(['check:platform-manifest-consumers']);
        expect(lintCommandText).not.toContain('|| true');
        expect(lintCommandText).not.toContain('landing');
        expect(lintCommandText).not.toContain(':all');
    });

    it('keeps landing style checks opt-in outside main lint', async () => {
        const packageJson = await readPackageJson();
        const scripts = getPackageScripts(packageJson);
        const lintAllCommandText = scriptAndNestedCommandText(packageJson, 'lint:all');

        expect(scripts['check:style-assets']).toBe('node --import tsx scripts/checkStyleAssetConventions.ts --target=app');
        expect(scripts['check:style-assets:landing']).toBe('node --import tsx scripts/checkStyleAssetConventions.ts --target=landing');
        expect(scripts['check:style-assets:all']).toBe('node --import tsx scripts/checkStyleAssetConventions.ts --target=all');
        expect(scripts['check:css-important']).toBe('pnpm run lint:style');
        expect(scripts['check:css-important:landing']).toBe('stylelint "landing/app/**/*.{vue,scss,css}"');
        expect(scripts['check:css-important:all']).toBe('pnpm run lint:style:all');
        expect(scriptRunTargets(packageJson, 'lint:all')).toEqual([
            'lint:eslint',
            'lint:style:all',
            'check:static:fast:all',
            'check:static:reports',
            'check:static:assets',
        ]);
        expect(scriptAndNestedRunTargets(packageJson, 'lint:all')).toEqual(expect.arrayContaining(['check:style-assets:all']));
        expect(scriptAndNestedRunTargets(packageJson, 'lint:all')).toEqual(expect.arrayContaining([
            'check:locales:all',
            'check:icons:bundle:all',
            'check:naming:landing',
        ]));
        expect(scripts['check:naming:landing']).toBe(
            'EVB_ESLINT_NAMING_ONLY=1 eslint landing --no-ignore --max-warnings=0',
        );
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
        expect(scripts['typecheck:electron']).toBe('node scripts/run-ts7-typecheck.mjs -p electron/tsconfig.json');
        expect(scripts['typecheck:tests']).toBe('node scripts/run-ts7-typecheck.mjs -p tests/tsconfig.json');
        expect(scripts['typecheck:scripts']).toBe('node scripts/run-ts7-typecheck.mjs -p tsconfig.scripts.json');
        expect(scripts['typecheck:packages']).toBe('node scripts/run-workspace-package-typecheck.mjs');
        expect(scripts['typecheck:server']).toBe('node scripts/run-ts7-typecheck.mjs -p server/tsconfig.json');
        expect(scripts['test:coverage']).toBe('pnpm run test:coverage:run && pnpm run check:coverage:ratchet && pnpm run check:coverage:zero-execution');
        expect(scripts['release:verify']).toBe('node scripts/release/verify-local.mjs');
        expectSelectsSplitUnitProjects(packageJson, 'test');
        expectSelectsSplitUnitProjects(packageJson, 'test:unit');
        expectSelectsSplitUnitProjects(packageJson, 'test:coverage:run');
        expectSelectsSplitUnitProjects(packageJson, 'test:changed');
        expect(scripts['test:coverage:run']).toContain('--coverage');
        expect(scripts['test:changed']).toContain('--changed');
        expect(scriptCommands(packageJson, 'test:electron-bundle-static-integrity')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:electron-bundle-static-integrity:no-build',
            'node scripts/prune-build-artifacts.mjs',
            'pnpm run check:build-artifacts:hygiene',
        ]);
        expect(scripts['test:electron-bundle-static-integrity:no-build']).toBe('vitest run --project electron-bundle-static-integrity');
        expect(scripts['release:artifacts']).toBe('HUSKY=0 node scripts/release/build-artifacts.mjs');
        expect(scripts['db:generate']).toBe('pnpm --dir landing exec drizzle-kit generate --config ../drizzle.config.ts');
        expect(scripts['db:migrate']).toBe('pnpm --dir landing exec drizzle-kit migrate --config ../drizzle.config.ts');
        expect(scripts['db:check']).toBe('pnpm --dir landing exec drizzle-kit check --config ../drizzle.config.ts');
        expect(scripts['check:coverage:zero-execution']).toBe('pnpm exec tsx scripts/checkZeroExecutionCoverage.ts');
        expect(scripts['check:coverage:ratchet']).toBe('pnpm exec tsx scripts/checkCoverageRatchet.ts');
        expect(scripts['check:drizzle-schema']).toBe('node scripts/check-drizzle-schema.mjs');
        expect(scripts['check:electron-builder:asar-unpack']).toBe('node scripts/check-electron-builder-asar-unpack.mjs');
        expect(scripts['check:generated-native-resources:host']).toBe('node scripts/check-generated-native-resources.mjs --host');
        expect(scripts['check:pdfjs-viewer-css']).toBe('node scripts/sync-pdfjs-viewer-css.mjs --check');
        expect(scripts['check:production-dependency-audit']).toBe('pnpm exec tsx scripts/checkProductionDependencyAudit.ts');
        expect(scripts['release:resume']).toBe('HUSKY=0 node scripts/release/cut-release.mjs --resume');
        expect(scripts['test:python-page-processor']).toBe('python3 scripts/check-page-processor-smoke.py');
        expect(scripts['check:wasm:freshness']).toBe('node scripts/check-wasm-freshness.mjs --mode=strict');
        expect(scripts['check:wasm:portable']).toBe('node scripts/check-wasm-freshness.mjs --mode=portable');
        expect(scripts['check:architecture:dep-graph']).toBe('node scripts/architecture/dep-graph.mjs --scope=focused --output=.tmp/dep-graph.json');
        expect(scripts['check:architecture:boundaries']).toBe('node scripts/architecture/boundary-check.mjs --scope=focused');
        expect(scripts['check:architecture:source-size']).toBe('pnpm run lint:eslint');
        expect(scriptRunTargets(packageJson, 'check:architecture')).toEqual([
            'check:architecture:dep-graph',
            'check:architecture:boundaries',
            'check:architecture:source-size',
        ]);
        expect(scriptRunTargets(packageJson, 'check:architecture:all')).toContain('check:architecture:source-size');
        expect(scriptCommands(packageJson, 'test:e2e:electron')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:regression:no-build',
        ]);
        expect(scripts['test:e2e:electron:headless']).toBe(
            'bash scripts/test-electron-e2e-headless.sh',
        );
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
        expect(scriptCommands(packageJson, 'test:e2e:electron:visible-window')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:e2e:electron:visible-window:no-build',
        ]);
        expect(scripts['test:e2e:electron:visible-window:no-build']).toBe('vitest run --project e2e-visible-window --reporter verbose');

        const headlessE2ELauncher = await readFile(
            path.join(process.cwd(), 'scripts/test-electron-e2e-headless.sh'),
            'utf8',
        );
        const headlessSessionLauncher = await readFile(
            path.join(process.cwd(), 'scripts/electron-run-headless.sh'),
            'utf8',
        );
        for (const launcher of [
            headlessE2ELauncher,
            headlessSessionLauncher,
        ]) {
            expect(launcher).toContain('export EVB_AUTOMATION_NO_FOCUS=1');
            expect(launcher).toContain('export EVB_AUTOMATION_HIDE_WINDOW=1');
            expect(launcher).toContain('export EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE=1');
        }
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
        expect(largeFixtureScript).toContain('pnpm run build:pdf-page-ops');
        expect(largeFixtureScript).toContain('pnpm run test:e2e:electron:large:no-build');
        expect(largeFixtureScript).not.toContain('EVB_E2E_LARGE_PDF=1');
        expect(largeFixtureScript).not.toContain('EVB_E2E_LARGE_PDF_ANNOTATION_SAVE=1');
        expect(largeFixtureNoBuildScript).toBe('EVB_PDF_PAGE_OPS_ENABLE=1 EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1 vitest run --project e2e-large-pdf --reporter verbose');
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
