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

const splitQualityCommands = [
    'pnpm run lint',
    'pnpm run check:static:reports',
    'pnpm run check:static:assets',
    'pnpm run typecheck',
    'pnpm run typecheck:coverage',
    'pnpm run build:strict:no-wasm-check',
    'pnpm run fallow',
    'pnpm run fallow:dupes',
];

function escapeRegExp(source: string) {
    return source.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function expectNoExactRunStep(job: string, command: string) {
    expect(job).not.toMatch(new RegExp(`run: ${escapeRegExp(command)}(?:\\s|$)`, 'u'));
}

function expectRunSteps(job: string, commands: string[]) {
    for (const command of commands) {
        expect(job).toContain(`run: ${command}`);
    }
}

function expectSplitQualitySteps(job: string) {
    expect(job).not.toContain('run: pnpm run validate');
    expectNoExactRunStep(job, 'pnpm run test:unit');
    expectNoExactRunStep(job, 'pnpm run build:strict');
    expectRunSteps(job, splitQualityCommands);
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

        expect(workflow).toContain('push:');
        expect(workflow).toContain('branches:');
        expect(workflow).toContain('- main');
        expect(workflow).toContain('schedule:');
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).toContain('pull_request:');
        expect(workflow).toContain('name: Quality Gates');
        expect(prQuality).toContain('if: ${{ github.event_name == \'pull_request\' || github.event_name == \'push\' }}');
        expect(prQuality).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        expect(prQuality).toContain('run: pnpm --dir landing install --frozen-lockfile');
        expect(prQuality).not.toContain('playwright install');
        expect(prQuality).toContain('run: pnpm run lint');
        expect(prQuality).not.toContain('run: pnpm run check:static:reports');
        expect(prQuality).not.toContain('run: pnpm run check:static:assets');
        expect(packageJson).toContain('"lint": "pnpm run lint:eslint && pnpm run lint:style && pnpm run check:static:fast"');
        expect(packageJson).toContain('"lint:eslint": "eslint app electron packages scripts server tests eslint-plugin-custom.mjs vitest.config.ts vitest.shared.config.ts --max-warnings=0 --report-unused-disable-directives"');
        expect(packageJson).toContain('"lint:style": "stylelint \\"app/**/*.{vue,scss,css}\\""');
        expect(packageJson).toContain('"check:static:fast": "pnpm run check:github-actions-syntax && pnpm run check:platform-api-generated');
        expect(packageJson).toContain('"check:github-actions-syntax": "pnpm exec tsx scripts/checkGithubActionsSyntax.ts"');
        expect(packageJson).toContain('pnpm run check:native-tool-protocols');
        expect(packageJson).toContain('"check:static:reports": "pnpm run check:platform-manifest-consumers"');
        expect(packageJson).toContain('"check:static:assets": "pnpm run check:web-deploy-source && pnpm run check:ocr-language-model-registry && pnpm run check:vendor-sync"');
        expect(prQuality).toContain('run: pnpm run typecheck');
        expect(prQuality).toContain('run: pnpm run test:unit');
        expect(packageJson).toContain('"test:unit": "vitest run --project unit-core --project unit-app --project unit-electron --project unit-scripts --project unit-policy"');
        expect(packageJson).toContain('"test:unit:core": "vitest run --project unit-core"');
        expect(packageJson).toContain('"test:unit:app": "vitest run --project unit-app"');
        expect(packageJson).toContain('"test:unit:electron": "vitest run --project unit-electron"');
        expect(packageJson).toContain('"test:unit:scripts": "vitest run --project unit-scripts"');
        expect(packageJson).toContain('"test:unit:policy": "vitest run --project unit-policy"');
        expect(prQuality).not.toContain('rustup target add');
        expect(prQuality).not.toContain('run: pnpm run build:strict');
        expect(prQuality).not.toContain('run: pnpm run build:strict:no-wasm-check');
        expect(prQuality).toContain('run: pnpm run test:coverage');
        expect(prQuality).toContain('if: ${{ github.event_name == \'push\' }}');
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
        expectSplitQualitySteps(workflowJob(workflow, 'manual_quality'));
        expect(workflowJob(workflow, 'manual_quality')).toContain('run: pnpm run test:coverage');
        expect(workflowJob(workflow, 'manual_quality')).toContain('run: pnpm --dir landing install --frozen-lockfile');
        expect(workflowJob(workflow, 'manual_quality')).not.toContain('playwright install');
        expect(releaseWorkflow).not.toContain('test:coverage');
        expect(packageJson).not.toMatch(/"gate:commit":\s*"[^"]*coverage/u);
    });

    it('keeps expensive PR and push checks path-filtered from checked-in policy', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const testsTsconfig = await readTsConfigJsonWithGlobs('tests/tsconfig.json');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(workflowJob(workflow, 'pr_changed_areas')).toContain('if: ${{ github.event_name == \'pull_request\' || github.event_name == \'push\' }}');
        expect(workflow).toContain('name: Changed Area Detection');
        expect(workflowJob(workflow, 'pr_changed_areas'))
            .toContain('node scripts/ci/classify-changed-areas.mjs --base="$base_sha" --head="$head_sha"');
        expect(workflowJob(workflow, 'pr_changed_areas')).toContain('PUSH_BEFORE_SHA: ${{ github.event.before }}');
        expect(workflowJob(workflow, 'pr_changed_areas')).toContain('fetch-depth: 0');
        expect(workflowJob(workflow, 'pr_changed_areas')).not.toContain('dorny/paths-filter');
        expect(workflowJob(workflow, 'pr_changed_areas')).not.toContain('native/**');
        expect(workflowJob(workflow, 'pr_electron_blocking_smoke')).toContain('needs.pr_changed_areas.outputs.electron_smoke == \'true\'');
        expect(workflowJob(workflow, 'pr_browser_integration')).toContain('needs.pr_changed_areas.outputs.browser_integration == \'true\'');
        expect(workflowJob(workflow, 'pr_browser_integration')).toContain('run: pnpm run test:integration:browser');
        expect(workflowJob(workflow, 'pr_browser_integration')).toContain('playwright install --with-deps chromium');
        expect(workflow).toContain('name: Native And Build Safety');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('needs: pr_changed_areas');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('needs.pr_changed_areas.outputs.native_or_build == \'true\'');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('run: pnpm run test:rust');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('run: pnpm run build:strict');
        expect(workflowJob(workflow, 'pr_native_build_safety')).not.toContain('run: pnpm run build:strict:no-wasm-check');
        expect(workflowJob(workflow, 'pr_native_build_safety')).not.toContain('run: pnpm run test:e2e');
        expect(workflow).toContain('name: Native Rust Tests');
        expect(workflowJob(workflow, 'manual_native')).toContain('if: ${{ github.event_name == \'workflow_dispatch\' }}');
        expect(workflowJob(workflow, 'manual_native')).toContain('run: pnpm run test:rust');
        expect(workflow).toContain('name: Landing Quality Gates');
        expect(workflow).toContain('name: Landing Quality Gates For Changed Sources');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('needs.pr_changed_areas.outputs.landing == \'true\'');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run check:vendor');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run lint');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run typecheck');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run build');
        expect(workflowJob(workflow, 'pr_landing_quality')).not.toContain('continue-on-error: true');
        expect(workflowJob(workflow, 'manual_landing')).toContain('if: ${{ github.event_name == \'workflow_dispatch\' }}');
        expect(workflowJob(workflow, 'manual_landing')).not.toContain('continue-on-error: true');
        expect(sharedVitestConfig).toContain('tests/unit/landing/**/*.test.ts');
        expect(testsTsconfig.exclude).toContain('./unit/landing/**/*.ts');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('python -m pip install --require-hashes --only-binary=:all:');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('-r python/page-processor/requirements-lock.txt');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run test:python-page-processor');
    });

    it('runs regular packaged-content verification against extracted Store AppX contents', async () => {
        const storeWorkflow = await readProjectFile('.github/workflows/store-appx.yml');
        const extractIndex = storeWorkflow.indexOf('Get-Command makeappx.exe -ErrorAction SilentlyContinue');
        const nativeVerifyIndex = storeWorkflow.indexOf('bash scripts/verify-packaged-native-tools.sh win');
        const contentsVerifyIndex = storeWorkflow.indexOf('node scripts/release/assert-packaged-app-contents.mjs');

        expect(extractIndex).toBeGreaterThan(-1);
        expect(storeWorkflow).toContain('${env:ProgramFiles(x86)}');
        expect(storeWorkflow).toContain('Windows Kits\\10\\bin');
        expect(storeWorkflow).toContain('Where-Object { $_.FullName -match \'[\\\\/]x64[\\\\/]makeappx\\.exe$\' }');
        expect(storeWorkflow).toContain('& $makeAppxPath unpack /o /p $packages[0].FullName /d $extractDir');
        expect(storeWorkflow).not.toContain('tar.exe -xf $packages[0].FullName');
        expect(nativeVerifyIndex).toBeGreaterThan(extractIndex);
        expect(contentsVerifyIndex).toBeGreaterThan(nativeVerifyIndex);
        expect(storeWorkflow).toContain('".tmp/store-appx-${{ matrix.arch }}"');
    });

    it('verifies release build artifacts before upload', async () => {
        const workflow = await readProjectFile('.github/workflows/build.yml');
        const macSigningScript = await readProjectFile('scripts/release/configure-macos-signing.sh');
        const macCertificateImportScript = await readProjectFile('scripts/release/import-macos-codesign-certificate.sh');
        const verifyStep = workflow.slice(
            workflow.indexOf('- name: Verify release artifacts'),
            workflow.indexOf('- name: Upload artifacts'),
        );
        const dmgNotarizationStep = workflow.slice(
            workflow.indexOf('- name: Notarize and staple macOS disk images'),
            workflow.indexOf('- name: Verify macOS signature'),
        );

        expect(verifyStep).toContain('node scripts/release/assert-build-artifacts.mjs release "${{ matrix.platform }}" "${{ matrix.arch }}"');
        expect(verifyStep).toContain('EVB_RELEASE_HAS_MAC_SIGNING');
        expect(verifyStep).toContain('EVB_RELEASE_HAS_WINDOWS_SIGNING');
        expect(verifyStep).not.toContain('CSC_LINK');
        expect(verifyStep).not.toContain('WIN_CSC_LINK');
        expect(dmgNotarizationStep).toContain('bash scripts/release/import-macos-codesign-certificate.sh');
        expect(dmgNotarizationStep).toContain('node scripts/release/notarize-macos-dmgs.mjs release');
        expect(workflow).toContain('::error::Partial WIN_CSC_* secrets detected; set both WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD or neither');
        expect(workflow).toContain('name: Verify packaged Linux x64 core PDF journey');
        expect(workflow).toContain('if: runner.os == \'Linux\' && matrix.arch == \'x64\'');
        expect(workflow).toContain('xvfb-run -a pnpm run test:packaged-core-pdf-smoke -- --executable release/linux-unpacked/evb-viewer');
        expect(workflow).toContain('pnpm run test:packaged-core-pdf-smoke -- --executable "release/win-unpacked/EVB Viewer.exe"');
        expect(workflow).toContain('unpacked_dir="win-arm64-unpacked"');
        expect(workflow).toContain('"release/${unpacked_dir}/resources/app.asar"');
        expect(workflow).toContain('pnpm run test:packaged-core-pdf-smoke -- --executable "release/mac-arm64/EVB Viewer.app/Contents/MacOS/EVB Viewer"');
        expect(workflow).toContain('name: Verify signed bundle through LaunchServices');
        expect(workflow).toContain('if: runner.os == \'macOS\' && env.MAC_EXPECT_DEVELOPER_ID == \'true\'');
        expect(workflow).toContain('bash scripts/verify-macos-launchservices-startup.sh "${{ matrix.platform }}" "${{ matrix.arch }}"');
        expect(workflow).toContain('name: Upload macOS LaunchServices diagnostics');
        expect(workflow).toContain('.devkit/test/macos-launchservices-startup/**');
        expect(macSigningScript).toContain('if [ "${CI:-}" = "true" ]; then');
        expect(macSigningScript).toContain('::error::$message');
        expect(macSigningScript).toContain('Partial macOS signing credentials detected; set both CSC_LINK and CSC_KEY_PASSWORD or neither');
        expect(macSigningScript).toContain('Partial APPLE_API_* secrets detected; set APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER or none of them');
        expect(macCertificateImportScript).toContain('security create-keychain');
        expect(macCertificateImportScript).toContain('security import "$certificate_path"');
        expect(macCertificateImportScript).toContain('security set-key-partition-list');
        expect(macCertificateImportScript).toContain('Developer ID Application');
    });

    it('keeps release quality gates from requiring pre-bundle host Linux resources', async () => {
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const qualityJob = workflowJob(releaseWorkflow, 'quality');

        expect(releaseWorkflow).not.toContain('tags:');
        expect(releaseWorkflow).toContain('workflow_dispatch:');
        expect(releaseWorkflow).toContain('target_ref:');
        expect(releaseWorkflow).toContain('git rev-parse --verify "${DISPATCH_TARGET_REF}^{commit}"');
        expect(releaseWorkflow).toContain('"repos/${GITHUB_REPOSITORY}/commits/${DISPATCH_TARGET_REF}"');
        expect(releaseWorkflow).toContain('git checkout --detach "$target_sha"');
        expect(qualityJob).toContain('run: rustup target add wasm32-unknown-unknown');
        expect(qualityJob).toContain('EVB_NATIVE_TOOLS_ALLOW_HOST_CI_GEN: \'1\'');
        expect(qualityJob).toContain('run: pnpm --dir landing install --frozen-lockfile');
        expect(qualityJob).toContain('run: pnpm exec playwright install --with-deps chromium');
        expect(qualityJob).toContain('run: pnpm run release:verify:checks');
        const publishJob = workflowJob(releaseWorkflow, 'publish');
        expect(publishJob).toContain('gh release create "$RELEASE_TAG" artifacts/* --draft --generate-notes --target "$TARGET_SHA"');
        expect(publishJob).toContain('gh release download "$RELEASE_TAG" --dir downloaded-assets');
        expect(publishJob).toContain('sha256sum "$source"');
        expect(publishJob).toContain('gh release edit "$RELEASE_TAG" --draft=false');
    });

    it('keeps artifact-only release builds reusable and non-publishing', async () => {
        const workflow = await readProjectFile('.github/workflows/release-artifacts.yml');
        const qualityJob = workflowJob(workflow, 'quality');

        expect(workflow).toContain('name: Build Release Artifacts');
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).toContain('target_ref:');
        expect(workflow).toContain('permissions:\n  contents: read');
        expect(workflow).not.toContain('contents: write');
        expect(workflow).toContain('git rev-parse --verify "${DISPATCH_TARGET_REF}^{commit}"');
        expect(workflow).toContain('"repos/${GITHUB_REPOSITORY}/commits/${DISPATCH_TARGET_REF}"');
        expect(qualityJob).toContain('run: pnpm run release:verify:checks');
        expect(qualityJob).toContain('run: pnpm --dir landing install --frozen-lockfile');
        expect(qualityJob).toContain('run: pnpm exec playwright install --with-deps chromium');
        expect(workflowJob(workflow, 'build_artifacts')).toContain('uses: ./.github/workflows/build.yml');
        expect(workflowJob(workflow, 'build_mac_intel')).toContain('uses: ./.github/workflows/build-mac-intel.yml');
        expect(workflowJob(workflow, 'build_win7_legacy')).toContain('uses: ./.github/workflows/build-win7-legacy.yml');
        expect(workflowJob(workflow, 'build_store')).toContain('uses: ./.github/workflows/store-appx.yml');
        expect(workflowJob(workflow, 'build_store')).toContain('submit: false');
        expect(workflow).not.toContain('gh release create');
        expect(workflow).not.toContain('gh release upload');
        expect(workflow).not.toContain('Package and Submit Microsoft Store AppX');
        expect(workflowJob(workflow, 'summarize')).toContain('#artifacts');
    });

    it('keeps release cutting dispatch-based instead of tag-push based', async () => {
        const releaseScript = await readProjectFile('scripts/release/cut-release.mjs');

        expect(releaseScript).toContain('`release: ${version} [skip ci]`');
        expect(releaseScript).toContain('\'workflow\'');
        expect(releaseScript).toContain('\'run\'');
        expect(releaseScript).toContain('\'release.yml\'');
        expect(releaseScript).toContain('`target_ref=${targetSha}`');
        expect(releaseScript).toContain('waitForWorkflowRunStart');
        expect(releaseScript).not.toContain('wait-for-github-release.mjs');
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
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run check:wasm:portable');
        expectSplitQualitySteps(workflowJob(workflow, 'nightly_maintenance'));
        expect(workflow).toContain('run: pnpm run test:rust');
        expect(workflow).toContain('run: pnpm run test:coverage');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run check:static:assets');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run check:production-dependency-audit');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm --dir landing install --frozen-lockfile');
        expect(workflowJob(workflow, 'nightly_maintenance')).not.toContain('playwright install');
        expect(workflowJob(workflow, 'manual_quality')).not.toContain('run: pnpm run check:production-dependency-audit');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('python -m pip install --require-hashes --only-binary=:all:');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('-r python/page-processor/requirements-lock.txt');
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
        const artifactAction = await readProjectFile('.github/actions/upload-electron-e2e-artifacts/action.yml');
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const packageJson = await readProjectFile('package.json');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(workflow).toContain('name: Nightly Electron E2E Regression');
        expect(workflow).not.toContain('name: Nightly Electron E2E Smoke');
        expect(workflow).toContain('runs-on: macos-14');
        expect(workflow).toContain('continue-on-error: true');
        expect(workflowJob(workflow, 'nightly_electron_e2e_regression')).not.toContain('EVB_E2E_REQUIRE_DJVU_FIXTURE');
        expect(workflowJob(workflow, 'nightly_electron_e2e_regression')).toContain('run: pnpm run test:e2e:electron:regression');
        expectNoExactRunStep(workflowJob(workflow, 'nightly_electron_e2e_regression'), 'pnpm run test:e2e:electron');
        expect(workflow).toContain('name: Nightly Electron E2E Rapid Navigation');
        expect(workflowJob(workflow, 'nightly_electron_e2e_regression')).toContain('run: pnpm run check:electron:install');
        expect(workflowJob(workflow, 'nightly_electron_e2e_rapid_navigation')).toContain('run: pnpm run check:electron:install');
        expect(workflow).toMatch(/nightly_electron_e2e_rapid_navigation:[\s\S]*if: \$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}[\s\S]*continue-on-error: true[\s\S]*run: pnpm run test:e2e:electron:rapid-navigation/u);
        expect(workflow).toContain('name: Nightly Electron E2E Large PDF');
        expect(workflowJob(workflow, 'nightly_electron_e2e_large_pdf')).toContain('run: pnpm run check:electron:install');
        expect(workflowJob(workflow, 'nightly_electron_e2e_large_pdf')).toContain('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1');
        expect(workflowJob(workflow, 'nightly_electron_e2e_large_pdf')).toContain('EVB_E2E_REQUIRE_NATIVE_LARGE_PDF_FIXTURE=1');
        expect(workflow).toMatch(/nightly_electron_e2e_large_pdf:[\s\S]*if: \$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}[\s\S]*continue-on-error: true[\s\S]*run: pnpm run test:e2e:electron:large/u);
        expect(packageJson).toContain('"test:e2e:electron:large:no-build": "EVB_PDF_PAGE_OPS_ENABLE=1 EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1 vitest run --project e2e-large-pdf --reporter verbose"');
        expect(packageJson).toContain('"test:e2e:electron:large": "pnpm run build:pdf-page-ops');
        expect(workflow).toContain('name: Nightly Electron E2E Quarantine');
        expect(workflowJob(workflow, 'nightly_electron_e2e_quarantine')).toContain('run: pnpm run check:electron:install');
        expect(workflow).toContain('run: pnpm run test:e2e:electron:quarantine');
        expect(workflow).toContain('name: Nightly Electron E2E Visible Window');
        expect(workflowJob(workflow, 'nightly_electron_e2e_visible_window')).toContain('runs-on: macos-14');
        expect(workflowJob(workflow, 'nightly_electron_e2e_visible_window')).toContain('run: pnpm run test:e2e:electron:visible-window');
        expect(packageJson).toContain('"test:e2e:electron:visible-window:no-build": "vitest run --project e2e-visible-window --reporter verbose"');
        expect(sharedVitestConfig).toContain('electronE2EVisibleWindow: \'e2e-visible-window\'');
        expect(workflow).toContain('EVB_E2E_PRESERVE_ARTIFACTS: \'1\'');
        for (const jobName of [
            'pr_electron_blocking_smoke',
            'nightly_electron_e2e_regression',
            'nightly_electron_e2e_rapid_navigation',
            'nightly_electron_e2e_large_pdf',
            'nightly_electron_e2e_quarantine',
            'nightly_electron_e2e_visible_window',
        ]) {
            const job = workflowJob(workflow, jobName);
            expect(job).toContain('if: ${{ always() }}');
            expect(job).toContain('uses: ./.github/actions/upload-electron-e2e-artifacts');
        }
        expect(artifactAction).toContain('uses: actions/upload-artifact@v7');
        expect(artifactAction).toContain('include-hidden-files: true');
        expect(artifactAction).toContain('.devkit/sessions/e2e-*/screenshots/**');
        expect(artifactAction).toContain('.devkit/test/electron-e2e-artifacts/**');
        expect(artifactAction).toContain('.devkit/scratch/dev-server-logs/e2e-*/**');
        expect(artifactAction).not.toContain('electron-user-data');
        expect(workflow).toContain('name: Nightly PDF Tab Diagnostics');
        expect(workflowJob(workflow, 'nightly_pdf_tabs_diagnostics')).toContain('run: pnpm run check:electron:install');
        expect(workflow).toMatch(/nightly_pdf_tabs_diagnostics:[\s\S]*if: \$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}[\s\S]*continue-on-error: true[\s\S]*run: pnpm run diag:pdf-tabs:ci/u);
        expect(workflow).toContain('run: pnpm run diag:pdf-tabs:ci');
        expect(packageJson).toContain('"test:e2e:electron:regression:no-build": "vitest run --project e2e-regression --reporter verbose"');
        expect(packageJson).not.toContain('"test:e2e:electron:smoke:no-build"');
        expect(packageJson).toContain('"test:e2e:electron:quarantine:no-build": "vitest run --project e2e-quarantine --passWithNoTests --reporter verbose"');
        expect(sharedVitestConfig).toContain('retry: process.env.CI ? 2 : 1');
        expect(sharedVitestConfig).toContain('electronE2ERegression: \'e2e-regression\'');
        expect(sharedVitestConfig).not.toContain('electronE2ESmoke: \'e2e-smoke\'');
        expect(releaseWorkflow).not.toContain('test:e2e:electron');
        expect(releaseWorkflow).not.toContain('diag:pdf-tabs');
    });

    it('keeps coverage config wired to an actual gate and free of stale path overrides', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const packageJson = await readProjectFile('package.json');
        const vitestConfig = await readProjectFile('vitest.config.ts');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(workflow).toContain('run: pnpm run test:coverage');
        expectNoExactRunStep(workflowJob(workflow, 'manual_quality'), 'pnpm run test:unit');
        expectNoExactRunStep(workflowJob(workflow, 'nightly_maintenance'), 'pnpm run test:unit');
        expect(packageJson).toContain('"test:coverage": "pnpm run test:coverage:run && pnpm run check:coverage:ratchet && pnpm run check:coverage:zero-execution"');
        expect(packageJson).toContain('"test:coverage:run": "vitest run --coverage --project unit-core --project unit-app --project unit-electron --project unit-scripts --project unit-policy"');
        expect(packageJson).not.toContain('"test:coverage:run": "vitest run --coverage --project unit"');
        expect(packageJson).toContain('"check:coverage:zero-execution": "pnpm exec tsx scripts/checkZeroExecutionCoverage.ts"');
        expect(packageJson).toContain('"check:coverage:ratchet": "pnpm exec tsx scripts/checkCoverageRatchet.ts"');
        expect(vitestConfig).toContain('provider: \'v8\'');
        expect(vitestConfig).toContain('include: [');
        expect(vitestConfig).toContain('\'app/**/*.ts\'');
        expect(vitestConfig).toContain('\'electron/**/*.ts\'');
        expect(vitestConfig).toContain('\'packages/**/*.ts\'');
        expect(vitestConfig).toContain('\'json-summary\'');
        expect(vitestConfig).toContain('slowTestThreshold: unitSlowTestThresholdMs');
        expect(sharedVitestConfig).toContain('unitSlowTestThresholdMs = 300');
        expect(vitestConfig).not.toContain('explicitImportOnlyFiles');
        expect(vitestConfig).not.toContain('app/composables/page/**/*.ts');
        expect(existsSync(path.join(process.cwd(), 'coverage-baseline.json'))).toBe(true);
    });

    it('keeps real-browser tests in their dedicated project', async () => {
        const packageJson = await readProjectFile('package.json');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(packageJson).toContain('"test:integration:browser": "vitest run --project browser-integration"');
        expect(sharedVitestConfig).toContain('tests/integration/browser/**/*.test.ts');
        expect(sharedVitestConfig).toContain('browserIntegration: \'browser-integration\'');
        expect(existsSync(path.join(process.cwd(), 'tests/integration/browser/realIndexedDbMigration.test.ts'))).toBe(true);
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
