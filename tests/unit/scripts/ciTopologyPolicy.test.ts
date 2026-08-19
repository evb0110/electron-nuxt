import {isRecord} from '@contracts/runtimeGuards';
import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    readFile,
    readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getStaticYAMLValue,
    parseYAML,
} from 'yaml-eslint-parser';
import type {
    SetRequired,
    Simplify,
    TsConfigJson,
} from 'type-fest';

type TTsConfigJsonWithGlobs = Simplify<SetRequired<TsConfigJson, 'exclude' | 'include'>>;

interface IWorkflowStep {
    'continue-on-error'?: boolean;
    id?: string;
    if?: string;
    name?: string;
    run?: string;
}

interface IWorkflowJob {
    'continue-on-error'?: boolean;
    if?: string;
    needs?: string | string[];
    steps?: IWorkflowStep[];
}

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

function shellFunction(source: string, functionName: string) {
    const start = source.indexOf(`${functionName}() {\n`);
    if (start === -1) {
        throw new Error(`Missing shell function: ${functionName}`);
    }
    const nextFunction = source.slice(start + 1).search(/\n[a-z][a-z0-9_]*\(\) \{\n/u);
    return nextFunction === -1
        ? source.slice(start)
        : source.slice(start, start + 1 + nextFunction);
}

function parseWorkflowJobs(workflow: string) {
    const parsed = getStaticYAMLValue(parseYAML(workflow)) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.jobs)) {
        throw new Error('The CI workflow must contain a jobs mapping.');
    }

    const jobs: Record<string, IWorkflowJob> = {};
    for (const [
        jobName,
        value,
    ] of Object.entries(parsed.jobs)) {
        if (!isRecord(value)) {
            throw new Error(`The CI workflow job ${jobName} must be a mapping.`);
        }
        jobs[jobName] = value as IWorkflowJob;
    }
    return jobs;
}

const requiredPrPushConditions = new Set([
    '${{ github.event_name == \'pull_request\' || github.event_name == \'push\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.electron_smoke == \'true\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.browser_integration == \'true\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.native_or_build == \'true\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.landing == \'true\' }}',
    '${{ always() && (github.event_name == \'pull_request\' || github.event_name == \'push\') }}',
]);

const supportedNonPrPushConditions = new Set([
    '${{ github.event_name == \'workflow_dispatch\' }}',
    '${{ github.event_name == \'schedule\' || github.event_name == \'workflow_dispatch\' }}',
]);

