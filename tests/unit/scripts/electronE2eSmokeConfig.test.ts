import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    PackageJson,
    SetRequired,
    Simplify,
} from 'type-fest';

interface IVitestProjectTestConfig {
    exclude?: string[];
    fileParallelism?: boolean;
    globalSetup?: string[];
    hookTimeout?: number;
    include?: string[];
    maxWorkers?: number;
    name?: string;
    retry?: number;
    sequence?: {concurrent?: boolean};
    setupFiles?: string[];
    testTimeout?: number;
}

interface IVitestProjectConfig {
    plugins?: unknown[];
    test?: IVitestProjectTestConfig;
}

interface IVitestSharedConfigModule { vitestProjects: IVitestProjectConfig[] }

type TPackageJsonWithScripts = Simplify<SetRequired<PackageJson, 'scripts'>>;

const vitestProjectNames = {
    unitCore: 'unit-core',
    unitApp: 'unit-app',
    unitElectron: 'unit-electron',
    unitScripts: 'unit-scripts',
    unitPolicy: 'unit-policy',
    electronE2ERegression: 'e2e-regression',
    electronE2EBlockingSmoke: 'e2e-blocking-smoke',
    electronE2EDrawShapes: 'e2e-draw-shapes',
    electronE2ELargePdf: 'e2e-large-pdf',
    electronE2ERapidNavigation: 'e2e-rapid-navigation',
    electronE2EQuarantine: 'e2e-quarantine',
} as const;

const unitCoreTestFiles = [
    'tests/unit/contracts/**/*.test.ts',
    'tests/unit/helpers/**/*.test.ts',
    'tests/unit/i18n/**/*.test.ts',
    'tests/unit/packages/**/*.test.ts',
    'tests/unit/pdf/**/*.test.ts',
    'tests/unit/pdf-core/**/*.test.ts',
    'tests/unit/pdf-viewer/**/*.test.ts',
    'tests/unit/server/**/*.test.ts',
];
const unitAppTestFiles = ['tests/unit/app/**/*.test.ts'];
const unitElectronTestFiles = [
    'tests/unit/e2e/**/*.test.ts',
    'tests/unit/electron/**/*.test.ts',
];
const unitScriptTestFiles = ['tests/unit/scripts/**/*.test.ts'];
const unitPolicyTestFiles = [
    'tests/unit/scripts/*Policy.test.ts',
    'tests/unit/scripts/electronE2eSmokeConfig.test.ts',
    'tests/unit/scripts/packageScripts.test.ts',
];

const electronE2ERegressionTestFiles = [
    'tests/e2e/electron/startupHydration.e2e.test.ts',
    'tests/e2e/electron/recentFiles.e2e.test.ts',
    'tests/e2e/electron/viewerSmoke.e2e.test.ts',
    'tests/e2e/electron/djvuPrintHandoff.e2e.test.ts',
    'tests/e2e/electron/inactivePdfTabs.e2e.test.ts',
    'tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts',
    'tests/e2e/electron/annotationLifecycle.e2e.test.ts',
    'tests/e2e/electron/squigglyMarkup.e2e.test.ts',
];

const electronE2EBlockingSmokeTestFiles = [
    'tests/e2e/electron/blockingPdfSaveSmoke.e2e.test.ts',
    'tests/e2e/electron/prBlockingSmoke.e2e.test.ts',
];
const electronE2EDrawShapeTestFiles = ['tests/e2e/electron/drawShapeLifecycle.e2e.test.ts'];
const electronE2ELargePdfTestFiles = [
    'tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts',
    'tests/e2e/electron/largePdfNativePreview.e2e.test.ts',
];
const electronE2ERapidNavigationTestFiles = ['tests/e2e/electron/rapidPdfNavigation.e2e.test.ts'];
const electronE2EQuarantineTestFiles = ['tests/e2e/electron/quarantine/**/*.e2e.test.ts'];

let importNonce = 0;

