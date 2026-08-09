import type { TestProjectConfiguration } from 'vitest/config';
import AutoImport from 'unplugin-auto-import/vite';
import Vue from '@vitejs/plugin-vue';
import { vitestResolveAlias } from './scripts/vitestResolveAlias';

const vitestResolveConfig = { alias: vitestResolveAlias };

const unitTestSetupFiles = ['tests/setup.ts'];
export const unitSlowTestThresholdMs = 300;
export const electronE2ETeardownTimeoutMs = 30_000;

const vitestProjectNames = {
    unitCore: 'unit-core',
    unitApp: 'unit-app',
    unitElectron: 'unit-electron',
    unitScripts: 'unit-scripts',
    unitPolicy: 'unit-policy',
    browserIntegration: 'browser-integration',
    electronBundleStaticIntegrity: 'electron-bundle-static-integrity',
    electronE2ERegression: 'e2e-regression',
    electronE2EBlockingSmoke: 'e2e-blocking-smoke',
    electronE2EDrawShapes: 'e2e-draw-shapes',
    electronE2ELargePdf: 'e2e-large-pdf',
    electronE2ERapidNavigation: 'e2e-rapid-navigation',
    electronE2EVisibleWindow: 'e2e-visible-window',
    electronE2EQuarantine: 'e2e-quarantine',
    electronE2ESavePipeline: 'e2e-save-pipeline',
} as const;

const electronBundleStaticIntegrityTestFiles = ['tests/unit/electron/bundleIntegrity.test.ts'];
const browserIntegrationTestFiles = ['tests/integration/browser/**/*.test.ts'];
const landingUnitTestFiles = ['tests/unit/landing/**/*.test.ts'];
const unitPolicyTestFiles = [
    'tests/unit/scripts/*Policy.test.ts',
    'tests/unit/scripts/electronE2eSmokeConfig.test.ts',
    'tests/unit/scripts/packageScripts.test.ts',
];

const electronE2ESmokeTestFiles = [
    'tests/e2e/electron/prBlockingSmoke.e2e.test.ts',
    'tests/e2e/electron/performanceProfileVisuals.e2e.test.ts',
    'tests/e2e/electron/startupHydration.e2e.test.ts',
    'tests/e2e/electron/recentFiles.e2e.test.ts',
    'tests/e2e/electron/viewerSmoke.e2e.test.ts',
    'tests/e2e/electron/djvuPrintHandoff.e2e.test.ts',
    'tests/e2e/electron/inactivePdfTabs.e2e.test.ts',
    'tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts',
    'tests/e2e/electron/annotationLifecycle.e2e.test.ts',
    'tests/e2e/electron/squigglyMarkup.e2e.test.ts',
];

const electronE2EBlockingSmokeTestFiles = ['tests/e2e/electron/blockingPdfSaveSmoke.e2e.test.ts'];
const electronE2EDrawShapeTestFiles = ['tests/e2e/electron/drawShapeLifecycle.e2e.test.ts'];
const electronE2ELargePdfTestFiles = [
    'tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts',
    'tests/e2e/electron/largePdfNativePreview.e2e.test.ts',
    'tests/e2e/electron/nativePdfSplitPaneLifecycle.e2e.test.ts',
];
const electronE2ERapidNavigationTestFiles = ['tests/e2e/electron/rapidPdfNavigation.e2e.test.ts'];
const electronE2EVisibleWindowTestFiles = ['tests/e2e/electron/visibleWindowLifecycle.e2e.test.ts'];
const electronE2EQuarantineTestFiles = ['tests/e2e/electron/quarantine/**/*.e2e.test.ts'];
const electronE2ESavePipelineTestFiles = [
    'tests/e2e/electron/savePipeline.e2e.test.ts',
    'tests/e2e/electron/savePipelineBenchmark.e2e.test.ts',
];

function createUnitAutoImportPlugin() {
    return AutoImport({
        imports: [
            'vue',
            { 'vue-i18n': ['useI18n'] },
        ],
        dirs: ['app/composables/**'],
    });
}

