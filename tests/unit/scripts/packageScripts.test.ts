import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const expectedScriptNames = [
    'start',
    'dev',
    'dev:headless',
    'dev:nuxt',
    'dev:web',
    'deploy:web',
    'deploy:web:prod',
    'deploy:landing',
    'deploy:landing:prod',
    'build',
    'build:desktop',
    'build:desktop:no-wasm-check',
    'build:strict',
    'build:strict:no-wasm-check',
    'build:electron',
    'build:pdf-image-combine',
    'build:pdf-page-ops',
    'build:pdf-search',
    'build:scan-cleanup',
    'generate:build-artifacts',
    'preview',
    'postinstall',
    'copy:pdfjs',
    'typecheck',
    'lint',
    'lint:fix',
    'lint:all',
    'fallow',
    'fallow:all',
    'fallow:dupes',
    'fallow:health:summary',
    'typecheck:coverage',
    'validate',
    'test',
    'test:coverage',
    'test:electron-bundle-static-integrity',
    'test:electron-bundle-static-integrity:no-build',
    'test:unit',
    'test:integration:browser',
    'lint:rust',
    'test:rust',
    'test:e2e:electron',
    'test:e2e:electron:blocking-smoke',
    'test:e2e:electron:blocking-smoke:headless',
    'test:packaged-core-pdf-smoke',
    'test:e2e:electron:draw-shapes',
    'test:e2e:electron:large',
    'test:e2e:electron:quarantine',
    'test:e2e:electron:rapid-navigation',
    'test:e2e:electron:visible-window',
    'test:e2e:electron:regression',
    'test:e2e:electron:save-pipeline',
    'test:e2e:electron:headless',
    'test:e2e:electron:watch',
    'electron:run',
    'electron:run:headless',
    'diag:pdf-navigation-blink-trace',
    'diag:ocr-profile-benchmark',
    'test:ocr:native-smoke:required',
    'diag:pdf-skeleton-navigation',
    'diag:pdf-tabs',
    'diag:arnold-pdf-open',
    'diag:scan-cleanup-corpus-verify',
    'diag:pdf-tabs:ci',
    'dist',
    'release:verify:checks',
    'release:verify:package:local',
    'release:verify',
    'release:artifacts',
    'release:cut',
    'release:resume',
    'db:generate',
    'db:migrate',
    'db:check',
    'check:resources:matrix',
    'check:dev-env',
    'check:electron:install',
    'check:electron-builder:asar-unpack',
    'check:drizzle-schema',
    'check:production-dependency-audit',
    'check:static:assets',
    'check:static:reports',
    'check:build-artifacts:hygiene',
    'check:wasm:portable',
    'check:architecture:source-size',
    'check:architecture',
    'preversion',
    'prepare',
] as const;

const unitTestProjects = [
    'unit-core',
    'unit-app',
    'unit-electron',
    'unit-scripts',
    'unit-policy',
];