async function loadVitestSharedConfig(ci: string | undefined) {
    const previousCi = process.env.CI;

    try {
        if (ci === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = ci;
        }

        vi.resetModules();
        importNonce += 1;
        const configUrl = pathToFileURL(resolve('vitest.shared.config.ts'));
        configUrl.searchParams.set('retry-policy', importNonce.toString());
        const configModule = await import(/* @vite-ignore */ configUrl.href) as IVitestSharedConfigModule;
        return configModule;
    } finally {
        if (previousCi === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = previousCi;
        }
    }
}

function projectByName(
    config: IVitestSharedConfigModule,
    projectName: string,
) {
    const project = config.vitestProjects.find(candidate => candidate.test?.name === projectName);

    if (!project) {
        throw new Error(`Missing Vitest project: ${projectName}`);
    }

    return project;
}

function e2eProjectNames() {
    return [
        vitestProjectNames.electronE2ERegression,
        vitestProjectNames.electronE2EBlockingSmoke,
        vitestProjectNames.electronE2EDrawShapes,
        vitestProjectNames.electronE2ELargePdf,
        vitestProjectNames.electronE2ERapidNavigation,
        vitestProjectNames.electronE2EQuarantine,
    ];
}

async function readPackageJsonWithScripts(): Promise<TPackageJsonWithScripts> {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as PackageJson;
    if (!packageJson.scripts) {
        throw new Error('Missing package scripts');
    }

    return packageJson as TPackageJsonWithScripts;
}

describe('unit Vitest project topology', () => {
    it('keeps unit tests split by owner and policy lane', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const projectNames = config.vitestProjects.map(project => project.test?.name);

        expect(projectNames).not.toContain('unit');
        expect(projectByName(config, vitestProjectNames.unitCore).test?.include)
            .toEqual(unitCoreTestFiles);
        expect(projectByName(config, vitestProjectNames.unitCore).plugins)
            .toHaveLength(1);
        expect(projectByName(config, vitestProjectNames.unitApp).test?.include)
            .toEqual(unitAppTestFiles);
        expect(projectByName(config, vitestProjectNames.unitApp).plugins)
            .toHaveLength(1);
        expect(projectByName(config, vitestProjectNames.unitApp).test?.setupFiles)
            .toEqual(['tests/setup.ts']);
        expect(projectByName(config, vitestProjectNames.unitElectron).test?.include)
            .toEqual(unitElectronTestFiles);
        expect(projectByName(config, vitestProjectNames.unitScripts).test?.include)
            .toEqual(unitScriptTestFiles);
        expect(projectByName(config, vitestProjectNames.unitScripts).test?.exclude)
            .toEqual(expect.arrayContaining(unitPolicyTestFiles));
        expect(projectByName(config, vitestProjectNames.unitPolicy).test?.include)
            .toEqual(unitPolicyTestFiles);
    });
});

