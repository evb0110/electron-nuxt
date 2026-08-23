import {
    mkdtemp,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { ESLint } from 'eslint';

interface IValidationChanges {
    files: string[];
    known: boolean;
    reason: string;
}

interface IValidationGateModule {
    acquireHeavyGate: (options: {
        capacity?: number;
        env?: NodeJS.ProcessEnv;
        failOpenOnTimeout?: boolean;
        id: string;
        root: string;
        waitMs?: number;
        weight?: number;
    }) => Promise<{
        coordinated: boolean;
        release: () => Promise<void>;
    }>;
    classifyValidationImpacts: (files: string[]) => {
        full: boolean;
        impacts: Record<string, boolean>;
        unmatchedFiles: string[];
    };
    getLintCachePaths: (options: {
        arch?: string;
        nodeVersion?: string;
        platform?: string;
        root: string;
    }) => {
        eslint: string;
        fingerprint: string;
        stylelint: string;
    };
    getValidationPlan: (options: {
        allGates?: boolean;
        changes: IValidationChanges;
        classification?: {
            full: boolean;
            impacts: Record<string, boolean>;
            unmatchedFiles: string[];
        };
        tier: 'iteration' | 'acceptance' | 'integration' | 'nightly';
    }) => Array<{
        args: string[];
        command: string;
        heavyWeight: number;
        id: string;
        parallelPhase?: number;
    }>;
    pruneRetentionEntries: (options: {
        keep: number;
        minimumAgeMs: number;
        root: string;
    }) => Promise<string[]>;
}

const validationGates = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/validation-gates.mjs')).href
) as IValidationGateModule;
const ignoredRootEslintConfigFiles = [
    'eslint.config.mjs',
    'eslint.shared.mjs',
    'nuxt.config.ts',
    'stylelint.config.mjs',
];