function requiredPrPushJobs(jobs: Record<string, IWorkflowJob>) {
    const requiredJobs = new Set<string>();
    for (const [
        jobName,
        job,
    ] of Object.entries(jobs)) {
        if (job['continue-on-error'] === true) {
            continue;
        }
        if (job.if === undefined || (
            !requiredPrPushConditions.has(job.if)
            && !supportedNonPrPushConditions.has(job.if)
        )) {
            throw new Error(`Unsupported event condition for non-advisory job ${jobName}: ${job.if ?? '<missing>'}`);
        }
        if (jobName !== 'gates_ok' && requiredPrPushConditions.has(job.if)) {
            requiredJobs.add(jobName);
        }
    }
    return requiredJobs;
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

// Compares what a step runs rather than how the YAML reads: a trailing
// comment is enough to slip a forbidden command past a substring check.
function runCommandLines(step: IWorkflowStep) {
    return (step.run ?? '')
        .split('\n')
        .map(line => line.replace(/#.*$/u, '').trim())
        .filter(Boolean);
}

function expectExactRunStep(job: string, command: string) {
    expect(job).toMatch(new RegExp(`^[\\t ]*run:[\\t ]*${escapeRegExp(command)}[\\t ]*$`, 'mu'));
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

interface IPrePushScenario {
    nativeChanged: boolean;
    probeExit: number;
}

// Runs the real pre-push branch with every external command replaced by a
// logging stub. Shell indentation carries no meaning, so which build an ordinary
// push reaches can only be established by what the script actually does.
function runPrePushBranch({
    nativeChanged,
    probeExit,
}: IPrePushScenario) {
    const workdir = mkdtempSync(path.join(tmpdir(), 'scan-cleanup-pre-push-'));
    const binDir = path.join(workdir, 'bin');
    const logPath = path.join(workdir, 'calls.log');
    mkdirSync(binDir, {recursive: true});
    mkdirSync(path.join(workdir, 'native/target/release'), {recursive: true});

    function stub(commandPath: string, body: string) {
        writeFileSync(commandPath, `#!/bin/sh\n${body}\n`);
        chmodSync(commandPath, 0o755);
    }

    function record(label: string) {
        return `printf '%s\\n' ${label} >> '${logPath}'`;
    }

    stub(path.join(binDir, 'git'), 'case "$*" in *--abbrev-ref*) printf \'%s\\n\' origin/main ;; esac\nexit 0');
    stub(path.join(binDir, 'cargo'), `${record('catastrophe-oracle')}`);
    stub(path.join(binDir, 'pnpm'), `${record('build')}`);
    stub(path.join(workdir, 'native/target/release/evb-scan-cleanup'), `${record('stroke-weight-oracle')}`);
    stub(path.join(binDir, 'node'), [
        'case "$*" in',
        `  *classify-changed-areas.mjs*) printf 'native_or_build=%s\\n' '${nativeChanged}' > "$GITHUB_OUTPUT" ;;`,
        `  *--input-type=module*) ${record('tool-probe')}; exit ${probeExit} ;;`,
        `  *stroke-weight-oracle*|*assert-calibration*) ${record('stroke-weight-oracle')} ;;`,
        `  *scan-cleanup-preview-harness.mjs*|*scan-cleanup-word-loss-audit.mjs*) ${record('export-oracles')} ;;`,
        'esac',
    ].join('\n'));

    let failed = false;
    let stderr = '';
    try {
        try {
            execFileSync('/bin/sh', [
                path.resolve(process.cwd(), 'scripts/ci/scan-cleanup-oracles.sh'),
                'pre-push',
                '.devkit/scratch/pre-push-oracles',
                'origin',
            ], {
                cwd: workdir,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                },
                // execFileSync forwards stderr to the parent unless it is captured,
                // and one scenario here deliberately makes the script complain.
                stdio: [
                    'ignore',
                    'pipe',
                    'pipe',
                ],
            });
        } catch (error) {
            failed = true;
            stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr : '';
        }

        // Duplicates collapse so the log reads as the sequence of decisions taken,
        // not the number of commands each one happens to run.
        const calls = existsSync(logPath)
            ? [...new Set(readFileSync(logPath, 'utf8').split('\n').filter(Boolean))]
            : [];

        return {
            calls,
            failed,
            stderr,
        };
    } finally {
        // Each scenario stages stub executables and a native target tree; leaving
        // them behind would grow the system temporary directory every test run.
        rmSync(workdir, {
            recursive: true,
            force: true,
        });
    }
}

describe('CI topology policy', () => {
    it('requires every non-advisory PR and push job through gates_ok', async () => {
        const jobs = parseWorkflowJobs(await readProjectFile('.github/workflows/ci.yml'));
        const gatesOk = jobs.gates_ok;
        if (
            !gatesOk
            || !Array.isArray(gatesOk.needs)
            || !gatesOk.needs.every(jobName => typeof jobName === 'string')
        ) {
            throw new Error('gates_ok must declare its required jobs as a needs array.');
        }
        const requiredJobs = requiredPrPushJobs(jobs);

        expect(new Set(gatesOk.needs)).toEqual(requiredJobs);
    });

    it('rejects an unrecognized non-advisory event condition', () => {
        expect(() => requiredPrPushJobs({future_required_job: {if: '${{ github.event_name == \'merge_group\' }}'}}))
            .toThrow('Unsupported event condition for non-advisory job future_required_job');
    });

    it('keeps PR feedback bounded and release workflow checks delegated', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const packageJson = await readProjectFile('package.json');
        const packageScripts = (JSON.parse(packageJson) as {scripts: Record<string, string>;}).scripts;
        const prQuality = workflowJob(workflow, 'pr_quality');

        expect(workflow).toContain('push:');
        expect(workflow).toContain('branches:');
        expect(workflow).toContain('- main');
        expect(workflow).toContain('schedule:');
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).toContain('pull_request:');
        expect(workflow).toContain('group: ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.event_name == \'pull_request\' && github.ref || github.run_id }}');
        expect(workflow).toContain('cancel-in-progress: ${{ github.event_name == \'pull_request\' }}');
        expect(workflow).toContain('name: Quality Gates');
        expect(prQuality).toContain('if: ${{ github.event_name == \'pull_request\' || github.event_name == \'push\' }}');
        expect(prQuality).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        expect(prQuality).toContain('uses: actions/cache@v5');
        expect(prQuality).toContain('.devkit/cache/lint');
        expect(prQuality).toContain('.devkit/cache/typecheck');
        expect(prQuality).toContain('key: quality-');
        expect(prQuality).not.toContain('restore-keys:');
        expect(workflow).not.toContain('landing/pnpm-lock.yaml');
        expect(workflow).not.toContain('pnpm --dir landing install');
        expect(prQuality).not.toContain('playwright install');
        expect(prQuality).toContain('pnpm run generate:build-artifacts');
        expect(prQuality).toContain('pnpm run copy:pdfjs');
        expect(prQuality).toContain('git diff --exit-code --');
        expect(prQuality).not.toContain('.tmp/generated-electron-builder-resources.yml');
        expect(prQuality).toContain('git ls-files --others --exclude-standard');
        expect(prQuality).toContain('run: pnpm run lint');
        expect(prQuality).not.toContain('run: pnpm run check:static:reports');
        expect(prQuality).not.toContain('run: pnpm run check:static:assets');
        expect(packageScripts.lint).toBe('node scripts/validation-gates.mjs lint');
        expect(packageScripts['generate:build-artifacts']).toContain('scripts/generateBuildArtifacts.ts');
        expect(packageScripts.prepare).toContain('pnpm run generate:build-artifacts');
        expect(packageJson).not.toContain('check:native-tool-protocols');
        expect(packageJson).not.toContain('check:platform-api-generated');
        expect(packageJson).not.toContain('check:pdfjs-viewer-css');
        expect(packageScripts['check:static:reports']).toContain('reportPlatformManifestConsumers.ts');
        expect(packageScripts['check:static:assets']).toContain('check-web-deploy-source.mjs');
        expect(prQuality).toContain('run: pnpm run typecheck');
        expect(prQuality).toContain('run: pnpm run test:unit');

        // These three gates went unrun for days because only the invisible
        // nightly lane checked them. They belong on the merge-blocking lane, but
        // behind the tests: a job stops at its first failure, and a three-second
        // dead-export check must not be the reason a run reports no test result.
        expectExactRunStep(prQuality, 'pnpm run check:production-dependency-audit:production-only');
        expectExactRunStep(prQuality, 'pnpm run fallow');
        expectExactRunStep(prQuality, 'pnpm run fallow:dupes');
        for (const gate of [
            'pnpm run check:production-dependency-audit:production-only',
            'pnpm run fallow',
            'pnpm run fallow:dupes',
        ]) {
            expect(
                prQuality.indexOf('run: pnpm run test:coverage'),
                `${gate} must not mask the unit tests and coverage tripwire`,
            ).toBeLessThan(prQuality.indexOf(`run: ${gate}`));
        }

        // The full-graph audit stays on the maintenance lane. It rejects any
        // advisory at any severity across dev tooling and permits no waiver, so
        // on the merge-blocking lane one upstream publication would stop every
        // pull request in the repository for something no author introduced.
        const prQualityCommands = (parseWorkflowJobs(workflow).pr_quality?.steps ?? [])
            .flatMap(step => runCommandLines(step));
        expect(
            prQualityCommands.filter(command => command === 'pnpm run check:production-dependency-audit'),
            'the merge-blocking lane must not audit the full dependency graph',
        ).toEqual([]);
        expect(
            prQualityCommands.filter(command => command === 'pnpm run check:production-dependency-audit:production-only'),
            'the merge-blocking lane must audit production dependencies exactly once',
        ).toHaveLength(1);
        expect(packageScripts['test:unit']).toContain('validation-gates.mjs heavy');
        for (const project of [
            'unit-core',
            'unit-app',
            'unit-electron',
            'unit-scripts',
            'unit-policy',
            'unit-static-architecture',
        ]) {
            expect(packageScripts['test:unit']).toContain(`--project ${project}`);
        }
        expect(packageJson).not.toContain('"test:unit:core"');
        expect(packageJson).not.toContain('"test:unit:app"');
        expect(packageJson).not.toContain('"test:unit:electron"');
        expect(packageJson).not.toContain('"test:unit:scripts"');
        expect(packageJson).not.toContain('"test:unit:policy"');
        expect(prQuality).not.toContain('rustup target add');
        expect(prQuality).not.toContain('run: pnpm run build:strict');
        expect(prQuality).not.toContain('run: pnpm run build:strict:no-wasm-check');
        expect(prQuality).toContain('run: pnpm run test:coverage');
        expect(prQuality).not.toContain('if: ${{ github.event_name == \'push\' }}');
        expect(prQuality).not.toContain('run: pnpm run test:rust');
        expect(prQuality).not.toContain('run: pnpm run test:e2e');
        expect(prQuality).not.toContain('run: pnpm run test:e2e:electron:large');
        expect(prQuality).not.toContain('run: pnpm run diag:pdf-tabs:ci');
        expect(prQuality).not.toContain('pnpm exec electron-builder');
        const gatesOk = workflowJob(workflow, 'gates_ok');
        expect(gatesOk).toContain('if: ${{ always() && (github.event_name == \'pull_request\' || github.event_name == \'push\') }}');
        expect(gatesOk).not.toContain('nuxt_compatibility_v5');
        expect(gatesOk).not.toContain('gates_ok is not applicable');
        expect(workflow).toContain('name: Manual Quality Gates');
        const manualQuality = workflowJob(workflow, 'manual_quality');
        expect(manualQuality).toContain('if: ${{ github.event_name == \'workflow_dispatch\' }}');
        expect(manualQuality).toContain('run: rustup target add wasm32-unknown-unknown');
        expect(manualQuality).toContain('run: pnpm run check:wasm:portable');
        expectSplitQualitySteps(manualQuality);
        expect(manualQuality).toContain('run: pnpm run test:coverage');
        expect(manualQuality).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        expect(manualQuality).not.toContain('playwright install');
        expect(manualQuality).not.toContain('Restore validation caches');
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
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('run: rustup component add rustfmt clippy');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('run: pnpm run lint:rust');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('uses: EmbarkStudios/cargo-deny-action@v2');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('run: pnpm run build:strict');
        expect(workflowJob(workflow, 'pr_native_build_safety')).not.toContain('run: pnpm run build:strict:no-wasm-check');
        expect(workflowJob(workflow, 'pr_native_build_safety')).not.toContain('run: pnpm run test:e2e');
        expect(workflow).not.toContain('manual_native:');
        expect(workflow).toContain('name: Landing Quality Gates');
        expect(workflow).toContain('name: Landing Quality Gates For Changed Sources');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('needs.pr_changed_areas.outputs.landing == \'true\'');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        expect(workflowJob(workflow, 'pr_landing_quality')).not.toContain('check:vendor');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run lint');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run typecheck');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run build');
        expect(workflowJob(workflow, 'pr_landing_quality')).not.toContain('continue-on-error: true');
        expect(workflowJob(workflow, 'manual_landing')).toContain('if: ${{ github.event_name == \'workflow_dispatch\' }}');
        expect(workflowJob(workflow, 'manual_landing')).not.toContain('continue-on-error: true');
        expect(sharedVitestConfig).toContain('tests/unit/landing/**/*.test.ts');
        expect(testsTsconfig.exclude).toContain('./unit/landing/**/*.ts');
    });

    it('pins scan-cleanup oracle enforcement and Linux arm64 execution', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const oracleScript = await readProjectFile('scripts/ci/scan-cleanup-oracles.sh');
        const prePush = await readProjectFile('.husky/pre-push');
        const catastropheOracle = shellFunction(oracleScript, 'run_catastrophe_oracle');
        const exportOracles = shellFunction(oracleScript, 'run_export_oracles');
        const nativeJob = workflowJob(workflow, 'pr_native_build_safety');
        const arm64Job = workflowJob(workflow, 'pr_rust_tests_arm64');
        const exportJob = workflowJob(workflow, 'pr_scan_cleanup_oracles');

        expect(nativeJob).toContain('run: scripts/ci/scan-cleanup-oracles.sh native');
        expect(catastropheOracle).toContain('--baseline native/scan-cleanup/harness-baseline.json');
        expect(exportJob).toContain('run: scripts/ci/scan-cleanup-oracles.sh export');
        expect(exportOracles).toContain('scan-cleanup-preview-harness.mjs');
        expect(exportOracles).toContain('--check');
        expect(exportOracles).toContain('scan-cleanup-word-loss-audit.mjs');
        expect(exportOracles).toContain('--fail-on text-loss');
        expect(arm64Job).toContain('runs-on: ubuntu-24.04-arm');
        expect(arm64Job).toContain('sudo apt-get install -y --no-install-recommends poppler-utils');
        expect(prePush).toContain('scripts/ci/scan-cleanup-oracles.sh');
        expect(prePush).toContain('pre-push .devkit/scratch/pre-push-scan-cleanup-oracles');
        expect(oracleScript).toContain('major === 22 && minor >= 18');
        expect(oracleScript).toContain('warning: skipping scan-cleanup preview and word-loss pre-push oracles');

        // Which build the pre-push branch reaches is pinned by running it, below.
        // The probe's own contract cannot be: that test stubs node, so it can see
        // neither the resolver being asked nor the status that separates a missing
        // binary from a probe that could not answer at all.
        const probe = shellFunction(oracleScript, 'scan_cleanup_tool_is_available');
        expect(probe, 'the probe must ask the resolver the export oracles use').toContain('resolveCliNativeToolPath');
        expect(probe, 'absence needs a status of its own, distinct from a failed probe').toContain('? 0 : 20');
        expect(workflow).not.toContain('node scripts/diagnostics/scan-cleanup-preview-harness.mjs');
        expect(prePush).not.toContain('node scripts/diagnostics/scan-cleanup-preview-harness.mjs');
    });

    it('reaches a scan-cleanup build on pre-push only when the oracles would otherwise fail', () => {
        // Every push runs the export oracles against the built tool, so a checkout
        // that never built it could not push at all. Building is also what takes
        // the machine-wide heavy gate and needs a Rust toolchain, so a docs-only
        // push must not reach it. Both halves are decisions, not text.
        const nativeChanged = runPrePushBranch({
            nativeChanged: true,
            probeExit: 0,
        });
        expect(nativeChanged.calls, 'changed native sources must rebuild and re-run the stroke oracle').toEqual([
            'catastrophe-oracle',
            'build',
            'stroke-weight-oracle',
            'export-oracles',
        ]);

        const toolPresent = runPrePushBranch({
            nativeChanged: false,
            probeExit: 0,
        });
        expect(toolPresent.calls, 'an ordinary push with the tool present must not take the heavy gate').toEqual([
            'tool-probe',
            'export-oracles',
        ]);

        const toolMissing = runPrePushBranch({
            nativeChanged: false,
            probeExit: 20,
        });
        expect(toolMissing.calls, 'a checkout that never built the tool must still reach a build').toEqual([
            'tool-probe',
            'build',
            'export-oracles',
        ]);

        // A probe that cannot answer is not an answer. Reading its failure as
        // absence sends a healthy docs-only push into a Rust build and a wait on
        // the heavy gate before it fails for the real reason anyway.
        const probeBroken = runPrePushBranch({
            nativeChanged: false,
            probeExit: 1,
        });
        expect(probeBroken.failed, 'a probe that cannot run must stop the push').toBe(true);
        expect(probeBroken.calls, 'a broken probe must not be read as a missing binary').toEqual(['tool-probe']);
        expect(probeBroken.stderr).toContain('cannot tell whether the scan-cleanup tool is present');
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
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
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
        expect(workflow).toContain('os: windows-11-arm\n            platform: win\n            arch: arm64');
        expect(workflow).toContain(
            'uses: msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884',
        );
        expect(workflow).toContain('msystem: CLANGARM64');
        expect(workflow).toContain('msys2_root="$(cygpath -u "$MSYS2_LOCATION")"');
        expect(workflow).toContain('name: Verify Windows ARM64 MSYS2 toolchain');
        expect(workflow).toContain('"$MSYS2_ROOT/usr/bin/pacman.exe" --version');
        expect(workflow).toContain('"$MSYS2_ROOT/usr/bin/zstd.exe" --version');
        expect(workflow).toContain('"$MSYS2_ROOT/usr/bin/tar.exe" --version');
        const msys2SetupIndex = workflow.indexOf(
            'uses: msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884',
        );
        const msys2ExportIndex = workflow.indexOf('name: Export MSYS2 root for Windows ARM64 bundling');
        const msys2VerifyIndex = workflow.indexOf('name: Verify Windows ARM64 MSYS2 toolchain');
        const windowsBundleIndex = workflow.indexOf('name: Bundle native tools (Windows)');
        expect(msys2SetupIndex).toBeGreaterThanOrEqual(0);
        expect(msys2ExportIndex).toBeGreaterThanOrEqual(0);
        expect(msys2VerifyIndex).toBeGreaterThanOrEqual(0);
        expect(windowsBundleIndex).toBeGreaterThanOrEqual(0);
        expect(msys2SetupIndex).toBeLessThan(msys2ExportIndex);
        expect(msys2ExportIndex).toBeLessThan(msys2VerifyIndex);
        expect(msys2VerifyIndex).toBeLessThan(
            windowsBundleIndex,
        );
        expect(workflow).toContain('run: bash scripts/verify-packaged-native-tools.sh "${{ matrix.platform }}" "${{ matrix.arch }}"');
        expect(workflow).toContain('name: Verify packaged app contents');
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

        const packagedScanCleanupVerifier = workflowJob(releaseWorkflow, 'verify_packaged_scan_cleanup');
        const publish = workflowJob(releaseWorkflow, 'publish');
        expect(packagedScanCleanupVerifier).toContain('runs-on: macos-14');
        expect(packagedScanCleanupVerifier).toContain('name: Resolve required packaged scan-cleanup fixture');
        expect(packagedScanCleanupVerifier).toContain('getPackagedScanCleanupFixture');
        expect(packagedScanCleanupVerifier).toContain('name: Download macOS arm64 package');
        expect(packagedScanCleanupVerifier).toContain('PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES: ${{ steps.fixture.outputs.expected_pages }}');
        expect(packagedScanCleanupVerifier).toContain('--expected-pages "$PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES"');
        expect(packagedScanCleanupVerifier).toContain('--scale-only');
        expect(packagedScanCleanupVerifier).toContain('name: Upload packaged scan-cleanup verifier evidence');
        const publishNeeds = /\n {4}needs:\n((?: {6}- .+\n)+)/u.exec(publish)?.[1] ?? '';
        expect(publishNeeds).toContain('- verify_packaged_scan_cleanup');
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
        expect(qualityJob).not.toContain('pnpm --dir landing install');
        expect(qualityJob).toContain('run: pnpm exec playwright install --with-deps chromium');
        expect(qualityJob).toContain('run: pnpm run release:verify:checks');
        const publishJob = workflowJob(releaseWorkflow, 'publish');
        expect(publishJob).toContain(
            'uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
        );
        expect(publishJob).toContain(
            'uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
        );
        expect(publishJob).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        const releaseDependencyInstallIndex = publishJob.indexOf(
            'name: Install release validation dependencies',
        );
        const releaseArtifactDownloadIndex = publishJob.indexOf(
            'name: Download release artifacts',
        );
        expect(releaseDependencyInstallIndex).toBeGreaterThanOrEqual(0);
        expect(releaseArtifactDownloadIndex).toBeGreaterThanOrEqual(0);
        expect(releaseDependencyInstallIndex).toBeLessThan(releaseArtifactDownloadIndex);
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
        expect(qualityJob).not.toContain('pnpm --dir landing install');
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
        const rustFuzz = workflowJob(workflow, 'nightly_rust_fuzz');
        expect(rustFuzz).toContain('cargo install cargo-fuzz --version 0.13.1 --locked');
        expect(rustFuzz).toContain('for target in decode roundtrip; do');
        expect(rustFuzz).toContain('cargo +nightly fuzz run "$target" --fuzz-dir native/jbig2-codec/fuzz -- -max_total_time=15');
        expect(workflow).toContain('run: pnpm run test:coverage');
        expect(workflow).not.toContain('nightly_scan_cleanup_regress');
        expect(workflow).not.toContain('EVB_SCAN_CLEANUP_REGRESS_MANIFEST');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run check:static:assets');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run check:production-dependency-audit');
        expect(workflowJob(workflow, 'nightly_maintenance')).not.toContain('pnpm --dir landing install');
        expect(workflowJob(workflow, 'nightly_maintenance')).not.toContain('playwright install');
        expect(workflowJob(workflow, 'manual_quality')).not.toContain('run: pnpm run check:production-dependency-audit');
        expect(nvmrc.trim()).toBe('24.11.1');
        expect(workflow).toContain('NODE_VERSION: \'24.11.1\'');
        expect(buildWorkflow).toContain('NODE_VERSION: \'24.11.1\'');
        expect(rustToolchain).toContain('channel = "1.89.0"');
        expect(rustToolchain).toContain('profile = "minimal"');
        expect(buildWorkflow).toContain('run: rustup target add wasm32-unknown-unknown');
    });

    it('reports every maintenance gate even after an earlier gate fails', async () => {
        // A job stops at its first failing step, so a single broken gate used to
        // hide every later one and leave the expensive checks unrun for days.
        // Each gate must therefore survive an earlier failure while still failing
        // the job. Provisioning is the exception: a gate cannot mean anything
        // without the tools it drives, and letting the rest run after a failed
        // apt or rustup reports gates as broken when only the runner was.
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const jobs = parseWorkflowJobs(workflow);
        const gateCondition = '${{ !cancelled() && steps.setup.outcome == \'success\' }}';

        // Naming the gates each lane owes is what keeps the rest of this test
        // from passing vacuously. Every selector below is built from whatever
        // the workflow happens to contain, and the regression being pinned --
        // gates that stop reporting -- is precisely the one that empties them.
        const requiredGates = {
            manual_quality: [
                'pnpm run fallow',
                'pnpm run fallow:dupes',
                'pnpm run test:coverage',
            ],
            nightly_maintenance: [
                'pnpm run check:production-dependency-audit',
                'pnpm run fallow',
                'pnpm run fallow:dupes',
                'pnpm run test:rust',
                'pnpm run test:coverage',
                'pnpm run test:ocr:native-smoke:required',
            ],
        };

        for (const [
            jobName,
            gates,
        ] of Object.entries(requiredGates)) {
            const job = jobs[jobName];
            const steps = job?.steps ?? [];
            expect(steps.length, `${jobName} must declare steps`).toBeGreaterThan(0);

            // Anchoring the split on the provisioning command, not on the marker
            // alone, is what stops it from sliding down the job: carried to the
            // last step, `id: setup` leaves nothing after it to require a guard.
            const setupIndex = steps.findIndex(step => step.id === 'setup');
            expect(
                steps[setupIndex]?.run?.trim(),
                `${jobName} must mark its last provisioning step, not a later gate`,
            ).toBe('rustup target add wasm32-unknown-unknown');

            // Keying on the final provisioning step is what makes an earlier
            // provisioning failure skip every gate: GitHub skips the remaining
            // unconditional setup, so this step reports 'skipped', not 'success'.
            const conditionalSetup = steps
                .slice(0, setupIndex + 1)
                .filter(step => step.if !== undefined)
                .map(step => step.name);
            expect(conditionalSetup, `${jobName} provisioning must stay unconditional so a broken runner aborts`).toEqual([]);

            const gateSteps = steps.slice(setupIndex + 1);
            const abortingGates = gateSteps
                .filter(step => step.if !== gateCondition)
                .map(step => step.name);
            expect(abortingGates, `${jobName} gates that would skip the rest of the job`).toEqual([]);

            const gateCommands = gateSteps.flatMap(step => runCommandLines(step));
            for (const gate of gates) {
                expect(gateCommands, `${jobName} must still report ${gate} after an earlier gate fails`).toContain(gate);
            }

            // Surviving an earlier gate's failure must not become surviving your
            // own. An advisory gate reports the lane green while the check it
            // performs is broken, which is the state this job exists to expose.
            expect(job?.['continue-on-error'], `${jobName} must fail when one of its gates fails`).not.toBe(true);
            const advisoryGates = gateSteps
                .filter(step => step['continue-on-error'] === true)
                .map(step => step.name);
            expect(advisoryGates, `${jobName} gates that would report a broken check as success`).toEqual([]);
        }
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
        expect(workflow).toMatch(/nightly_electron_e2e_large_pdf:[\s\S]*if: \$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}[\s\S]*continue-on-error: true[\s\S]*run: pnpm run test:e2e:electron:large/u);
        expect(packageJson).toContain('"test:e2e:electron:large": "pnpm run build:pdf-page-ops');
        expect(packageJson).toContain('EVB_PDF_PAGE_OPS_ENABLE=1 EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1 vitest run --project e2e-large-pdf --reporter verbose');
        expect(workflow).toContain('name: Nightly Electron E2E Quarantine');
        expect(workflowJob(workflow, 'nightly_electron_e2e_quarantine')).toContain('run: pnpm run check:electron:install');
        expect(workflow).toContain('run: pnpm run test:e2e:electron:quarantine');
        expect(workflow).toContain('name: Nightly Electron E2E Visible Window');
        expect(workflowJob(workflow, 'nightly_electron_e2e_visible_window')).toContain('runs-on: macos-14');
        expect(workflowJob(workflow, 'nightly_electron_e2e_visible_window')).toContain('run: pnpm run test:e2e:electron:visible-window');
        expect(packageJson).toContain('"test:e2e:electron:visible-window": "pnpm run build:electron && vitest run --project e2e-visible-window --reporter verbose"');
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
        // Both Electron lanes exercise scan cleanup, which measures its matched
        // page canvas with evb-pdf-page-ops and assembles a lossless run with
        // it: they build every native tool that work needs through the shared
        // e2e native build and run with the tool enabled, on the project the
        // lane owns.
        const packageScripts = JSON.parse(packageJson).scripts as Record<string, string>;

        expect(packageScripts['build:native:e2e']).toContain('pdf-page-ops');
        for (const [
            script,
            project,
        ] of [
                [
                    'test:e2e:electron:regression',
                    'e2e-regression',
                ],
                [
                    'test:e2e:electron:quarantine',
                    'e2e-quarantine',
                ],
            ]) {
            const command = packageScripts[script!]!;

            for (const required of [
                'pnpm run build:native:e2e',
                'pnpm run build:electron',
                'EVB_PDF_PAGE_OPS_ENABLE=1',
                `--project ${project!}`,
            ]) {
                expect(command, `${script!} is missing ${required}`).toContain(required);
            }
        }
        expect(packageScripts['test:e2e:electron:quarantine']).toContain(
            'vitest run --project e2e-quarantine --passWithNoTests',
        );
        // The matched page canvas is a whole-app contract — geometry measured
        // in the main process, a rectangle presented by the renderer, and an
        // assembled PDF whose pages carry it — so it is proved by running the
        // real app rather than by any unit layer. It lives in the isolated
        // quarantine lane, and this is what keeps the file that proves it in a
        // lane something actually runs.
        const matchedCanvasSpec = 'tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts';

        expect(await readProjectFile(matchedCanvasSpec))
            .toContain('describe(\'scan cleanup matched page canvas\'');
        expect(sharedVitestConfig)
            .toContain('const electronE2EQuarantineTestFiles = [\'tests/e2e/electron/quarantine/**/*.e2e.test.ts\']');
        expect(packageJson).not.toContain('"test:e2e:electron:smoke:no-build"');
        expect(sharedVitestConfig).toContain('condition: /\\[INFRA\\]/u');
        expect(sharedVitestConfig).toContain('count: 2');
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
        expect(packageJson).toContain('"test:coverage": "vitest run --coverage --project unit-core --project unit-app --project unit-electron --project unit-scripts --project unit-policy --project unit-static-architecture && pnpm exec tsx scripts/checkCoverageRatchet.ts && pnpm exec tsx scripts/checkZeroExecutionCoverage.ts"');
        expect(packageJson).not.toContain('"test:coverage:run"');
        expect(packageJson).not.toContain('"check:coverage:zero-execution"');
        expect(packageJson).not.toContain('"check:coverage:ratchet"');
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
