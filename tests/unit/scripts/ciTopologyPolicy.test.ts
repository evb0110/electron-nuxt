import {isRecord} from '@contracts/runtimeGuards';
import { existsSync } from 'node:fs';
import {
    readFile,
    readdir,
} from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    SetRequired,
    Simplify,
    TsConfigJson,
} from 'type-fest';

type TTsConfigJsonWithGlobs = Simplify<SetRequired<TsConfigJson, 'exclude' | 'include'>>;

async function readProjectFile(filePath: string) {
    return readFile(path.join(process.cwd(), filePath), 'utf8');
}


function parseTsConfigJsonWithGlobs(source: string, label: string): TTsConfigJsonWithGlobs {
    const parsed = JSON.parse(source) as unknown;

    if (!isRecord(parsed)) {
        throw new Error(`${label} must be a JSON object.`);
    }

    const tsConfig = parsed as TsConfigJson;
    for (const key of [
        'exclude',
        'include',
    ] as const) {
        if (!Array.isArray(tsConfig[key]) || !tsConfig[key].every(item => typeof item === 'string')) {
            throw new Error(`${label} must contain a ${key} array.`);
        }
    }

    return tsConfig as TTsConfigJsonWithGlobs;
}

async function readTsConfigJsonWithGlobs(filePath: string) {
    return parseTsConfigJsonWithGlobs(await readProjectFile(filePath), filePath);
}

function workflowJob(workflow: string, jobName: string) {
    const start = workflow.indexOf(`  ${jobName}:\n`);
    if (start === -1) {
        throw new Error(`Missing workflow job: ${jobName}`);
    }

    const nextJob = workflow.slice(start + 1).search(/\n {2}[a-z0-9_]+:\n/u);
    return nextJob === -1
        ? workflow.slice(start)
        : workflow.slice(start, start + 1 + nextJob);
}

const splitValidateCommands = [
    'pnpm run lint',
    'pnpm run typecheck',
    'pnpm run test:unit',
    'pnpm run typecheck:coverage',
    'pnpm run build:strict',
    'pnpm run fallow',
    'pnpm run fallow:dupes',
    'pnpm run check:architecture:dep-graph',
    'pnpm run check:architecture:boundaries',
    'pnpm run check:architecture:source-size',
];

function expectSplitValidateSteps(job: string) {
    expect(job).not.toContain('run: pnpm run validate');
    for (const command of splitValidateCommands) {
        expect(job).toContain(`run: ${command}`);
    }
}

async function collectTestFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nestedFiles: string[][] = await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            return collectTestFiles(entryPath);
        }

        return entry.isFile() && entry.name.endsWith('.test.ts')
            ? [entryPath]
            : [];
    }));

    return nestedFiles.flat();
}