function runChangedLint(files: string[]) {
    const result = spawnSync(process.execPath, [
        'scripts/validation-gates.mjs',
        'lint',
        '--changed',
        '--no-cache',
        ...files.map(file => `--file=${file}`),
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: process.env,
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    return {
        output: `${result.stdout}${result.stderr}`,
        status: result.status,
    };
}

async function createLintConfigRoot() {
    const root = await mkdtemp(join(tmpdir(), 'evb-validation-cache-'));
    await Promise.all([
        writeFile(join(root, 'eslint.config.mjs'), 'export default [];\n'),
        writeFile(join(root, 'eslint-plugin-custom.mjs'), 'export default {};\n'),
        writeFile(join(root, 'stylelint.config.mjs'), 'export default {};\n'),
        writeFile(join(root, 'package.json'), '{}\n'),
        writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'),
    ]);
    return root;
}

describe('validation gate policy', () => {
    it.sequential('skips root config files ignored by ESLint while still checking lintable changed files', async () => {
        const invalidPath = `tests/unit/scripts/validation-gate-policy-invalid-${process.pid}.ts`;
        await rm(invalidPath, {force: true});
        await writeFile(invalidPath, 'const invalidSyntax = ;\n');
        try {
            const ignoredConfigsOnly = runChangedLint(ignoredRootEslintConfigFiles);
            const withLintableError = runChangedLint([
                ...ignoredRootEslintConfigFiles,
                invalidPath,
            ]);

            expect(ignoredConfigsOnly, ignoredConfigsOnly.output).toMatchObject({status: 0});
            expect(withLintableError.status).not.toBe(0);
            expect(withLintableError.output).toContain(invalidPath);
        } finally {
            await rm(invalidPath, {force: true});
        }
    }, 30_000);

    it('keeps root and landing config ignore policies distinct', async () => {
        const rootEslint = new ESLint({cwd: process.cwd()});
        const landingEslint = new ESLint({cwd: join(process.cwd(), 'landing')});

        await expect(Promise.all(ignoredRootEslintConfigFiles.map(
            file => rootEslint.isPathIgnored(file),
        ))).resolves.toEqual(ignoredRootEslintConfigFiles.map(() => true));
        await expect(Promise.all([
            'drizzle.config.ts',
            'nuxt.config.ts',
        ].map(file => landingEslint.isPathIgnored(file)))).resolves.toEqual([
            false,
            false,
        ]);
    });

    it('fails closed for unmatched paths and unknown change detection', () => {
        const classification = validationGates.classifyValidationImpacts(['unowned/new-input.xyz']);
        expect(classification).toMatchObject({
            full: true,
            unmatchedFiles: ['unowned/new-input.xyz'],
        });

        const plan = validationGates.getValidationPlan({
            changes: {
                files: [],
                known: false,
                reason: 'missing-base',
            },
            tier: 'acceptance',
        });
        const stageIds = plan.map(stage => stage.id);
        expect(stageIds).toEqual(expect.arrayContaining([
            'lint.full',
            'typecheck.full',
            'test.unit.full',
            'fallow.dead-code',
            'build.strict',
            'electron.blocking-smoke',
        ]));

        const iterationStageIds = validationGates.getValidationPlan({
            changes: {
                files: [],
                known: false,
                reason: 'missing-base',
            },
            tier: 'iteration',
        }).map(stage => stage.id);
        expect(iterationStageIds).toEqual([
            'lint.full',
            'typecheck.full',
            'test.unit.full',
        ]);
        expect(iterationStageIds).not.toContain('build.strict');
    });

    it('maps non-import policy edges to every unit project', () => {
        const changes = {
            files: ['package.json'],
            known: true,
            reason: 'explicit-files',
        };
        const classification = validationGates.classifyValidationImpacts(changes.files);
        const plan = validationGates.getValidationPlan({
            changes,
            classification,
            tier: 'acceptance',
        });
        const unitStage = plan.find(stage => stage.id === 'test.unit.full');

        expect(classification.impacts.policy).toBe(true);
        expect(unitStage?.args.join(' ')).toContain('test:unit');
    });

    it('targets one Vitest project for a related app iteration instead of paying all project startups', () => {
        const changes = {
            files: ['app/composables/useExample.ts'],
            known: true,
            reason: 'explicit-files',
        };
        const plan = validationGates.getValidationPlan({
            changes,
            tier: 'iteration',
        });
        const related = plan.find(stage => stage.id === 'test.unit.related');

        expect(related?.args).toContain('unit-app');
        expect(related?.args).toContain('unit-static-architecture');
        expect(related?.args).not.toContain('unit-core');
        expect(related?.args).not.toContain('unit-electron');
        expect(related?.args).not.toContain('unit-scripts');
        expect(related?.args).not.toContain('unit-policy');
    });

    it('targets the static architecture lane when quarantine metadata changes', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: ['tests/e2e/electron/quarantine/graduation-policy.json'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });
        const related = plan.find(stage => stage.id === 'test.unit.affected-projects');

        expect(related?.args).toContain('unit-static-architecture');
        expect(related?.args).not.toContain('unit-app');
        expect(related?.args).toContain('unit-electron');
    });

    it('keeps informational and exhaustive reports in the nightly tier', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: [],
                known: false,
                reason: 'nightly-full',
            },
            tier: 'nightly',
        });
        const stageIds = plan.map(stage => stage.id);

        expect(stageIds).toEqual(expect.arrayContaining([
            'static.platform-report',
            'static.web-deploy-source',
            'typecheck.coverage',
            'test.coverage',
            'fallow.dupes',
            'native.resource-matrix',
            'electron.quarantine',
        ]));
        expect(stageIds).not.toContain('test.unit.full');
    });

    it('includes Rust formatting and Clippy in affected native acceptance', () => {
        const plan = validationGates.getValidationPlan({
            changes: {
                files: ['native/pdf-search/src/main.rs'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });

        expect(plan.map(stage => stage.id)).toEqual(expect.arrayContaining([
            'native.lint',
            'native.test',
            'native.resource-matrix',
            'build.strict',
        ]));
        expect(plan.find(stage => stage.id === 'test.unit.affected-projects')?.args)
            .toContain('unit-static-architecture');
    });

    it('consolidates the full local gate sequence without duplicate unit or build work', () => {
        const plan = validationGates.getValidationPlan({
            allGates: true,
            changes: {
                files: ['package.json'],
                known: true,
                reason: 'explicit-files',
            },
            tier: 'acceptance',
        });
        const stageIds = plan.map(stage => stage.id);
        const scripts = plan.flatMap(stage => (
            stage.command === 'pnpm' && stage.args[0] === 'run'
                ? [stage.args[1]]
                : []
        ));

        expect(stageIds).toEqual([
            'build.prepare',
            'lint.full',
            'typecheck.full',
            'test.coverage',
            'typecheck.coverage',
            'fallow.all',
            'static.platform-report',
            'static.web-deploy-source',
            'native.lint',
            'native.test',
            'native.resource-matrix',
            'build.strict',
            'electron.bundle-integrity',
            'electron.blocking-smoke',
        ]);
        expect(scripts).toContain('lint:clean');
        expect(scripts).toContain('typecheck:clean');
        expect(scripts).toContain('test:coverage');
        expect(scripts).toContain('fallow:all');
        expect(scripts).not.toContain('test:unit');
        expect(plan.find(stage => stage.id === 'electron.blocking-smoke')?.args)
            .toContain('--no-build');
        expect(plan.filter(stage => stage.parallelPhase === 0).map(stage => stage.id))
            .toEqual(stageIds.slice(1, 9));
        expect(plan.filter(stage => stage.parallelPhase === 3).map(stage => stage.id))
            .toEqual([
                'electron.bundle-integrity',
                'electron.blocking-smoke',
            ]);
    });

    it('keys lint caches by configuration, toolchain, platform, and architecture content', async () => {
        const root = await createLintConfigRoot();
        try {
            const first = validationGates.getLintCachePaths({
                arch: 'arm64',
                nodeVersion: 'v24.11.1',
                platform: 'darwin',
                root,
            });
            await writeFile(join(root, 'eslint.config.mjs'), 'export default [{ rules: {} }];\n');
            const configChanged = validationGates.getLintCachePaths({
                arch: 'arm64',
                nodeVersion: 'v24.11.1',
                platform: 'darwin',
                root,
            });
            const toolchainChanged = validationGates.getLintCachePaths({
                arch: 'arm64',
                nodeVersion: 'v24.12.0',
                platform: 'darwin',
                root,
            });

            expect(first.eslint).toContain(join('.devkit', 'cache', 'lint'));
            expect(first.fingerprint).not.toBe(configChanged.fingerprint);
            expect(configChanged.fingerprint).not.toBe(toolchainChanged.fingerprint);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('coordinates weighted work, reclaims capacity on release, and degrades open', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-heavy-gate-'));
        try {
            const first = await validationGates.acquireHeavyGate({
                capacity: 2,
                env: {},
                id: 'first',
                root,
                waitMs: 25,
                weight: 2,
            });
            const saturated = await validationGates.acquireHeavyGate({
                capacity: 2,
                env: {},
                failOpenOnTimeout: true,
                id: 'saturated',
                root,
                waitMs: 25,
                weight: 1,
            });
            expect(first.coordinated).toBe(true);
            expect(saturated.coordinated).toBe(false);
            await expect(validationGates.acquireHeavyGate({
                capacity: 2,
                env: {},
                id: 'fail-closed-timeout',
                root,
                waitMs: 25,
                weight: 1,
            })).rejects.toThrow('Timed out waiting');

            await first.release();
            const afterRelease = await validationGates.acquireHeavyGate({
                capacity: 2,
                env: {},
                id: 'after-release',
                root,
                waitMs: 25,
                weight: 1,
            });
            expect(afterRelease.coordinated).toBe(true);
            await afterRelease.release();

            const unusableRoot = join(root, 'not-a-directory');
            await writeFile(unusableRoot, 'occupied');
            const degraded = await validationGates.acquireHeavyGate({
                env: {},
                id: 'degraded',
                root: unusableRoot,
                waitMs: 25,
            });
            expect(degraded.coordinated).toBe(false);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('bounds ignored gate evidence and fingerprint cache entries', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-gate-retention-'));
        try {
            await Promise.all(Array.from({length: 5}, (_, index) => (
                writeFile(join(root, `${index}.json`), `${index}\n`)
            )));
            const removed = await validationGates.pruneRetentionEntries({
                keep: 2,
                minimumAgeMs: 0,
                root,
            });

            expect(removed).toHaveLength(3);
            await expect(readdir(root)).resolves.toHaveLength(2);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
