import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

// Documented commands must be runnable. Only pnpm invocations inside code spans
// or fenced blocks count, so prose that merely mentions pnpm is never treated as
// a command.
//
// An explicit `pnpm run <name>` always names a package script. A bare
// `pnpm <name>` is ambiguous with pnpm's own subcommands, so it is only checked
// when the token follows this repository's `group:detail` script convention —
// no pnpm builtin uses a colon. Workspace-scoped invocations resolve against a
// different package.json and are out of scope.
const WORKSPACE_SCOPE_FLAGS = new Set([
    '--dir',
    '-C',
    '--filter',
    '-F',
    '--recursive',
    '-r',
    '--workspace-root',
    '-w',
]);

const SCRIPT_NAME_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/u;
const NAMESPACED_SCRIPT_NAME_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)+$/u;

function extractCodeSnippets(markdown: string) {
    const snippets: string[] = [];
    const withoutFences = markdown.replace(/```[^\n]*\n([\s\S]*?)```/gu, (_match, body: string) => {
        snippets.push(body);
        return '\n';
    });

    for (const match of withoutFences.matchAll(/`([^`\n]+)`/gu)) {
        snippets.push(match[1] ?? '');
    }

    return snippets;
}

function readPnpmScriptName(tokens: string[], pnpmIndex: number) {
    let index = pnpmIndex + 1;

    while (index < tokens.length && tokens[index]?.startsWith('-')) {
        if (WORKSPACE_SCOPE_FLAGS.has(tokens[index]?.split('=')[0] ?? '')) {
            return null;
        }
        index += 1;
    }

    const token = tokens[index];
    if (token === undefined) {
        return null;
    }
    if (token === 'run' || token === 'run-script') {
        const scriptName = tokens[index + 1] ?? '';
        return SCRIPT_NAME_PATTERN.test(scriptName) ? scriptName : null;
    }

    return NAMESPACED_SCRIPT_NAME_PATTERN.test(token) ? token : null;
}

function extractPnpmScriptNames(markdown: string) {
    const scriptNames = new Set<string>();

    for (const snippet of extractCodeSnippets(markdown)) {
        for (const command of snippet.split(/\r?\n|&&|\|\||[|;]/u)) {
            const tokens = command.trim().split(/\s+/u).filter(Boolean);
            for (const [
                index,
                token,
            ] of tokens.entries()) {
                const scriptName = token === 'pnpm' ? readPnpmScriptName(tokens, index) : null;
                if (scriptName) {
                    scriptNames.add(scriptName);
                }
            }
        }
    }

    return scriptNames;
}

async function readTrackedMarkdownFiles() {
    const tracked = spawnSync('git', [
        'ls-files',
        '-z',
        '*.md',
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });

    if (tracked.status !== 0) {
        throw new Error(`git ls-files failed: ${tracked.stderr}`);
    }

    const files = tracked.stdout.split('\0').filter(Boolean);
    return (await Promise.all(files.map(async (file) => {
        // A tracked file can be deleted in the working tree mid-change.
        const markdown = await readFile(path.join(process.cwd(), file), 'utf8').catch(() => null);
        return markdown === null ? [] : [{
            file,
            markdown,
        }];
    }))).flat();
}

const unitTestProjects = [
    'unit-core',
    'unit-app',
    'unit-electron',
    'unit-scripts',
    'unit-policy',
    'unit-static-architecture',
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
        // The standing scan-cleanup regression net and rendered acceptance
        // metrics are intentionally public so CI and operators share them.
        expect(Object.keys(scripts).length).toBeLessThanOrEqual(99);
        expect(Object.keys(scripts).filter(name => (
            name.startsWith('test:e2e:') && name.endsWith(':no-build')
        ))).toEqual([]);
    });

    it('keeps every pnpm script cited by tracked documentation runnable', async () => {
        const scripts = await readPackageScripts();
        const documents = await readTrackedMarkdownFiles();

        expect(documents.length).toBeGreaterThan(20);

        const citations = documents.map(({
            file,
            markdown,
        }) => ({
            file,
            scriptNames: extractPnpmScriptNames(markdown),
        }));

        expect(citations.flatMap(({
            file,
            scriptNames,
        }) => [...scriptNames]
            .filter(scriptName => !(scriptName in scripts))
            .map(scriptName => `${file}: pnpm run ${scriptName}`))).toEqual([]);

        // Non-vacuity: the extractor must actually reach commands documented in
        // the contributor and release guides, in both the `pnpm run x` and bare
        // `pnpm group:detail` spellings.
        const citedScriptNames = new Set(citations.flatMap(({scriptNames}) => [...scriptNames]));
        for (const scriptName of [
            'test:unit',
            'release:cut',
            'electron:run:headless',
        ]) {
            expect(citedScriptNames, `${scriptName} should be extracted from tracked documentation`)
                .toContain(scriptName);
        }
    });

    it('extracts documented script names without turning prose into commands', () => {
        const markdown = [
            'Corepack/pnpm must already be available, and pnpm dev is prose here.',
            '',
            'Run `pnpm run check:dev-env -- --strict` or `pnpm validate`.',
            'Workspace commands such as `pnpm --dir landing run lint` and',
            '`pnpm --filter landing build:web` are out of scope, as are',
            '`pnpm install`, `pnpm exec vitest run`, `pnpm dlx tsx x.ts`,',
            'and the `pnpm run <script>` placeholder.',
            '',
            '```bash',
            'xvfb-run -a pnpm electron:run:headless -- start',
            'pnpm run does:not:exist -- --flag',
            'pnpm run build && pnpm dist -- --mac',
            '```',
            '',
        ].join('\n');

        expect([...extractPnpmScriptNames(markdown)].sort()).toEqual([
            'build',
            'check:dev-env',
            'does:not:exist',
            'electron:run:headless',
        ]);
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
            'build-native-tool.mjs pdf-image-combine pdf-page-ops scan-cleanup',
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

    it('refreshes every scan-cleanup native tool before every local Electron launch', async () => {
        const scripts = await readPackageScripts();
        expect(scriptCommands(scripts, 'start').slice(0, 4)).toEqual([
            'pnpm run build:scan-cleanup',
            'pnpm run build:pdf-image-combine',
            'pnpm run build:pdf-page-ops',
            'pnpm run build:electron',
        ]);
        for (const command of [
            'pnpm run build:scan-cleanup',
            'pnpm run build:pdf-image-combine',
            'pnpm run build:pdf-page-ops',
        ]) {
            expect(scriptCommands(scripts, 'dev:headless')).toContain(command);
        }

        const launcher = await readFile(
            path.join(process.cwd(), 'scripts/runDevWithOutputTee.ts'),
            'utf8',
        );
        const nativeBuildIndex = launcher.indexOf('source: \'pnpm-dev-build-scan-cleanup\'');
        const combineBuildIndex = launcher.indexOf('source: \'pnpm-dev-build-pdf-image-combine\'');
        const pageOpsBuildIndex = launcher.indexOf('source: \'pnpm-dev-build-pdf-page-ops\'');
        const electronBuildIndex = launcher.indexOf('source: \'pnpm-dev-build-electron\'');
        expect(nativeBuildIndex).toBeGreaterThanOrEqual(0);
        expect(combineBuildIndex).toBeGreaterThan(nativeBuildIndex);
        expect(pageOpsBuildIndex).toBeGreaterThan(combineBuildIndex);
        expect(electronBuildIndex).toBeGreaterThan(pageOpsBuildIndex);
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

        // Scan cleanup measures its matched page canvas with evb-pdf-page-ops,
        // so the lanes that exercise it build and enable that tool.
        expect(scripts['build:native:e2e']).toContain(
            'build-native-tool.mjs pdf-image-combine pdf-page-ops scan-cleanup',
        );
        for (const scriptName of [
            'test:e2e:electron',
            'test:e2e:electron:quarantine',
            'test:e2e:electron:regression',
        ]) {
            const commands = scriptCommands(scripts, scriptName);
            expect(commands).toContain('pnpm run build:native:e2e');
            expect(commands.at(-1)).toContain('EVB_PDF_PAGE_OPS_ENABLE=1 vitest run --project');
        }
        expect(scriptCommands(scripts, 'test:e2e:electron:blocking-smoke')).toEqual([
            'pnpm run build:electron',
            'vitest run --project e2e-blocking-smoke --reporter verbose',
        ]);
        expect(scriptCommands(scripts, 'test:e2e:electron:draw-shapes')).toEqual([
            'pnpm run build:electron',
            'vitest run --project e2e-draw-shapes --reporter verbose',
        ]);
        expect(scriptCommands(scripts, 'test:e2e:electron:rapid-navigation')).toEqual([
            'pnpm run build:electron',
            'vitest run --project e2e-rapid-navigation --reporter verbose',
        ]);
        expect(scriptCommands(scripts, 'test:e2e:electron:visible-window')).toEqual([
            'pnpm run build:electron',
            'vitest run --project e2e-visible-window --reporter verbose',
        ]);
        expect(scripts['test:e2e:electron:watch']).toBe(
            'vitest --project e2e-regression --reporter verbose',
        );
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
