import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    classifyChangedFiles,
    createPrePushChildEnvironment,
    defaultCommandRunner,
    isReleaseCommit,
    parseLatestCiRun,
    parsePushUpdates,
    PRE_PUSH_GATE_BUDGET_MS,
    requiresRedMainAcknowledgement,
    runPrePushGate,
} from '@scripts/pre-push-gate.mjs';

const LOCAL_SHA = 'a'.repeat(40);
const REMOTE_SHA = 'b'.repeat(40);
const ORIGIN_MAIN_SHA = 'c'.repeat(40);

interface IScriptedCiRun {
    conclusion: string;
    status: string;
    url: string;
}

interface IScriptedRunnerOptions {
    changedFiles?: string[];
    ciRun?: IScriptedCiRun | null;
    durationFor?: (command: string, args: string[]) => number;
    failWhen?: (command: string, args: string[]) => boolean;
    subject?: string;
}

type TCommandRunner = NonNullable<Parameters<typeof runPrePushGate>[0]>['runCommand'];
type TCommandResult = ReturnType<NonNullable<TCommandRunner>>;

function createRunner({
    changedFiles = [],
    ciRun = null,
    failWhen,
    subject = 'chore: update source',
    durationFor,
}: IScriptedRunnerOptions = {}) {
    const calls: Array<{
        args: string[];
        command: string;
        options: Record<string, unknown>
    }> = [];
    const runCommand: NonNullable<TCommandRunner> = (command, args, options = {}) => {
        calls.push({
            args,
            command,
            options,
        });
        const status = failWhen?.(command, args) === true ? 1 : 0;
        const durationMs = durationFor?.(command, args) ?? 0;
        const reply = (stdout: string): TCommandResult => ({
            durationMs,
            error: undefined,
            signal: null,
            status,
            stderr: '',
            stdout,
        });
        if (command === 'git' && args[0] === 'rev-parse') {
            return reply(`${ORIGIN_MAIN_SHA}\n`);
        }
        if (command === 'git' && args[0] === 'diff' && args.includes('--name-only')) {
            return reply(`${changedFiles.join('\0')}\0`);
        }
        if (command === 'git' && args[0] === 'log') {
            return reply(`${subject}\n`);
        }
        if (command === 'gh') {
            return reply(ciRun === null ? '[]' : JSON.stringify([ciRun]));
        }
        return reply('');
    };
    return {
        calls,
        runCommand,
    };
}

function pushInput({
    localSha = LOCAL_SHA,
    remoteSha = REMOTE_SHA,
} = {}) {
    return `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`;
}

