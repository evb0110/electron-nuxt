import type { TestProjectConfiguration } from 'vitest/config';
import AutoImport from 'unplugin-auto-import/vite';
import { vitestResolveAlias } from './scripts/vitestResolveAlias';

const vitestResolveConfig = { alias: vitestResolveAlias };

const unitTestSetupFiles = ['tests/setup.ts'];
export const unitSlowTestThresholdMs = 300;
export const electronE2ETeardownTimeoutMs = 30_000;

const vitestProjectNames = {
    unit: 'unit',
    bundleIntegrity: 'bundle-integrity',
    electronE2ESmoke: 'e2e-smoke',
    electronE2EDrawShapes: 'e2e-draw-shapes',
    electronE2ELargePdf: 'e2e-large-pdf',
    electronE2ERapidNavigation: 'e2e-rapid-navigation',
    electronE2EQuarantine: 'e2e-quarantine',
} as const;

const bundleIntegrityTestFiles = ['tests/unit/electron/bundleIntegrity.test.ts'];
const landingUnitTestFiles = ['tests/unit/landing/**/*.test.ts'];

const electronE2ESmokeTestFiles = [
    'tests/e2e/electron/startupHydration.e2e.test.ts',
    'tests/e2e/electron/recentFiles.e2e.test.ts',
    'tests/e2e/electron/viewerSmoke.e2e.test.ts',
    'tests/e2e/electron/inactivePdfTabs.e2e.test.ts',
    'tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts',
    'tests/e2e/electron/annotationLifecycle.e2e.test.ts',
    'tests/e2e/electron/squigglyMarkup.e2e.test.ts',
];

const electronE2EDrawShapeTestFiles = ['tests/e2e/electron/drawShapeLifecycle.e2e.test.ts'];
const electronE2ELargePdfTestFiles = ['tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts'];
const electronE2ERapidNavigationTestFiles = ['tests/e2e/electron/rapidPdfNavigation.e2e.test.ts'];
const electronE2EQuarantineTestFiles = ['tests/e2e/electron/quarantine/**/*.e2e.test.ts'];

function createUnitAutoImportPlugin() {
    return AutoImport({
        imports: [
            'vue',
            { 'vue-i18n': ['useI18n'] },
        ],
        dirs: ['app/composables/**'],
    });
}

function createUnitTestProject() {
    return {
        plugins: [createUnitAutoImportPlugin()],
        resolve: vitestResolveConfig,
        test: {
            name: vitestProjectNames.unit,
            include: ['tests/unit/**/*.test.ts'],
            exclude: [
                ...bundleIntegrityTestFiles,
                ...landingUnitTestFiles,
            ],
            globals: false,
            setupFiles: unitTestSetupFiles,
        },
    } satisfies TestProjectConfiguration;
}

function createBundleIntegrityTestProject() {
    return {
        resolve: vitestResolveConfig,
        test: {
            name: vitestProjectNames.bundleIntegrity,
            include: bundleIntegrityTestFiles,
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
            retry: process.env.CI ? 2 : 1,
            testTimeout: 90_000,
            hookTimeout: 150_000,
            sequence: { concurrent: false },
        },
    } satisfies TestProjectConfiguration;
}

export const vitestProjects = [
    createUnitTestProject(),
    createBundleIntegrityTestProject(),
    createElectronE2ETestProject(vitestProjectNames.electronE2ESmoke, electronE2ESmokeTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EDrawShapes, electronE2EDrawShapeTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ELargePdf, electronE2ELargePdfTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2ERapidNavigation, electronE2ERapidNavigationTestFiles),
    createElectronE2ETestProject(vitestProjectNames.electronE2EQuarantine, electronE2EQuarantineTestFiles),
] satisfies TestProjectConfiguration[];