async function readPackageScripts() {
    const packageJson = JSON.parse(
        await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    if (!packageJson.scripts) {
        throw new Error('Missing package scripts');
    }

    return packageJson.scripts;
}

function scriptCommands(scripts: Record<string, string>, scriptName: string) {
    const script = scripts[scriptName];
    if (!script) {
        throw new Error(`Missing package script: ${scriptName}`);
    }

    return script.split(/\s*&&\s*/u)
        .map(command => command.trim())
        .filter(Boolean);
}

function vitestProjects(command: string) {
    return Array.from(command.matchAll(/(?:^|\s)--project(?:=|\s+)([^\s]+)/gu))
        .flatMap(match => match[1] === undefined ? [] : [match[1]]);
}

describe('package scripts', () => {
    it('keeps the consolidated script inventory within the architecture budget', async () => {
        const scripts = await readPackageScripts();

        expect(Object.keys(scripts)).toEqual(expectedScriptNames);
        expect(Object.keys(scripts)).toHaveLength(88);
        expect(Object.keys(scripts).filter(name => name.startsWith('check:'))).toHaveLength(12);
        expect(Object.keys(scripts).filter(name => name.startsWith('test:'))).toHaveLength(20);
        expect(Object.keys(scripts).filter(name => name.startsWith('typecheck:')))
            .toEqual(['typecheck:coverage']);
        expect(Object.keys(scripts).filter(name => (
            name.startsWith('test:e2e:') && name.endsWith(':no-build')
        ))).toEqual([]);
    });

    it('keeps build generation, pruning, and desktop native staging ordered', async () => {
        const scripts = await readPackageScripts();

        expect(scriptCommands(scripts, 'build')).toEqual([
            'pnpm run generate:build-artifacts',
            'pnpm exec nuxi build',
            'node scripts/prune-build-artifacts.mjs',
            'node scripts/check-web-deploy-assets.mjs',
        ]);
        expect(scriptCommands(scripts, 'build:desktop')).toEqual([
            'pnpm run check:wasm:portable',
            'pnpm run build:desktop:no-wasm-check',
        ]);
        expect(scriptCommands(scripts, 'build:desktop:no-wasm-check')).toEqual([
            'pnpm run build',
            'pnpm run build:electron',
            'pnpm run build:pdf-image-combine',
            'pnpm run build:pdf-page-ops',
            'pnpm run build:pdf-search',
            'pnpm run build:scan-cleanup',
        ]);
        for (const tool of [
            'pdf-image-combine',
            'pdf-page-ops',
            'pdf-search',
            'scan-cleanup',
        ]) {
            expect(scripts[`build:${tool}`]).toBe(`node scripts/build-native-tool.mjs ${tool}`);
        }
        expect(scripts['build:strict']).toBe('node scripts/run-build-strict.mjs');
        expect(scripts['build:strict:no-wasm-check']).toBe(
            'node scripts/run-build-strict.mjs --skip-wasm-check',
        );
    });

    it('keeps lint behavior direct while generation stays in prepare and build', async () => {
        const scripts = await readPackageScripts();
        const lintCommands = scriptCommands(scripts, 'lint');
        const lintFixCommands = scriptCommands(scripts, 'lint:fix');
        const lintAllCommands = scriptCommands(scripts, 'lint:all');

        expect(lintCommands[0]).toContain(
            'eslint app electron packages scripts server tests eslint-plugin-custom.mjs',
        );
        expect(lintCommands[0]).toContain('--max-warnings=0 --report-unused-disable-directives');
        expect(lintCommands).toContain('stylelint "app/**/*.{vue,scss,css}"');
        expect(lintCommands).toContain(
            'node --import tsx scripts/checkStyleAssetConventions.ts --target=app',
        );
        expect(lintCommands).toContain('node --import tsx scripts/checkLocales.ts --target=app');
        expect(lintCommands).toContain('node --import tsx scripts/checkIconBundle.ts --target=app');
        expect(lintCommands).toContain(
            'node scripts/architecture/dep-graph.mjs --scope=focused --output=.tmp/dep-graph.json',
        );
        expect(lintCommands).toContain(
            'node scripts/architecture/boundary-check.mjs --scope=focused',
        );
        expect(lintFixCommands[0]).toContain('--fix --max-warnings=0');
        expect(lintFixCommands).toContain('stylelint "app/**/*.{vue,scss,css}" --fix');
        expect(lintAllCommands).toContain('stylelint "{app,landing/app}/**/*.{vue,scss,css}"');
        expect(lintAllCommands).toContain(
            'node --import tsx scripts/checkStyleAssetConventions.ts --target=all',
        );
        expect(lintAllCommands).toContain(
            'EVB_ESLINT_NAMING_ONLY=1 eslint landing --no-ignore --max-warnings=0',
        );
        expect(lintAllCommands).toContain('pnpm --dir landing run lint');
        expect(scripts['generate:build-artifacts']).toBe(
            'node --import tsx scripts/generateBuildArtifacts.ts',
        );
        expect(scriptCommands(scripts, 'prepare')).toEqual([
            'pnpm run generate:build-artifacts',
            'husky',
        ]);
        expect(scripts['check:static:assets']).toBe('node scripts/check-web-deploy-source.mjs');
        expect(scripts['check:static:reports']).toBe(
            'pnpm exec tsx scripts/reportPlatformManifestConsumers.ts',
        );
    });

    it('keeps validation, typechecking, and coverage behavior under aggregate entry points', async () => {
        const scripts = await readPackageScripts();

        expect(scriptCommands(scripts, 'validate')).toEqual([
            'pnpm run lint',
            'pnpm run check:static:reports',
            'pnpm run check:static:assets',
            'pnpm run typecheck',
            'pnpm run test:unit',
            'pnpm run typecheck:coverage',
            'pnpm run build:strict',
            'pnpm run fallow:all',
        ]);
        expect(scriptCommands(scripts, 'typecheck')).toEqual([
            'node scripts/run-nuxt-typecheck.mjs',
            'node scripts/run-ts7-typecheck.mjs -p electron/tsconfig.json',
            'node scripts/run-ts7-typecheck.mjs -p tests/tsconfig.json',
            'node scripts/run-ts7-typecheck.mjs -p tsconfig.scripts.json',
            'node scripts/run-workspace-package-typecheck.mjs',
            'node scripts/run-ts7-typecheck.mjs -p server/tsconfig.json',
        ]);
        expect(vitestProjects(scripts['test:unit'] ?? '')).toEqual(unitTestProjects);
        expect(vitestProjects(scripts['test:coverage'] ?? '')).toEqual(unitTestProjects);
        expect(scripts['test:coverage']).toContain('vitest run --coverage');
        expect(scripts['test:coverage']).toContain('scripts/checkCoverageRatchet.ts');
        expect(scripts['test:coverage']).toContain('scripts/checkZeroExecutionCoverage.ts');
        expect(scripts['test']).toBe('pnpm run test:unit');
    });

    it('keeps release, database, and static-integrity commands first-class', async () => {
        const scripts = await readPackageScripts();

        expect(scripts['release:verify']).toBe('node scripts/release/verify-local.mjs');
        expect(scripts['release:artifacts']).toBe(
            'HUSKY=0 node scripts/release/build-artifacts.mjs',
        );
        expect(scripts['release:cut']).toBe('HUSKY=0 node scripts/release/cut-release.mjs');
        expect(scripts['release:resume']).toBe(
            'HUSKY=0 node scripts/release/cut-release.mjs --resume',
        );
        expect(scripts['db:generate']).toBe(
            'pnpm --dir landing exec drizzle-kit generate --config ../drizzle.config.ts',
        );
        expect(scripts['db:migrate']).toBe(
            'pnpm --dir landing exec drizzle-kit migrate --config ../drizzle.config.ts',
        );
        expect(scripts['db:check']).toBe(
            'pnpm --dir landing exec drizzle-kit check --config ../drizzle.config.ts',
        );
        expect(scriptCommands(scripts, 'test:electron-bundle-static-integrity')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:electron-bundle-static-integrity:no-build',
            'node scripts/prune-build-artifacts.mjs',
            'pnpm run check:build-artifacts:hygiene',
        ]);
        expect(scripts['test:electron-bundle-static-integrity:no-build']).toBe(
            'vitest run --project electron-bundle-static-integrity',
        );
    });

    it('keeps E2E entry points direct and preserves their project-specific setup', async () => {
        const scripts = await readPackageScripts();

        expect(scriptCommands(scripts, 'test:e2e:electron')).toEqual([
            'pnpm run build:pdf-image-combine',
            'pnpm run build:scan-cleanup',
            'pnpm run build:electron',
            'vitest run --project e2e-regression --reporter verbose',
        ]);
        expect(scriptCommands(scripts, 'test:e2e:electron:blocking-smoke')).toEqual([
            'pnpm run build:electron',
            'vitest run --project e2e-blocking-smoke --reporter verbose',
        ]);
        expect(scriptCommands(scripts, 'test:e2e:electron:draw-shapes')).toEqual([
            'pnpm run build:electron',
            'vitest run --project e2e-draw-shapes --reporter verbose',
        ]);
        expect(scriptCommands(scripts, 'test:e2e:electron:quarantine')).toEqual([
            'pnpm run build:pdf-image-combine',
            'pnpm run build:scan-cleanup',
            'pnpm run build:electron',
            'vitest run --project e2e-quarantine --passWithNoTests --reporter verbose',
        ]);
        expect(scriptCommands(scripts, 'test:e2e:electron:rapid-navigation')).toEqual([
            'pnpm run build:electron',
            'vitest run --project e2e-rapid-navigation --reporter verbose',
        ]);
        expect(scriptCommands(scripts, 'test:e2e:electron:visible-window')).toEqual([
            'pnpm run build:electron',
            'vitest run --project e2e-visible-window --reporter verbose',
        ]);
        expect(scriptCommands(scripts, 'test:e2e:electron:regression')).toEqual([
            'pnpm run build:pdf-image-combine',
            'pnpm run build:scan-cleanup',
            'pnpm run build:electron',
            'vitest run --project e2e-regression --reporter verbose',
        ]);
        expect(scripts['test:e2e:electron:watch']).toBe(
            'vitest --project e2e-regression --reporter verbose',
        );
        expect(scripts['test:e2e:electron:headless']).toBe(
            'bash scripts/test-electron-e2e-headless.sh',
        );

        const headlessLaunchers = await Promise.all([
            readFile(path.join(process.cwd(), 'scripts/test-electron-e2e-headless.sh'), 'utf8'),
            readFile(path.join(process.cwd(), 'scripts/electron-run-headless.sh'), 'utf8'),
        ]);
        for (const launcher of headlessLaunchers) {
            expect(launcher).toContain('export EVB_AUTOMATION_NO_FOCUS=1');
            expect(launcher).toContain('export EVB_AUTOMATION_HIDE_WINDOW=1');
            expect(launcher).toContain('export EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE=1');
        }
    });

    it('keeps opt-in fixture and PDF tab diagnostic tripwires explicit', async () => {
        const scripts = await readPackageScripts();
        const largeFixtureScript = scripts['test:e2e:electron:large'] ?? '';
        const pdfTabsCiScript = scripts['diag:pdf-tabs:ci'] ?? '';

        expect(largeFixtureScript).toContain('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1');
        expect(largeFixtureScript).toContain('EVB_PDF_PAGE_OPS_ENABLE=1');
        expect(largeFixtureScript).toContain('pnpm run build:pdf-page-ops');
        expect(largeFixtureScript).toContain('vitest run --project e2e-large-pdf');
        expect(largeFixtureScript).not.toContain('EVB_E2E_LARGE_PDF=1');
        expect(largeFixtureScript).not.toContain('EVB_E2E_LARGE_PDF_ANNOTATION_SAVE=1');
        expect(pdfTabsCiScript).toContain('pdf-tabs-ci');
        expect(pdfTabsCiScript).toContain('pnpm diag:pdf-tabs --session pdf-tabs-ci');
        expect(pdfTabsCiScript).toContain('--max-inactive-canvases 0');
        expect(pdfTabsCiScript).toContain('--max-inactive-rendered-pages 0');
        expect(pdfTabsCiScript).toContain('--max-inactive-djvu-images 0');
        expect(pdfTabsCiScript).toContain('--max-inactive-canvas-pixels 0');
    });

    it('keeps diagnostics first-class and informational fallow health non-failing', async () => {
        const scripts = await readPackageScripts();

        expect(scriptCommands(scripts, 'diag:pdf-navigation-blink-trace')).toEqual([
            'pnpm run build:electron',
            'pnpm exec tsx scripts/diagnostics/pdfNavigationBlinkTrace.ts',
        ]);
        expect(scriptCommands(scripts, 'diag:pdf-skeleton-navigation')).toEqual([
            'pnpm run build:electron',
            'pnpm exec tsx scripts/diagnostics/runPdfSkeletonNavigationDiagnostics.ts',
        ]);
        expect(scriptCommands(scripts, 'diag:arnold-pdf-open')).toEqual([
            'pnpm run build:electron',
            'pnpm exec tsx scripts/diagnostics/runArnoldPdfOpenDiagnostics.ts',
        ]);
        expect(scriptCommands(scripts, 'fallow:all')).toEqual([
            'pnpm run fallow',
            'pnpm run fallow:dupes',
        ]);
        expect(scripts['fallow:health:summary']).toBe('fallow health --summary || true');
    });
});
