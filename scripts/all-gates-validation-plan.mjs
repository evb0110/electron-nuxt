function pnpmStage(id, scriptName, options = {}) {
    return {
        args: [
            'run',
            scriptName,
        ],
        command: 'pnpm',
        dependsOn: [],
        heavyWeight: 0,
        weight: 1,
        ...options,
        id,
    };
}

export function createAllGatesValidationStages({cold = false} = {}) {
    return [
        pnpmStage('build.prepare', 'generate:build-artifacts', {priority: 100}),
        pnpmStage('lint.full', cold ? 'lint:clean' : 'lint', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            heavyWeight: 2,
            inputScope: 'lint',
            priority: 70,
            weight: 2,
        }),
        pnpmStage('typecheck.full', cold ? 'typecheck:clean' : 'typecheck', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            heavyWeight: 1,
            inputScope: 'typecheck',
            priority: 60,
            weight: 1,
        }),
        pnpmStage('test.coverage', 'test:coverage', {
            dependsOn: ['build.prepare'],
            env: {VITEST_MAX_WORKERS: '6'},
            heavyWeight: 5,
            priority: 90,
            weight: 5,
        }),
        pnpmStage('typecheck.coverage', 'typecheck:coverage', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            heavyWeight: 2,
            inputScope: 'typecheck-coverage',
            priority: 80,
            weight: 2,
        }),
        pnpmStage('fallow.dead-code', 'fallow', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            heavyWeight: 1,
            inputScope: 'fallow',
            priority: 40,
            weight: 1,
        }),
        pnpmStage('fallow.dupes', 'fallow:dupes', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            heavyWeight: 1,
            inputScope: 'fallow',
            priority: 35,
            weight: 1,
        }),
        pnpmStage('static.platform-report', 'check:static:reports', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            inputScope: 'static-platform',
            priority: 30,
        }),
        pnpmStage('static.web-deploy-source', 'check:static:assets', {
            args: [
                'run',
                'check:static:assets',
                '--allow-dirty',
            ],
            cacheable: true,
            dependsOn: ['build.prepare'],
            inputScope: 'web-deploy',
            priority: 30,
        }),
        pnpmStage('native.lint', 'lint:rust', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            env: {CARGO_BUILD_JOBS: '2'},
            heavyWeight: 2,
            inputScope: 'native',
            priority: 65,
            weight: 2,
        }),
        pnpmStage('native.test', 'test:rust', {
            dependsOn: ['build.prepare'],
            env: {
                CARGO_BUILD_JOBS: '4',
                RUST_TEST_THREADS: '4',
            },
            heavyWeight: 4,
            inputScope: 'native',
            priority: 95,
            weight: 4,
        }),
        pnpmStage('native.resource-matrix', 'check:resources:matrix', {
            cacheable: true,
            dependsOn: ['build.prepare'],
            env: {EVB_BUILD_ARTIFACTS_PREPARED: '1'},
            inputScope: 'native',
            priority: 25,
        }),
        pnpmStage('build.strict', 'build:strict', {
            dependsOn: ['build.prepare'],
            env: {EVB_BUILD_ARTIFACTS_PREPARED: '1'},
            heavyWeight: 2,
            inputScope: 'build',
            priority: 96,
            weight: 2,
        }),
        pnpmStage(
            'electron.bundle-integrity',
            'test:electron-bundle-static-integrity:no-build',
            {
                dependsOn: ['build.strict'],
                inputScope: 'build',
                priority: 50,
            },
        ),
        {
            args: [
                'scripts/test-electron-e2e-headless.sh',
                '--no-build',
                'e2e-blocking-smoke',
            ],
            command: 'bash',
            dependsOn: [
                'build.strict',
                'electron.bundle-integrity',
            ],
            env: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            heavyWeight: 3,
            id: 'electron.blocking-smoke',
            inputScope: 'build',
            priority: 45,
            weight: 3,
        },
    ];
}

export const allGatesValidationStages = createAllGatesValidationStages();
