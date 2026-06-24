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

interface IElectronE2EProjectTestConfig {
    fileParallelism?: boolean;
    globalSetup?: string[];
    hookTimeout?: number;
    include?: string[];
    maxWorkers?: number;
    name?: string;
    retry?: number;
    sequence?: {concurrent?: boolean};
    testTimeout?: number;
}

interface IElectronE2EProjectConfig { test?: IElectronE2EProjectTestConfig }

interface IVitestSharedConfigModule { vitestProjects: IElectronE2EProjectConfig[] }

type TPackageJsonWithScripts = Simplify<SetRequired<PackageJson, 'scripts'>>;

const vitestProjectNames = {
    electronE2ESmoke: 'e2e-smoke',
    electronE2EDrawShapes: 'e2e-draw-shapes',
    electronE2ELargePdf: 'e2e-large-pdf',
    electronE2ERapidNavigation: 'e2e-rapid-navigation',
    electronE2EQuarantine: 'e2e-quarantine',
} as const;

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
        vitestProjectNames.electronE2ESmoke,
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

describe('electron e2e Vitest project topology', () => {
    it('keeps one local retry and two CI retries for startup flakes', async () => {
        const localConfig = await loadVitestSharedConfig(undefined);
        const ciConfig = await loadVitestSharedConfig('true');

        expect(e2eProjectNames().map(projectName => projectByName(localConfig, projectName).test?.retry))
            .toEqual([
                1,
                1,
                1,
                1,
                1,
            ]);
        expect(e2eProjectNames().map(projectName => projectByName(ciConfig, projectName).test?.retry))
            .toEqual([
                2,
                2,
                2,
                2,
                2,
            ]);
    });

    it('keeps the default smoke project narrow and serial', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const smokeProject = projectByName(config, vitestProjectNames.electronE2ESmoke);

        expect(smokeProject.test?.include).toEqual(electronE2ESmokeTestFiles);
        expect(smokeProject.test?.include).not.toContain('tests/e2e/electron/drawShapeLifecycle.e2e.test.ts');
        expect(smokeProject.test?.include).not.toContain('tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts');
        expect(smokeProject.test?.include).not.toContain('tests/e2e/electron/rapidPdfNavigation.e2e.test.ts');
        expect(smokeProject.test?.include).not.toContain('tests/e2e/electron/pdfSkeletonNavigationDiagnostics.e2e.test.ts');
        expect(smokeProject.test?.include).not.toContain('tests/e2e/electron/arnoldPdfOpenDiagnostics.e2e.test.ts');
        expect(smokeProject.test?.globalSetup).toEqual(['tests/e2e/electron/globalSetup.ts']);
        expect(smokeProject.test?.fileParallelism).toBe(false);
        expect(smokeProject.test?.maxWorkers).toBe(1);
        expect(smokeProject.test?.sequence).toEqual({ concurrent: false });
        expect(smokeProject.test?.testTimeout).toBe(90_000);
        expect(smokeProject.test?.hookTimeout).toBe(150_000);
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
