import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

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
    return script.split(/\s*&&\s*/u).map(command => command.trim()).filter(Boolean);
}

function vitestProjects(command: string) {
    return Array.from(command.matchAll(/(?:^|\s)--project(?:=|\s+)([^\s]+)/gu))
        .flatMap(match => match[1] === undefined ? [] : [match[1]]);
}

describe('package scripts', () => {
    it('keeps every public validation and release tier reachable within the script budget', async () => {
        const scripts = await readPackageScripts();
        const required = [
            'lint',
            'lint:clean',
            'typecheck',
            'typecheck:clean',
            'test:unit',
            'validate:iteration',
            'validate',
            'validate:integration',
            'validate:nightly',
            'build:strict',
            'release:verify',
            'release:verify:checks',
            'release:verify:package:local',
            'test:e2e:electron:headless',
            'test:e2e:electron:blocking-smoke:headless',
            'test:e2e:electron:quarantine:headless',
        ];

        expect(required.every(name => Boolean(scripts[name]))).toBe(true);
        expect(Object.keys(scripts).length).toBeLessThanOrEqual(96);
        expect(Object.keys(scripts).filter(name => (
            name.startsWith('test:e2e:') && name.endsWith(':no-build')
        ))).toEqual([]);
    });

    it('keeps build generation, pruning, and native staging ordered behind heavy-gate coordination', async () => {
        const scripts = await readPackageScripts();

        expect(scriptCommands(scripts, 'build')).toEqual([
            'pnpm run generate:build-artifacts',
            'pnpm exec nuxi build',
            'node scripts/prune-build-artifacts.mjs',
            'node scripts/check-web-deploy-assets.mjs',
        ]);
        expect(scriptCommands(scripts, 'build:desktop:no-wasm-check')).toEqual([
            'pnpm run build',
            'pnpm run build:electron',
            'pnpm run build:native',
        ]);
        expect(scripts['build:native']).toContain('build-native-tool.mjs --all');
        expect(scripts['build:native:e2e']).toContain(
            'build-native-tool.mjs pdf-image-combine scan-cleanup',
        );
        expect(scripts['build:strict']).toContain('validation-gates.mjs heavy');
        expect(scripts['build:strict']).toContain('run-build-strict.mjs');
        for (const tool of [
            'pdf-image-combine',
            'pdf-page-ops',
            'pdf-search',
            'scan-cleanup',
        ]) {
            expect(scripts[`build:${tool}`]).toContain('validation-gates.mjs heavy');
            expect(scripts[`build:${tool}`]).toContain(`build-native-tool.mjs ${tool}`);
        }
    });

    it('routes lint and validation through one instrumented owner without implicit graph output', async () => {
        const scripts = await readPackageScripts();

        expect(scripts['lint']).toBe('node scripts/validation-gates.mjs lint');
        expect(scripts['lint:fix']).toContain('validation-gates.mjs lint --fix');
        expect(scripts['lint:all']).toContain('validation-gates.mjs lint --all');
        expect(JSON.stringify(scripts)).not.toContain('dep-graph.json');
        expect(scripts['validate:iteration']).toContain('validation-gates.mjs iteration');
        expect(scripts['validate']).toContain('validation-gates.mjs acceptance');
        expect(scripts['validate:integration']).toContain('validation-gates.mjs integration');
        expect(scripts['validate:nightly']).toContain('validation-gates.mjs nightly');
    });

    it('runs Nuxt separately while consolidating all TS7 configs behind one compiler probe', async () => {
        const scripts = await readPackageScripts();
        const commands = scriptCommands(scripts, 'typecheck');

        expect(commands).toHaveLength(2);
        expect(commands[0]).toBe('node scripts/run-nuxt-typecheck.mjs');
        expect(commands[1]).toContain('node scripts/run-workspace-package-typecheck.mjs');
        expect(commands[1]).toContain('-p electron/tsconfig.json');
        expect(commands[1]).toContain('-p tests/tsconfig.json');
        expect(commands[1]).toContain('-p tsconfig.scripts.json');
        expect(commands[1]).toContain('-p server/tsconfig.json');
        expect(vitestProjects(scripts['test:unit'] ?? '')).toEqual(unitTestProjects);
        expect(vitestProjects(scripts['test:coverage'] ?? '')).toEqual(unitTestProjects);
    });

    it('keeps release, database, and static-integrity entry points first-class', async () => {
        const scripts = await readPackageScripts();

        expect(scripts['release:verify']).toBe('node scripts/release/verify-local.mjs');
        expect(scripts['release:artifacts']).toContain('scripts/release/build-artifacts.mjs');
        expect(scripts['release:cut']).toContain('scripts/release/cut-release.mjs');
        expect(scripts['db:generate']).toContain('drizzle-kit generate');
        expect(scripts['db:migrate']).toContain('drizzle-kit migrate');
        expect(scriptCommands(scripts, 'test:electron-bundle-static-integrity')).toEqual([
            'pnpm run build:electron',
            'pnpm run test:electron-bundle-static-integrity:no-build',
            'node scripts/prune-build-artifacts.mjs',
            'pnpm run check:build-artifacts:hygiene',
        ]);
    });

    it('keeps E2E preparation before each project and routes headless runs through the isolated wrapper', async () => {
        const scripts = await readPackageScripts();
        for (const scriptName of [
            'test:e2e:electron',
            'test:e2e:electron:blocking-smoke',
            'test:e2e:electron:quarantine',
            'test:e2e:electron:rapid-navigation',
            'test:e2e:electron:regression',
        ]) {
            const commands = scriptCommands(scripts, scriptName);
            const buildIndex = commands.findIndex(command => command.includes('build:electron'));
            const testIndex = commands.findIndex(command => command.includes('vitest run --project'));
            expect(buildIndex).toBeGreaterThanOrEqual(0);
            expect(testIndex).toBeGreaterThan(buildIndex);
        }
        expect(scripts['test:e2e:electron:headless']).toBe('bash scripts/test-electron-e2e-headless.sh');
        expect(scripts['test:e2e:electron:blocking-smoke:headless'])
            .toContain('test-electron-e2e-headless.sh test:e2e:electron:blocking-smoke');

        const launcher = await readFile(
            path.join(process.cwd(), 'scripts/test-electron-e2e-headless.sh'),
            'utf8',
        );
        expect(launcher).toContain('export EVB_AUTOMATION_NO_FOCUS=1');
        expect(launcher).toContain('export EVB_AUTOMATION_HIDE_WINDOW=1');
        expect(launcher).toContain('export EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE=1');
        expect(launcher).toContain('validation-gates.mjs heavy');
    });

    it('keeps large-fixture and PDF-tab diagnostics opt-in', async () => {
        const scripts = await readPackageScripts();
        const largeFixtureScript = scripts['test:e2e:electron:large'] ?? '';
        const pdfTabsCiScript = scripts['diag:pdf-tabs:ci'] ?? '';

        expect(largeFixtureScript).toContain('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1');
        expect(largeFixtureScript).toContain('EVB_PDF_PAGE_OPS_ENABLE=1');
        expect(largeFixtureScript).toContain('vitest run --project e2e-large-pdf');
        expect(pdfTabsCiScript).toContain('pnpm diag:pdf-tabs --session pdf-tabs-ci');
        expect(pdfTabsCiScript).toContain('--max-inactive-canvas-pixels 0');
        expect(scripts['fallow:health:summary']).toBe('fallow health --summary || true');
    });
});