describe('CI topology policy', () => {
    it('keeps PR feedback bounded and release workflow checks delegated', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const packageJson = await readProjectFile('package.json');
        const prQuality = workflowJob(workflow, 'pr_quality');

        expect(workflow).not.toContain('push:');
        expect(workflow).toContain('schedule:');
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).toContain('pull_request:');
        expect(workflow).toContain('name: Pull Request Quality Gates');
        expect(prQuality).toContain('if: ${{ github.event_name == \'pull_request\' }}');
        expect(prQuality).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        expect(prQuality).toContain('run: pnpm run lint');
        expect(prQuality).toContain('run: pnpm run typecheck');
        expect(prQuality).toContain('run: pnpm run test:unit');
        expect(prQuality).not.toContain('rustup target add');
        expect(prQuality).not.toContain('run: pnpm run build:strict');
        expect(prQuality).not.toContain('run: pnpm run test:coverage');
        expect(prQuality).not.toContain('run: pnpm run test:rust');
        expect(prQuality).not.toContain('run: pnpm run test:e2e');
        expect(prQuality).not.toContain('run: pnpm run test:e2e:electron:large');
        expect(prQuality).not.toContain('run: pnpm run test:python-page-processor');
        expect(prQuality).not.toContain('run: pnpm run diag:pdf-tabs:ci');
        expect(prQuality).not.toContain('electron-builder');
        expect(workflow).toContain('name: Manual Quality Gates');
        expect(workflowJob(workflow, 'manual_quality')).toContain('if: ${{ github.event_name == \'workflow_dispatch\' }}');
        expect(workflowJob(workflow, 'manual_quality')).toContain('run: rustup target add wasm32-unknown-unknown');
        expect(workflowJob(workflow, 'manual_quality')).toContain('run: pnpm run check:wasm:portable');
        expectSplitValidateSteps(workflowJob(workflow, 'manual_quality'));
        expect(workflowJob(workflow, 'manual_quality')).toContain('run: pnpm run test:coverage');
        expect(releaseWorkflow).not.toContain('test:coverage');
        expect(packageJson).not.toMatch(/"gate:commit":\s*"[^"]*coverage/u);
    });

    it('keeps native, landing, and Python smoke checks manual or nightly only', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const testsTsconfig = await readTsConfigJsonWithGlobs('tests/tsconfig.json');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(workflow).not.toContain('Detect Changed Areas');
        expect(workflow).not.toContain('github.event_name == \'push\'');
        expect(workflow).not.toContain('needs.changes');
        expect(workflow).toContain('name: Native Rust Tests');
        expect(workflowJob(workflow, 'manual_native')).toContain('if: ${{ github.event_name == \'workflow_dispatch\' }}');
        expect(workflowJob(workflow, 'manual_native')).toContain('run: pnpm run test:rust');
        expect(workflow).toContain('name: Landing Quality Gates');
        expect(workflow).toContain('run: pnpm --dir landing run check:vendor');
        expect(workflow).toContain('run: pnpm --dir landing run typecheck');
        expect(workflow).toContain('run: pnpm --dir landing run build');
        expect(workflowJob(workflow, 'manual_landing')).toContain('if: ${{ github.event_name == \'workflow_dispatch\' }}');
        expect(workflowJob(workflow, 'manual_landing')).toContain('continue-on-error: true');
        expect(sharedVitestConfig).toContain('tests/unit/landing/**/*.test.ts');
        expect(testsTsconfig.exclude).toContain('./unit/landing/**/*.ts');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('python -m pip install');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('opencv-python-headless');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('img2pdf');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('Pillow');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run test:python-page-processor');
    });

    it('verifies release build artifacts before upload', async () => {
        const workflow = await readProjectFile('.github/workflows/build.yml');
        const macSigningScript = await readProjectFile('scripts/release/configure-macos-signing.sh');
        const verifyStep = workflow.slice(
            workflow.indexOf('- name: Verify release artifacts'),
            workflow.indexOf('- name: Upload artifacts'),
        );

        expect(verifyStep).toContain('node scripts/release/assert-build-artifacts.mjs release "${{ matrix.platform }}" "${{ matrix.arch }}"');
        expect(verifyStep).toContain('EVB_RELEASE_HAS_MAC_SIGNING');
        expect(verifyStep).toContain('EVB_RELEASE_HAS_WINDOWS_SIGNING');
        expect(verifyStep).not.toContain('CSC_LINK');
        expect(verifyStep).not.toContain('WIN_CSC_LINK');
        expect(workflow).toContain('::error::Partial WIN_CSC_* secrets detected; set both WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD or neither');
        expect(macSigningScript).toContain('if [ "${CI:-}" = "true" ]; then');
        expect(macSigningScript).toContain('::error::$message');
        expect(macSigningScript).toContain('Partial macOS signing credentials detected; set both CSC_LINK and CSC_KEY_PASSWORD or neither');
        expect(macSigningScript).toContain('Partial APPLE_API_* secrets detected; set APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER or none of them');
    });

    it('keeps release quality gates from requiring pre-bundle host Linux resources', async () => {
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const qualityJob = workflowJob(releaseWorkflow, 'quality');

        expect(releaseWorkflow).not.toContain('tags:');
        expect(releaseWorkflow).toContain('workflow_dispatch:');
        expect(releaseWorkflow).toContain('target_ref:');
        expect(releaseWorkflow).toContain('ref: ${{ steps.target.outputs.target_ref }}');
        expect(qualityJob).toContain('run: rustup target add wasm32-unknown-unknown');
        expect(qualityJob).toContain('EVB_NATIVE_TOOLS_ALLOW_HOST_CI_GEN: \'1\'');
        expect(qualityJob).toContain('run: pnpm run release:verify:checks');
        expect(workflowJob(releaseWorkflow, 'publish')).toContain('gh release create "$RELEASE_TAG" artifacts/* --generate-notes --target "$TARGET_SHA"');
    });

    it('keeps release cutting dispatch-based instead of tag-push based', async () => {
        const releaseScript = await readProjectFile('scripts/release/cut-release.mjs');

        expect(releaseScript).toContain('`release: ${version} [skip ci]`');
        expect(releaseScript).toContain('\'workflow\'');
        expect(releaseScript).toContain('\'run\'');
        expect(releaseScript).toContain('\'release.yml\'');
        expect(releaseScript).toContain('`target_ref=${targetSha}`');
        expect(releaseScript).not.toContain('refs/tags/${tag}');
        expect(releaseScript).not.toContain('\'tag\',\n            tag');
        expect(releaseScript).not.toContain('\'--atomic\'');
    });

    it('runs the heavier deterministic checks in the nightly lane', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const buildWorkflow = await readProjectFile('.github/workflows/build.yml');
        const nvmrc = await readProjectFile('.nvmrc');
        const rustToolchain = await readProjectFile('rust-toolchain.toml');

        expect(workflow).toContain('github.event_name == \'schedule\'');
        expect(workflow).toContain('name: Nightly Maintenance Gates');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: rustup target add wasm32-unknown-unknown');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run check:wasm:freshness');
        expectSplitValidateSteps(workflowJob(workflow, 'nightly_maintenance'));
        expect(workflow).toContain('run: pnpm run test:rust');
        expect(workflow).toContain('run: pnpm run test:coverage');
        expect(workflow).toContain('run: pnpm run check:ocr-language-model-registry');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('python -m pip install');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('opencv-python-headless');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('img2pdf');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('Pillow');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run test:python-page-processor');
        expect(nvmrc.trim()).toBe('24.11.1');
        expect(workflow).toContain('NODE_VERSION: \'24.11.1\'');
        expect(buildWorkflow).toContain('NODE_VERSION: \'24.11.1\'');
        expect(rustToolchain).toContain('channel = "1.89.0"');
        expect(rustToolchain).toContain('profile = "minimal"');
        expect(buildWorkflow).toContain('run: rustup target add wasm32-unknown-unknown');
    });

    it('keeps Electron desktop automation and PDF tab diagnostics nightly and non-blocking', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const packageJson = await readProjectFile('package.json');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(workflow).toContain('name: Nightly Electron E2E Smoke');
        expect(workflow).toContain('runs-on: macos-14');
        expect(workflow).toContain('continue-on-error: true');
        expect(workflow).toContain('EVB_E2E_REQUIRE_DJVU_FIXTURE: \'1\'');
        expect(workflow).toContain('run: pnpm run test:e2e:electron');
        expect(workflow).toContain('name: Nightly Electron E2E Rapid Navigation');
        expect(workflowJob(workflow, 'nightly_electron_e2e')).toContain('run: pnpm run check:electron:install');
        expect(workflowJob(workflow, 'nightly_electron_e2e_rapid_navigation')).toContain('run: pnpm run check:electron:install');
        expect(workflow).toMatch(/nightly_electron_e2e_rapid_navigation:[\s\S]*if: \$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}[\s\S]*continue-on-error: true[\s\S]*run: pnpm run test:e2e:electron:rapid-navigation/u);
        expect(workflow).toContain('name: Nightly Electron E2E Large PDF');
        expect(workflowJob(workflow, 'nightly_electron_e2e_large_pdf')).toContain('run: pnpm run check:electron:install');
        expect(workflowJob(workflow, 'nightly_electron_e2e_large_pdf')).toContain('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE: \'1\'');
        expect(workflow).toMatch(/nightly_electron_e2e_large_pdf:[\s\S]*if: \$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}[\s\S]*continue-on-error: true[\s\S]*run: pnpm run test:e2e:electron:large/u);
        expect(workflow).toContain('name: Nightly Electron E2E Quarantine');
        expect(workflowJob(workflow, 'nightly_electron_e2e_quarantine')).toContain('run: pnpm run check:electron:install');
        expect(workflow).toContain('run: pnpm run test:e2e:electron:quarantine');
        expect(workflow).toContain('name: Nightly PDF Tab Diagnostics');
        expect(workflowJob(workflow, 'nightly_pdf_tabs_diagnostics')).toContain('run: pnpm run check:electron:install');
        expect(workflow).toMatch(/nightly_pdf_tabs_diagnostics:[\s\S]*if: \$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}[\s\S]*continue-on-error: true[\s\S]*run: pnpm run diag:pdf-tabs:ci/u);
        expect(workflow).toContain('run: pnpm run diag:pdf-tabs:ci');
        expect(packageJson).toContain('"test:e2e:electron:smoke:no-build": "vitest run --project e2e-smoke --reporter verbose"');
        expect(packageJson).toContain('"test:e2e:electron:quarantine:no-build": "vitest run --project e2e-quarantine --passWithNoTests --reporter verbose"');
        expect(sharedVitestConfig).toContain('retry: process.env.CI ? 2 : 1');
        expect(releaseWorkflow).not.toContain('test:e2e:electron');
        expect(releaseWorkflow).not.toContain('diag:pdf-tabs');
    });

    it('keeps coverage config wired to an actual gate and free of stale path overrides', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const packageJson = await readProjectFile('package.json');
        const vitestConfig = await readProjectFile('vitest.config.ts');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');
        const baseline = await readProjectFile('coverage-baseline.json');

        expect(workflow).toContain('run: pnpm run test:coverage');
        expect(packageJson).toContain('"test:coverage": "pnpm run test:coverage:run && pnpm run check:coverage-ratchet"');
        expect(packageJson).toContain('"test:coverage:run": "vitest run --coverage --project unit"');
        expect(packageJson).toContain('"check:coverage-ratchet": "pnpm exec tsx scripts/checkCoverageRatchet.ts"');
        expect(vitestConfig).toContain('provider: \'v8\'');
        expect(vitestConfig).toContain('\'json-summary\'');
        expect(vitestConfig).toContain('slowTestThreshold: unitSlowTestThresholdMs');
        expect(sharedVitestConfig).toContain('unitSlowTestThresholdMs = 300');
        expect(vitestConfig).not.toContain('thresholds:');
        expect(vitestConfig).not.toContain('explicitImportOnlyFiles');
        expect(vitestConfig).not.toContain('app/composables/page/**/*.ts');
        expect(baseline).toContain('"tolerancePercentagePoints": 0.5');
    });

    it('keeps mock-based module tests in the unit tree', async () => {
        const packageJson = await readProjectFile('package.json');
        const vitestConfig = await readProjectFile('vitest.config.ts');
        const oldLayerPath = [
            'tests',
            'integration',
        ].join('/');

        expect(vitestConfig).not.toContain(oldLayerPath);
        expect(packageJson).not.toContain([
            'test',
            'integration',
        ].join(':'));
        expect(existsSync(path.join(process.cwd(), oldLayerPath))).toBe(false);
    });

    it('keeps module-owned composable tests out of legacy app composables paths', async () => {
        const legacyComposablesRoot = path.join(process.cwd(), 'tests/unit/app/composables');
        const legacyTests = await collectTestFiles(legacyComposablesRoot);
        const misplacedSubjects: string[] = [];
        const moduleImportPattern = /(?:from\s+|import\(\s*)['"](@app\/modules\/(?:pdf-viewer|workspace-shell)\/[^'"]+)['"]/g;

        for (const testFile of legacyTests) {
            const content = await readFile(testFile, 'utf8');
            const testStem = path.basename(testFile, '.test.ts');

            for (const match of content.matchAll(moduleImportPattern)) {
                const moduleSpecifier = match[1];

                if (moduleSpecifier === undefined) {
                    continue;
                }

                const moduleStem = path.basename(moduleSpecifier).replace(/\.[cm]?[jt]sx?$/, '');

                if (testStem.startsWith(moduleStem)) {
                    const relativeTestFile = path.relative(process.cwd(), testFile).split(path.sep).join('/');
                    misplacedSubjects.push(`${relativeTestFile} imports ${moduleSpecifier}`);
                }
            }
        }

        expect(misplacedSubjects).toEqual([]);
    });
});
