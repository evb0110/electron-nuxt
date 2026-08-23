export const allGatesValidationStages = [
    pnpmStage('build.prepare', 'generate:build-artifacts', {parallelPhase: -1}),
    pnpmStage('lint.full', 'lint:clean', {parallelPhase: 0}),
    pnpmStage('typecheck.full', 'typecheck:clean', {parallelPhase: 0}),
    pnpmStage('test.coverage', 'test:coverage', {
        heavyWeight: 1,
        parallelPhase: 0,
    }),
    pnpmStage('typecheck.coverage', 'typecheck:coverage', {
        heavyWeight: 1,
        parallelPhase: 0,
    }),
    pnpmStage('fallow.all', 'fallow:all', {parallelPhase: 0}),
    pnpmStage('static.platform-report', 'check:static:reports', {parallelPhase: 0}),
    pnpmStage('static.web-deploy-source', 'check:static:assets', {parallelPhase: 0}),
    pnpmStage('native.lint', 'lint:rust', {
        heavyWeight: 1,
        parallelPhase: 0,
    }),
    pnpmStage('native.test', 'test:rust', {
        heavyWeight: 1,
        parallelPhase: 1,
    }),
    pnpmStage('native.resource-matrix', 'check:resources:matrix', {
        env: {EVB_BUILD_ARTIFACTS_PREPARED: '1'},
        parallelPhase: 1,
    }),
    pnpmStage('build.strict', 'build:strict', {
        env: {EVB_BUILD_ARTIFACTS_PREPARED: '1'},
        heavyWeight: 1,
        parallelPhase: 2,
    }),
    pnpmStage(
        'electron.bundle-integrity',
        'test:electron-bundle-static-integrity:no-build',
        {parallelPhase: 3},
    ),
    {
        args: [
            'scripts/test-electron-e2e-headless.sh',
            '--no-build',
            'e2e-blocking-smoke',
        ],
        command: 'bash',
        heavyWeight: 2,
        id: 'electron.blocking-smoke',
        parallelPhase: 3,
    },
];

function pnpmStage(id, scriptName, options = {}) {
    return {
        args: [
            'run',
            scriptName,
        ],
        command: 'pnpm',
        heavyWeight: 0,
        ...options,
        id,
    };
}