describe('electron e2e Vitest project topology', () => {
    it('keeps one local retry and two CI retries for startup flakes', async () => {
        const localConfig = await loadVitestSharedConfig(undefined);
        const ciConfig = await loadVitestSharedConfig('true');

        expect(e2eProjectNames().map(projectName => projectByName(localConfig, projectName).test?.retry))
            .toEqual(Array.from({ length: e2eProjectNames().length }, () => 1));
        expect(e2eProjectNames().map(projectName => projectByName(ciConfig, projectName).test?.retry))
            .toEqual(Array.from({ length: e2eProjectNames().length }, () => 2));
    });

    it('keeps the broad regression project focused and serial', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const regressionProject = projectByName(config, vitestProjectNames.electronE2ERegression);

        expect(regressionProject.test?.include).toEqual(electronE2ERegressionTestFiles);
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/blockingPdfSaveSmoke.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/drawShapeLifecycle.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/rapidPdfNavigation.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/pdfSkeletonNavigationDiagnostics.e2e.test.ts');
        expect(regressionProject.test?.include).not.toContain('tests/e2e/electron/arnoldPdfOpenDiagnostics.e2e.test.ts');
        expect(regressionProject.test?.globalSetup).toEqual(['tests/e2e/electron/globalSetup.ts']);
        expect(regressionProject.test?.fileParallelism).toBe(false);
        expect(regressionProject.test?.maxWorkers).toBe(1);
        expect(regressionProject.test?.sequence).toEqual({ concurrent: false });
        expect(regressionProject.test?.testTimeout).toBe(90_000);
        expect(regressionProject.test?.hookTimeout).toBe(150_000);
    });

    it('keeps the PR blocking smoke project separate from broad regression', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const blockingSmokeProject = projectByName(config, vitestProjectNames.electronE2EBlockingSmoke);

        expect(blockingSmokeProject.test?.include).toEqual(electronE2EBlockingSmokeTestFiles);
        expect(blockingSmokeProject.test?.include).not.toContain('tests/e2e/electron/viewerSmoke.e2e.test.ts');
    });

    it('exposes opt-in e2e subsets as named projects instead of env-mutated includes', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const sharedConfigSource = await readFile('vitest.shared.config.ts', 'utf8');
        const packageJson = await readPackageJsonWithScripts();
        const packageScripts = packageJson.scripts;
        const largePdfSource = await readFile('tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts', 'utf8');

        expect(projectByName(config, vitestProjectNames.electronE2EDrawShapes).test?.include)
            .toEqual(electronE2EDrawShapeTestFiles);
        expect(projectByName(config, vitestProjectNames.electronE2ELargePdf).test?.include)
            .toEqual(electronE2ELargePdfTestFiles);
        expect(projectByName(config, vitestProjectNames.electronE2ERapidNavigation).test?.include)
            .toEqual(electronE2ERapidNavigationTestFiles);

        for (const obsoleteEnvFlag of [
            'EVB_E2E_DRAW_SHAPES_EXTENDED',
            'EVB_E2E_LARGE_PDF_ANNOTATION_SAVE',
            'EVB_E2E_RAPID_PDF_NAVIGATION',
        ]) {
            expect(sharedConfigSource).not.toContain(obsoleteEnvFlag);
            expect(JSON.stringify(packageScripts)).not.toContain(obsoleteEnvFlag);
            expect(largePdfSource).not.toContain(obsoleteEnvFlag);
        }
        expect(packageScripts['test:e2e:electron:draw-shapes:no-build'])
            .toBe('vitest run --project e2e-draw-shapes --reporter verbose');
        expect(packageScripts['test:e2e:electron:large:no-build'])
            .toBe('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1 vitest run --project e2e-large-pdf --reporter verbose');
        expect(packageScripts['test:e2e:electron:rapid-navigation:no-build'])
            .toBe('vitest run --project e2e-rapid-navigation --reporter verbose');
        expect(packageScripts['test:e2e:electron'])
            .toBe('pnpm run build:electron && pnpm run test:e2e:electron:regression:no-build');
        expect(packageScripts['test:e2e:electron:regression:no-build'])
            .toBe('vitest run --project e2e-regression --reporter verbose');
        expect(packageScripts['test:e2e:electron:smoke:no-build']).toBeUndefined();
        expect(packageScripts['test:e2e:electron:watch'])
            .toBe('vitest --project e2e-regression --reporter verbose');
    });
});

describe('electron e2e quarantine Vitest project', () => {
    it('runs only the quarantine include group and lets the script own empty-lane handling', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const packageJson = await readPackageJsonWithScripts();
        const packageScripts = packageJson.scripts;
        const quarantineProject = projectByName(config, vitestProjectNames.electronE2EQuarantine);

        expect(quarantineProject.test?.include).toEqual(electronE2EQuarantineTestFiles);
        expect(packageScripts['test:e2e:electron:quarantine:no-build'])
            .toBe('vitest run --project e2e-quarantine --passWithNoTests --reporter verbose');
    });
});
