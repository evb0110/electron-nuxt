import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

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

interface IVitestProjectNames {
    electronE2EDrawShapes: string;
    electronE2ELargePdf: string;
    electronE2EQuarantine: string;
    electronE2ERapidNavigation: string;
    electronE2ESmoke: string;
}

interface IVitestSharedConfigModule {
    electronE2EDrawShapeTestFiles: string[];
    electronE2ELargePdfTestFiles: string[];
    electronE2EQuarantineTestFiles: string[];
    electronE2ERapidNavigationTestFiles: string[];
    electronE2ESmokeTestFiles: string[];
    vitestProjectNames: IVitestProjectNames;
    vitestProjects: IElectronE2EProjectConfig[];
}

interface IPackageJson { scripts: Record<string, string> }

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

function e2eProjectNames(config: IVitestSharedConfigModule) {
    return [
        config.vitestProjectNames.electronE2ESmoke,
        config.vitestProjectNames.electronE2EDrawShapes,
        config.vitestProjectNames.electronE2ELargePdf,
        config.vitestProjectNames.electronE2ERapidNavigation,
        config.vitestProjectNames.electronE2EQuarantine,
    ];
}

describe('electron e2e Vitest project topology', () => {
    it('keeps one local retry and two CI retries for startup flakes', async () => {
        const localConfig = await loadVitestSharedConfig(undefined);
        const ciConfig = await loadVitestSharedConfig('true');

        expect(e2eProjectNames(localConfig).map(projectName => projectByName(localConfig, projectName).test?.retry))
            .toEqual([
                1,
                1,
                1,
                1,
                1,
            ]);
        expect(e2eProjectNames(ciConfig).map(projectName => projectByName(ciConfig, projectName).test?.retry))
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
        const smokeProject = projectByName(config, config.vitestProjectNames.electronE2ESmoke);

        expect(smokeProject.test?.include).toEqual(config.electronE2ESmokeTestFiles);
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
        const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as IPackageJson;
        const largePdfSource = await readFile('tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts', 'utf8');

        expect(projectByName(config, config.vitestProjectNames.electronE2EDrawShapes).test?.include)
            .toEqual(config.electronE2EDrawShapeTestFiles);
        expect(projectByName(config, config.vitestProjectNames.electronE2ELargePdf).test?.include)
            .toEqual(config.electronE2ELargePdfTestFiles);
        expect(projectByName(config, config.vitestProjectNames.electronE2ERapidNavigation).test?.include)
            .toEqual(config.electronE2ERapidNavigationTestFiles);

        for (const obsoleteEnvFlag of [
            'EVB_E2E_DRAW_SHAPES_EXTENDED',
            'EVB_E2E_LARGE_PDF_ANNOTATION_SAVE',
            'EVB_E2E_RAPID_PDF_NAVIGATION',
        ]) {
            expect(sharedConfigSource).not.toContain(obsoleteEnvFlag);
            expect(JSON.stringify(packageJson.scripts)).not.toContain(obsoleteEnvFlag);
            expect(largePdfSource).not.toContain(obsoleteEnvFlag);
        }
        expect(packageJson.scripts['test:e2e:electron:draw-shapes:no-build'])
            .toBe('vitest run --project e2e-draw-shapes --reporter verbose');
        expect(packageJson.scripts['test:e2e:electron:large:no-build'])
            .toBe('EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1 vitest run --project e2e-large-pdf --reporter verbose');
        expect(packageJson.scripts['test:e2e:electron:rapid-navigation:no-build'])
            .toBe('vitest run --project e2e-rapid-navigation --reporter verbose');
    });
});

describe('electron e2e quarantine Vitest project', () => {
    it('runs only the quarantine include group and lets the script own empty-lane handling', async () => {
        const config = await loadVitestSharedConfig(undefined);
        const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as IPackageJson;
        const quarantineProject = projectByName(config, config.vitestProjectNames.electronE2EQuarantine);

        expect(quarantineProject.test?.include).toEqual(config.electronE2EQuarantineTestFiles);
        expect(packageJson.scripts['test:e2e:electron:quarantine:no-build'])
            .toBe('vitest run --project e2e-quarantine --passWithNoTests --reporter verbose');
    });
});