function createUnitTestProject(
    name: string,
    include: string[],
    {
        autoImport = false,
        vueComponents = false,
        exclude = [],
        setupFiles,
    }: {
        autoImport?: boolean;
        vueComponents?: boolean;
        exclude?: string[];
        setupFiles?: string[];
    } = {},
) {
    return {
        plugins: [
            ...(vueComponents ? [Vue()] : []),
            ...(autoImport ? [createUnitAutoImportPlugin()] : []),
        ],
        resolve: vitestResolveConfig,
        ...(name === vitestProjectNames.unitCore ? {esbuild: {tsconfigRaw: '{}'}} : {}),
        test: {
            name,
            include,
            exclude: [
                ...electronBundleStaticIntegrityTestFiles,
                ...landingUnitTestFiles,
                ...exclude,
            ],
            globals: false,
            ...(setupFiles ? { setupFiles } : {}),
        },
    } satisfies TestProjectConfiguration;
}

function createBundleIntegrityTestProject() {
    return {
        resolve: vitestResolveConfig,
        test: {
            name: vitestProjectNames.electronBundleStaticIntegrity,
            include: electronBundleStaticIntegrityTestFiles,
            globals: false,
            setupFiles: unitTestSetupFiles,
        },
    } satisfies TestProjectConfiguration;
}

function createElectronE2ETestProject(
    name: string,
    include: string[],
) {
    return {
        resolve: vitestResolveConfig,
        test: {
            name,
            include,
            globalSetup: ['tests/e2e/electron/globalSetup.ts'],
            globals: false,
            fileParallelism: false,
            maxWorkers: 1,
            retry: process.env.CI
                ? {
                    condition: /\[INFRA\]/u,
                    count: 2,
                }
                : 0,
            testTimeout: 90_000,
            hookTimeout: 150_000,
            sequence: { concurrent: false },
        },
    } satisfies TestProjectConfiguration;
}

export const vitestProjects = [
    createUnitTestProject(
        vitestProjectNames.unitCore,
        [
            'tests/unit/contracts/**/*.test.ts',
            'tests/unit/helpers/**/*.test.ts',
            'tests/unit/i18n/**/*.test.ts',
            'tests/unit/packages/**/*.test.ts',
            'tests/unit/pdf/**/*.test.ts',
            'tests/unit/pdf-core/**/*.test.ts',
            'tests/unit/pdf-viewer/**/*.test.ts',
            'tests/unit/server/**/*.test.ts',
        ],
        { autoImport: true },
    ),
    createUnitTestProject(
        vitestProjectNames.browserIntegration,
        browserIntegrationTestFiles,
    ),
    createUnitTestProject(
        vitestProjectNames.unitApp,
        ['tests/unit/app/**/*.test.ts'],
        {
            autoImport: true,
            vueComponents: true,
            setupFiles: unitTestSetupFiles,
        },
    ),
    createUnitTestProject(
        vitestProjectNames.unitElectron,
        [
            'tests/unit/e2e/**/*.test.ts',
            'tests/unit/electron/**/*.test.ts',
        ],
    ),
    createUnitTestProject(
        vitestProjectNames.unitScripts,
        ['tests/unit/scripts/**/*.test.ts'],
        { exclude: unitPolicyTestFiles },
    ),
    createUnitTestProject(
        vitestProjectNames.unitPolicy,
        unitPolicyTestFiles,
    ),
    createBundleIntegrityTestProject(),
    createElectronE2ETestProject(vitestProjectNames.electronE2ERegression, electronE2ESmokeTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EBlockingSmoke, electronE2EBlockingSmokeTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EDrawShapes, electronE2EDrawShapeTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ELargePdf, electronE2ELargePdfTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ERapidNavigation, electronE2ERapidNavigationTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EVisibleWindow, electronE2EVisibleWindowTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EQuarantine, electronE2EQuarantineTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ESavePipeline, electronE2ESavePipelineTestFiles),
] satisfies TestProjectConfiguration[];
