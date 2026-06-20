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

async function readProjectFile(filePath: string) {
    return readFile(path.join(process.cwd(), filePath), 'utf8');
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
    it('runs the fast feedback lane on direct pushes to main', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const packageJson = await readProjectFile('package.json');

        expect(workflow).toContain('push:\n    branches:\n      - main');
        expect(workflow).toContain('schedule:');
        expect(workflow).not.toContain('pull_request:');
        expect(workflow).toContain('name: Push Quality Gates');
        expect(workflowJob(workflow, 'push_quality')).toContain('run: rustup target add wasm32-unknown-unknown');
        expect(workflowJob(workflow, 'push_quality')).toContain('run: pnpm run check:wasm:freshness');
        expect(workflow).toContain('run: pnpm run lint');
        expect(workflow).toContain('run: pnpm run typecheck');
        expect(workflow).toContain('run: pnpm run test:release');
        expect(workflowJob(workflow, 'push_quality')).not.toContain('run: pnpm run test:coverage');
        expect(releaseWorkflow).not.toContain('test:coverage');
        expect(packageJson).not.toMatch(/"gate:commit":\s*"[^"]*coverage/u);
    });

    it('keeps native, landing, and Python smoke checks path-filtered on push', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const testsTsconfig = await readProjectFile('tests/tsconfig.json');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(workflow).toContain('packages/(contracts|i18n-core|release-selection)/');
        expect(workflow).toContain('public/wasm/');
        expect(workflow).toContain('scripts/(build-pdf-image-combine|build-pdf-page-ops|build-pdf-search|check-wasm-freshness|native-rust-targets)[.]mjs');
        expect(workflow).toContain('Cargo[.]lock');
        expect(workflow).toContain('python/page-processor/');
        expect(workflow).toContain('bundle-page-processor-macos[.]sh');
        expect(workflow).toContain('devkit/(page-processing-harness|process-pdf-split-pad)[.]py');
        expect(workflow).toContain('electron-builder[.]yml');
        expect(workflow).toContain('name: Native Rust Tests');
        expect(workflow).toContain('run: pnpm run test:rust');
        expect(workflow).toContain('name: Landing Quality Gates');
        expect(workflow).toContain('run: pnpm --dir landing run check:vendor');
        expect(workflow).toContain('run: pnpm --dir landing run typecheck');
        expect(workflow).toContain('run: pnpm --dir landing run build');
        expect(workflowJob(workflow, 'landing_push')).toContain('continue-on-error: true');
        expect(sharedVitestConfig).toContain('tests/unit/landing/**/*.test.ts');
        expect(testsTsconfig).toContain('./unit/landing/**/*.ts');
        expect(workflow).toContain('name: Python Page Processor Smoke');
        expect(workflowJob(workflow, 'python_page_processor_push')).toContain('python -m pip install');
        expect(workflowJob(workflow, 'python_page_processor_push')).toContain('opencv-python-headless');
        expect(workflowJob(workflow, 'python_page_processor_push')).toContain('img2pdf');
        expect(workflowJob(workflow, 'python_page_processor_push')).toContain('Pillow');
        expect(workflow).toContain('run: pnpm run test:python-page-processor');
    });

    it('verifies release build artifacts before upload', async () => {
        const workflow = await readProjectFile('.github/workflows/build.yml');
        const verifyStep = workflow.slice(
            workflow.indexOf('- name: Verify release artifacts'),
            workflow.indexOf('- name: Upload artifacts'),
        );

        expect(verifyStep).toContain('node scripts/release/assert-build-artifacts.mjs release "${{ matrix.platform }}" "${{ matrix.arch }}"');
        expect(verifyStep).toContain('EVB_RELEASE_HAS_MAC_SIGNING');
        expect(verifyStep).toContain('EVB_RELEASE_HAS_WINDOWS_SIGNING');
        expect(verifyStep).not.toContain('CSC_LINK');
        expect(verifyStep).not.toContain('WIN_CSC_LINK');
    });

    it('keeps release quality gates from requiring pre-bundle host Linux resources', async () => {
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const qualityJob = workflowJob(releaseWorkflow, 'quality');

        expect(qualityJob).toContain('EVB_NATIVE_TOOLS_ALLOW_HOST_CI_GEN: \'1\'');
        expect(qualityJob).toContain('run: pnpm run release:verify:checks');
    });

    it('runs the heavier deterministic checks in the nightly lane', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const buildWorkflow = await readProjectFile('.github/workflows/build.yml');
        const nvmrc = await readProjectFile('.nvmrc');

        expect(workflow).toContain('github.event_name == \'schedule\'');
        expect(workflow).toContain('name: Nightly Maintenance Gates');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: rustup target add wasm32-unknown-unknown');
        expect(workflow).toContain('run: pnpm run validate');
        expect(workflow).toContain('run: pnpm run test:rust');
        expect(workflow).toContain('run: pnpm run test:coverage');
        expect(workflow).toContain('run: pnpm run check:ocr-language-model-registry');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('python -m pip install');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('opencv-python-headless');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('img2pdf');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('Pillow');
        expect(workflow).toContain('run: pnpm run test:python-page-processor');
        expect(nvmrc.trim()).toBe('24.11.1');
        expect(workflow).toContain('NODE_VERSION: \'24.11.1\'');
        expect(buildWorkflow).toContain('NODE_VERSION: \'24.11.1\'');
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
        expect(workflow).toContain('name: Nightly Electron E2E Quarantine');
        expect(workflow).toContain('run: pnpm run test:e2e:electron:quarantine');
        expect(workflow).toContain('name: Nightly PDF Tab Diagnostics');
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