describe('pre-push gate', () => {
    it('does not leak the outer repository identity into child tests', () => {
        const environment = createPrePushChildEnvironment({
            GIT_DIR: '/outer/.git',
            GIT_WORK_TREE: '/outer',
            GIT_INDEX_FILE: '/outer/.git/index',
            GIT_PREFIX: 'nested/',
            PATH: '/usr/bin',
        });

        expect(environment).toEqual({PATH: '/usr/bin'});
    });

    it('runs hook children without inherited Git repository controls', () => {
        const previousGitDirectory = process.env.GIT_DIR;
        process.env.GIT_DIR = '/outer/.git';
        try {
            const result = defaultCommandRunner(process.execPath, [
                '-e',
                'process.stdout.write(process.env.GIT_DIR ?? "unset")',
            ], {capture: true});

            expect(result.status).toBe(0);
            expect(result.stdout).toBe('unset');
        } finally {
            if (previousGitDirectory === undefined) {
                delete process.env.GIT_DIR;
            } else {
                process.env.GIT_DIR = previousGitDirectory;
            }
        }
    });

    it('parses one or more Husky push-update lines and rejects malformed ranges', () => {
        expect(parsePushUpdates([
            `refs/heads/main ${LOCAL_SHA} refs/heads/main ${REMOTE_SHA}`,
            `refs/heads/release ${'d'.repeat(40)} refs/heads/release ${'e'.repeat(40)}`,
            '',
        ].join('\n'))).toEqual([
            {
                localRef: 'refs/heads/main',
                localSha: LOCAL_SHA,
                remoteRef: 'refs/heads/main',
                remoteSha: REMOTE_SHA,
            },
            {
                localRef: 'refs/heads/release',
                localSha: 'd'.repeat(40),
                remoteRef: 'refs/heads/release',
                remoteSha: 'e'.repeat(40),
            },
        ]);

        expect(() => parsePushUpdates(`refs/heads/main ${LOCAL_SHA} ${REMOTE_SHA}`))
            .toThrow('expected <local ref> <local sha> <remote ref> <remote sha>');
        expect(() => parsePushUpdates(`refs/heads/main ${'not-a-sha'} refs/heads/main ${REMOTE_SHA}`))
            .toThrow('Local SHA on line 1 must be a full Git commit SHA.');
    });

    it('classifies workflow, unit-source, native Rust, and WASM changes independently', () => {
        expect(classifyChangedFiles([
            './packages/tool.wasm',
            'scripts/check-wasm-freshness.mjs',
            'native/pdf-page-ops/src/lib.rs',
            'native/scan-cleanup/src/lib.rs',
            '.github/workflows/ci.yml',
            'app/components/Viewer.vue',
            'docs/readme.md',
        ])).toEqual({
            files: [
                '.github/workflows/ci.yml',
                'app/components/Viewer.vue',
                'docs/readme.md',
                'native/pdf-page-ops/src/lib.rs',
                'native/scan-cleanup/src/lib.rs',
                'packages/tool.wasm',
                'scripts/check-wasm-freshness.mjs',
            ],
            nativeRustFiles: [
                'native/pdf-page-ops/src/lib.rs',
                'native/scan-cleanup/src/lib.rs',
            ],
            sourceFiles: [
                'app/components/Viewer.vue',
                'scripts/check-wasm-freshness.mjs',
            ],
            wasmFiles: [
                'native/pdf-page-ops/src/lib.rs',
                'packages/tool.wasm',
                'scripts/check-wasm-freshness.mjs',
            ],
            workflowFiles: ['.github/workflows/ci.yml'],
        });
    });

    it('drops deleted files from lint and related-test targets but keeps them for suite selection', () => {
        expect(classifyChangedFiles(
            [
                '.github/workflows/removed.yml',
                'app/components/Removed.vue',
                'app/components/Viewer.vue',
                'native/scan-cleanup/src/removed.rs',
            ],
            {fileExists: filePath => !filePath.includes('emoved')},
        )).toEqual({
            files: [
                '.github/workflows/removed.yml',
                'app/components/Removed.vue',
                'app/components/Viewer.vue',
                'native/scan-cleanup/src/removed.rs',
            ],
            nativeRustFiles: ['native/scan-cleanup/src/removed.rs'],
            sourceFiles: ['app/components/Viewer.vue'],
            wasmFiles: [],
            workflowFiles: ['.github/workflows/removed.yml'],
        });

        const runner = createRunner({
            changedFiles: [
                'app/components/Removed.vue',
                'app/components/Viewer.vue',
            ],
            ciRun: {
                conclusion: 'success',
                status: 'completed',
                url: 'https://ci.example/run/1',
            },
        });
        const result = runPrePushGate({
            fileExists: filePath => filePath !== 'app/components/Removed.vue',
            input: pushInput(),
            runCommand: runner.runCommand,
            write: () => undefined,
            writeError: () => undefined,
        });

        expect(result.passed).toBe(true);
        const eslintCall = runner.calls.find(call => call.args[1] === 'eslint');
        expect(eslintCall?.args).toEqual([
            'exec',
            'eslint',
            '--cache',
            'app/components/Viewer.vue',
        ]);
    });

    it('runs changed-file checks in order and limits related tests to unit projects', () => {
        const runner = createRunner({
            changedFiles: [
                '.github/workflows/ci.yml',
                'app/components/Viewer.vue',
                'native/pdf-page-ops/src/lib.rs',
                'packages/tool.wasm',
            ],
            ciRun: {
                conclusion: 'success',
                status: 'completed',
                url: 'https://ci.example/run/1',
            },
        });

        const result = runPrePushGate({
            fileExists: () => true,
            input: pushInput(),
            runCommand: runner.runCommand,
            write: () => undefined,
            writeError: () => undefined,
        });

        expect(result.passed).toBe(true);
        const commands = runner.calls.map(call => `${call.command} ${call.args.join(' ')}`);
        const indexOf = (fragment: string) => commands.findIndex(command => command.includes(fragment));
        expect(indexOf('git diff --check')).toBeGreaterThanOrEqual(0);
        expect(indexOf('pnpm exec vitest run --project unit-scripts')).toBeGreaterThan(indexOf('git diff --check'));
        expect(indexOf('pnpm exec eslint --cache')).toBeGreaterThan(indexOf('pnpm exec vitest run --project unit-scripts'));
        expect(indexOf('pnpm exec vitest related --run --project unit-*')).toBeGreaterThan(indexOf('pnpm exec eslint --cache'));
        expect(indexOf('cargo fmt --manifest-path native/Cargo.toml --all --check'))
            .toBeGreaterThan(indexOf('pnpm exec vitest related --run --project unit-*'));
        expect(indexOf('pnpm run check:wasm:portable'))
            .toBeGreaterThan(indexOf('cargo fmt --manifest-path native/Cargo.toml --all --check'));
        expect(indexOf('gh run list --branch main --workflow ci.yml --event push --limit 1 --json conclusion,status,url'))
            .toBeGreaterThan(indexOf('pnpm run check:wasm:portable'));
    });

    it('stops at the first failing changed-source check', () => {
        const runner = createRunner({
            changedFiles: [
                'app/components/Viewer.vue',
                'native/pdf-page-ops/src/lib.rs',
            ],
            failWhen: (command, args) => command === 'pnpm' && args[1] === 'eslint',
        });

        const result = runPrePushGate({
            fileExists: () => true,
            input: pushInput(),
            runCommand: runner.runCommand,
            write: () => undefined,
            writeError: () => undefined,
        });

        expect(result.passed).toBe(false);
        expect(runner.calls.some(call => call.args[1] === 'vitest' && call.args[2] === 'related')).toBe(false);
        expect(runner.calls.some(call => call.command === 'cargo')).toBe(false);
        expect(runner.calls.some(call => call.command === 'gh')).toBe(false);
    });

    it('fails with the slow step when the 180-second budget is exceeded', () => {
        const runner = createRunner({
            changedFiles: ['README.md'],
            durationFor: (command, args) => command === 'git' && args.includes('--check')
                ? PRE_PUSH_GATE_BUDGET_MS + 1
                : 0,
        });
        const errors: string[] = [];

        const result = runPrePushGate({
            fileExists: () => true,
            input: pushInput(),
            runCommand: runner.runCommand,
            write: () => undefined,
            writeError: message => errors.push(message),
        });

        expect(result.passed).toBe(false);
        expect(errors.join('\n')).toContain('git diff --check');
        expect(errors.join('\n')).toContain('180-second hook budget');
    });

    it('names a red-main lookup that overruns the shared budget', () => {
        const runner = createRunner({
            changedFiles: ['README.md'],
            durationFor: (command, args) => command === 'gh' && args[0] === 'run'
                ? PRE_PUSH_GATE_BUDGET_MS + 1
                : 0,
        });
        const errors: string[] = [];

        const result = runPrePushGate({
            fileExists: () => true,
            input: pushInput(),
            runCommand: runner.runCommand,
            write: () => undefined,
            writeError: message => errors.push(message),
        });

        expect(result.passed).toBe(false);
        expect(errors.join('\n')).toContain('red-main status query');
        expect(errors.join('\n')).toContain('180-second hook budget');
    });

    it('ignores an unavailable red-main lookup after local checks pass', () => {
        const runner = createRunner({
            changedFiles: ['README.md'],
            failWhen: (command, args) => command === 'gh' && args[0] === 'run',
        });

        const result = runPrePushGate({
            fileExists: () => true,
            input: pushInput(),
            runCommand: runner.runCommand,
            write: () => undefined,
            writeError: () => undefined,
        });

        expect(result.passed).toBe(true);
    });

    it('uses origin/main when the remote SHA is unknown and skips release-only package bumps', () => {
        const zeroSha = '0'.repeat(40);
        const runner = createRunner({
            changedFiles: ['package.json'],
            subject: 'release: 1.2.3 [skip ci]',
        });

        const result = runPrePushGate({
            fileExists: () => true,
            input: pushInput({remoteSha: zeroSha}),
            runCommand: runner.runCommand,
            write: () => undefined,
            writeError: () => undefined,
        });

        expect(result).toMatchObject({
            passed: true,
            skipped: true,
        });
        expect(runner.calls.some(call => call.command === 'git' && call.args[0] === 'rev-parse')).toBe(true);
        expect(runner.calls.some(call => call.command === 'git' && call.args.includes('--check'))).toBe(false);
        expect(isReleaseCommit(['package.json'], 'release: 1.2.3 [skip ci]')).toBe(true);
        expect(isReleaseCommit([
            'package.json',
            'pnpm-lock.yaml',
        ], 'release: 1.2.3 [skip ci]')).toBe(false);
    });

    it('requires acknowledgement for a red completed main run unless the tip is a fix', () => {
        const redRun = {
            conclusion: 'failure',
            status: 'completed',
            url: 'https://github.com/evb0110/evb-viewer/actions/runs/42',
        };
        expect(parseLatestCiRun(JSON.stringify([redRun]))).toEqual(redRun);
        expect(parseLatestCiRun(JSON.stringify([{
            ...redRun,
            status: 'in_progress',
        }]))).toBeNull();
        expect(requiresRedMainAcknowledgement({
            acknowledgement: undefined,
            latestRun: redRun,
            tipCommitSubject: 'chore: update source',
        })).toBe(true);
        expect(requiresRedMainAcknowledgement({
            acknowledgement: undefined,
            latestRun: redRun,
            tipCommitSubject: 'fix: repair main',
        })).toBe(false);
        expect(requiresRedMainAcknowledgement({
            acknowledgement: '1',
            latestRun: redRun,
            tipCommitSubject: 'chore: update source',
        })).toBe(false);
    });

    it('honors the explicit escape hatch without invoking any command', () => {
        const runner = createRunner();
        const warnings: string[] = [];

        const result = runPrePushGate({
            env: {EVB_PREPUSH_SKIP: '1'},
            input: 'not a push update',
            runCommand: runner.runCommand,
            write: () => undefined,
            writeError: message => warnings.push(message),
        });

        expect(result).toEqual({
            passed: true,
            skipped: true,
        });
        expect(runner.calls).toEqual([]);
        expect(warnings).toContain('pre-push: EVB_PREPUSH_SKIP=1 set; skipping the bounded gate.');
    });
});
