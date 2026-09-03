import {spawnSync} from 'node:child_process';
import {
    existsSync,
    readFileSync,
} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL_SHA_PATTERN = /^[a-f\d]{40,64}$/iu;
const ZERO_SHA_PATTERN = /^0+$/u;
const SOURCE_FILE_PATTERN = /^(?:app|electron|server|packages|scripts)\/.*\.(?:ts|vue|mjs)$/u;
const RELEASE_COMMIT_PATTERN = /^release: \d+\.\d+\.\d+ \[skip ci\]$/u;
const WASM_FRESHNESS_SCRIPT_PATHS = new Set([
    'scripts/build-wasm-tool.mjs',
    'scripts/check-wasm-freshness.mjs',
    'scripts/wasm-artifacts.mjs',
    'scripts/wasm-fingerprint.mjs',
]);
// Only the crates that feed public/wasm (and their path dependencies) can make
// the committed WASM stale; other native crates must not pay the wasm rebuild.
const WASM_CRATE_DIRECTORIES = [
    'native/evb-native-support/',
    'native/evb-raster-io/',
    'native/jbig2-codec/',
    'native/pdf-image-combine/',
    'native/pdf-page-ops/',
];
const WASM_WORKSPACE_MANIFEST_PATHS = new Set([
    'native/Cargo.lock',
    'native/Cargo.toml',
    'native/rust-toolchain.toml',
]);
const PRE_PUSH_WORKFLOW_TEST_ARGS = [
    'exec',
    'vitest',
    'run',
    '--project',
    'unit-scripts',
    'tests/unit/scripts/githubActionsSyntax.test.ts',
    'tests/unit/scripts/ciTopologyPolicy.test.ts',
];
const UNIT_PROJECT_ARGS = [
    '--project',
    'unit-*',
];
const GIT_LOCAL_ENVIRONMENT_VARIABLES = [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_CONFIG',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_DIR',
    'GIT_GRAFT_FILE',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_NO_REPLACE_OBJECTS',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_REPLACE_REF_BASE',
    'GIT_SHALLOW_FILE',
    'GIT_WORK_TREE',
];

export const PRE_PUSH_GATE_BUDGET_MS = 180_000;
export const PRE_PUSH_GH_TIMEOUT_MS = 5_000;

export function createPrePushChildEnvironment(environment = process.env) {
    const childEnvironment = {...environment};
    for (const variable of GIT_LOCAL_ENVIRONMENT_VARIABLES) {
        delete childEnvironment[variable];
    }
    return childEnvironment;
}

function normalizePath(filePath) {
    return filePath.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function assertSha(value, label) {
    if (!FULL_SHA_PATTERN.test(value)) {
        throw new Error(`${label} must be a full Git commit SHA.`);
    }
    return value;
}

function isZeroSha(value) {
    return ZERO_SHA_PATTERN.test(value);
}

export function parsePushUpdates(input) {
    const updates = [];
    for (const [
        index,
        rawLine,
    ] of input.split(/\r?\n/u).entries()) {
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }

        const fields = line.split(/\s+/u);
        if (fields.length !== 4) {
            throw new Error(
                `Invalid pre-push update on line ${index + 1}: expected <local ref> <local sha> <remote ref> <remote sha>.`,
            );
        }

        const [
            localRef,
            localSha,
            remoteRef,
            remoteSha,
        ] = fields;
        if (!localRef || !remoteRef) {
            throw new Error(`Invalid pre-push update on line ${index + 1}: refs must not be empty.`);
        }
        updates.push({
            localRef,
            localSha: assertSha(localSha, `Local SHA on line ${index + 1}`),
            remoteRef,
            remoteSha: assertSha(remoteSha, `Remote SHA on line ${index + 1}`),
        });
    }
    return updates;
}

// `git diff --name-only` lists deleted files too. Deletions still decide
// which suites run, but ESLint and `vitest related` take file paths and
// reject one that no longer exists, so only present files become targets.
/**
 * @param {string[]} changedFiles
 * @param {{fileExists?: (filePath: string) => boolean}} [options]
 */
export function classifyChangedFiles(changedFiles, {fileExists = () => true} = {}) {
    const files = [...new Set(changedFiles.map(normalizePath))]
        .filter(filePath => filePath.length > 0)
        .sort((left, right) => left.localeCompare(right));
    const workflowFiles = files.filter(filePath => filePath.startsWith('.github/workflows/'));
    const sourceFiles = files.filter(filePath => SOURCE_FILE_PATTERN.test(filePath) && fileExists(filePath));
    const nativeRustFiles = files.filter(filePath => /^native\/.*\.rs$/u.test(filePath));
    const wasmFiles = files.filter(filePath => (
        filePath.endsWith('.wasm')
        || filePath.startsWith('.cargo/')
        || WASM_WORKSPACE_MANIFEST_PATHS.has(filePath)
        || WASM_CRATE_DIRECTORIES.some(directory => filePath.startsWith(directory))
        || WASM_FRESHNESS_SCRIPT_PATHS.has(filePath)
    ));

    return {
        files,
        nativeRustFiles,
        sourceFiles,
        wasmFiles,
        workflowFiles,
    };
}

export function isReleaseCommit(changedFiles, tipCommitSubject) {
    const normalizedFiles = [...new Set(changedFiles.map(normalizePath))];
    return normalizedFiles.length === 1
        && normalizedFiles[0] === 'package.json'
        && RELEASE_COMMIT_PATTERN.test(tipCommitSubject.trim());
}

function commandOutput(result) {
    return typeof result?.stdout === 'string' ? result.stdout : '';
}

function commandErrorText(result) {
    const parts = [];
    if (typeof result?.stderr === 'string' && result.stderr.trim().length > 0) {
        parts.push(result.stderr.trim());
    }
    if (result?.error?.message) {
        parts.push(result.error.message);
    }
    return parts.join('\n');
}

export function defaultCommandRunner(command, args, {
    capture = false,
    cwd = projectRoot,
    timeoutMs,
} = {}) {
    const startedAt = Date.now();
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        env: createPrePushChildEnvironment(),
        stdio: capture ? [
            'ignore',
            'pipe',
            'pipe',
        ] : 'inherit',
        ...(timeoutMs === undefined ? {} : {timeout: timeoutMs}),
    });
    return {
        durationMs: Date.now() - startedAt,
        error: result.error,
        signal: result.signal,
        status: result.status,
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
    };
}

function isCommandSuccessful(result) {
    return result?.error === undefined && result?.status === 0;
}

function parseChangedFileOutput(output) {
    if (output.includes('\0')) {
        return output.split('\0').filter(Boolean);
    }
    return output.split(/\r?\n/u).filter(Boolean);
}

function parseShaOutput(result, label) {
    const sha = commandOutput(result).trim();
    return assertSha(sha, label);
}

function isRedCiConclusion(conclusion) {
    return conclusion !== 'success' && conclusion !== 'skipped';
}

export function parseLatestCiRun(output) {
    let parsed;
    try {
        parsed = JSON.parse(output);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        return null;
    }

    const run = parsed[0];
    if (!run || typeof run !== 'object' || run.status !== 'completed') {
        return null;
    }
    return {
        conclusion: typeof run.conclusion === 'string' ? run.conclusion : '',
        status: run.status,
        url: typeof run.url === 'string' ? run.url : '',
    };
}

export function requiresRedMainAcknowledgement({
    acknowledgement,
    latestRun,
    tipCommitSubject,
}) {
    return latestRun !== null
        && latestRun.status === 'completed'
        && isRedCiConclusion(latestRun.conclusion)
        && !/\bfix\b/iu.test(tipCommitSubject)
        && acknowledgement !== '1';
}

function formatCommandFailure(label, result) {
    const detail = commandErrorText(result);
    return detail.length > 0
        ? `pre-push: ${label} failed (status ${result?.status ?? 'unknown'}): ${detail}`
        : `pre-push: ${label} failed (status ${result?.status ?? 'unknown'}).`;
}

export function runPrePushGate({
    budgetMs = PRE_PUSH_GATE_BUDGET_MS,
    env = process.env,
    fileExists = filePath => existsSync(path.join(root, filePath)),
    input = '',
    now = Date.now,
    projectRoot: root = projectRoot,
    runCommand = defaultCommandRunner,
    write = message => console.log(message),
    writeError = message => console.error(message),
} = {}) {
    // EVB_PREPUSH_SKIP=1 git push is an explicit emergency escape hatch. Keep
    // the warning visible so skipped checks cannot look like a normal pass.
    if (env.EVB_PREPUSH_SKIP === '1') {
        writeError('pre-push: EVB_PREPUSH_SKIP=1 set; skipping the bounded gate.');
        return {
            passed: true,
            skipped: true,
        };
    }

    const updates = parsePushUpdates(input);
    const localUpdates = updates.filter(update => !isZeroSha(update.localSha));
    if (localUpdates.length === 0) {
        write('pre-push: no new commits in the pushed range.');
        return {
            passed: true,
            skipped: false,
        };
    }

    const startedAt = now();
    let consumedMs = 0;
    const elapsedMs = () => Math.max(consumedMs, now() - startedAt);

    const runBoundedCommand = (label, command, args, capture = false) => {
        const before = elapsedMs();
        const remainingMs = budgetMs - before;
        if (remainingMs <= 0) {
            writeError(`pre-push: ${label} exceeded the ${budgetMs / 1_000}-second hook budget before it started.`);
            return null;
        }

        write(`pre-push: running ${label}`);
        let result;
        try {
            result = runCommand(command, args, {
                capture,
                cwd: root,
                timeoutMs: remainingMs,
            });
        } catch (error) {
            writeError(`pre-push: ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }

        const reportedDurationMs = Number.isFinite(result?.durationMs) ? result.durationMs : 0;
        consumedMs = Math.max(
            consumedMs,
            now() - startedAt,
            before + Math.max(0, reportedDurationMs),
        );
        if (result?.error?.code === 'ETIMEDOUT' || elapsedMs() > budgetMs) {
            writeError(`pre-push: ${label} exceeded the ${budgetMs / 1_000}-second hook budget.`);
            return null;
        }
        if (!isCommandSuccessful(result)) {
            writeError(formatCommandFailure(label, result));
            return null;
        }

        write(`pre-push: ${label} passed.`);
        return result;
    };

    const ranges = [];
    const changedFiles = new Set();
    for (const update of localUpdates) {
        const baseSha = isZeroSha(update.remoteSha)
            ? (() => {
                const result = runBoundedCommand(
                    `resolve origin/main for ${update.localRef}`,
                    'git',
                    [
                        'rev-parse',
                        '--verify',
                        'origin/main',
                    ],
                    true,
                );
                if (result === null) {
                    return null;
                }
                try {
                    return parseShaOutput(result, 'origin/main SHA');
                } catch (error) {
                    writeError(`pre-push: origin/main SHA lookup failed: ${error instanceof Error ? error.message : String(error)}`);
                    return null;
                }
            })()
            : update.remoteSha;
        if (baseSha === null) {
            return {
                passed: false,
                skipped: false,
            };
        }

        const changedResult = runBoundedCommand(
            `collect changed files for ${update.localRef}`,
            'git',
            [
                'diff',
                '--name-only',
                '-z',
                `${baseSha}...${update.localSha}`,
            ],
            true,
        );
        if (changedResult === null) {
            return {
                passed: false,
                skipped: false,
            };
        }
        for (const filePath of parseChangedFileOutput(commandOutput(changedResult))) {
            changedFiles.add(normalizePath(filePath));
        }
        ranges.push({
            baseSha,
            localRef: update.localRef,
            localSha: update.localSha,
        });
    }

    const tipSubjects = [];
    for (const update of localUpdates) {
        const subjectResult = runBoundedCommand(
            `read tip subject for ${update.localRef}`,
            'git',
            [
                'log',
                '-1',
                '--format=%s',
                update.localSha,
            ],
            true,
        );
        if (subjectResult === null) {
            return {
                passed: false,
                skipped: false,
            };
        }
        tipSubjects.push(commandOutput(subjectResult).trim());
    }

    const changedFileList = [...changedFiles].sort((left, right) => left.localeCompare(right));
    if (tipSubjects.every(subject => isReleaseCommit(changedFileList, subject))) {
        write('pre-push: release commit detected with only package.json changed; skipping the bounded gate.');
        return {
            passed: true,
            skipped: true,
        };
    }

    for (const range of ranges) {
        if (runBoundedCommand(
            `git diff --check for ${range.localRef}`,
            'git',
            [
                'diff',
                '--check',
                `${range.baseSha}...${range.localSha}`,
            ],
        ) === null) {
            return {
                passed: false,
                skipped: false,
            };
        }
    }

    const classification = classifyChangedFiles(changedFileList, {fileExists});
    if (classification.workflowFiles.length > 0 && runBoundedCommand(
        'workflow syntax and topology tests',
        'pnpm',
        PRE_PUSH_WORKFLOW_TEST_ARGS,
    ) === null) {
        return {
            passed: false,
            skipped: false,
        };
    }

    if (classification.sourceFiles.length > 0) {
        if (runBoundedCommand(
            'ESLint for changed source files',
            'pnpm',
            [
                'exec',
                'eslint',
                '--cache',
                ...classification.sourceFiles,
            ],
        ) === null) {
            return {
                passed: false,
                skipped: false,
            };
        }
        if (runBoundedCommand(
            'related unit tests for changed source files',
            'pnpm',
            [
                'exec',
                'vitest',
                'related',
                '--run',
                ...UNIT_PROJECT_ARGS,
                ...classification.sourceFiles,
            ],
        ) === null) {
            return {
                passed: false,
                skipped: false,
            };
        }
    }

    if (classification.nativeRustFiles.length > 0 && runBoundedCommand(
        'Rust formatting check for changed native sources',
        'cargo',
        [
            'fmt',
            '--manifest-path',
            'native/Cargo.toml',
            '--all',
            '--check',
        ],
    ) === null) {
        return {
            passed: false,
            skipped: false,
        };
    }

    if (classification.wasmFiles.length > 0 && runBoundedCommand(
        'portable WASM freshness check',
        'pnpm',
        [
            'run',
            'check:wasm:portable',
        ],
    ) === null) {
        return {
            passed: false,
            skipped: false,
        };
    }

    const remainingMs = budgetMs - elapsedMs();
    if (remainingMs <= 0) {
        writeError(`pre-push: red-main notice exceeded the ${budgetMs / 1_000}-second hook budget before it started.`);
        return {
            passed: false,
            skipped: false,
        };
    }
    const redMainStartedAt = elapsedMs();
    let redMainResult;
    try {
        redMainResult = runCommand('gh', [
            'run',
            'list',
            '--branch',
            'main',
            '--workflow',
            'ci.yml',
            '--event',
            'push',
            '--limit',
            '1',
            '--json',
            'conclusion,status,url',
        ], {
            capture: true,
            cwd: root,
            timeoutMs: Math.min(PRE_PUSH_GH_TIMEOUT_MS, remainingMs),
        });
    } catch {
        redMainResult = null;
    }

    const redMainDurationMs = Number.isFinite(redMainResult?.durationMs)
        ? redMainResult.durationMs
        : 0;
    consumedMs = Math.max(
        consumedMs,
        now() - startedAt,
        redMainStartedAt + Math.max(0, redMainDurationMs),
    );
    if (elapsedMs() > budgetMs) {
        writeError(`pre-push: red-main status query exceeded the ${budgetMs / 1_000}-second hook budget.`);
        return {
            passed: false,
            skipped: false,
        };
    }

    if (redMainResult !== null && isCommandSuccessful(redMainResult)) {
        const latestRun = parseLatestCiRun(commandOutput(redMainResult));
        const tipCommitSubject = tipSubjects[0] ?? '';
        if (latestRun && isRedCiConclusion(latestRun.conclusion)) {
            const runUrl = latestRun.url.length > 0 ? ` ${latestRun.url}` : '';
            if (/\bfix\b/iu.test(tipCommitSubject)) {
                write(`pre-push: latest main CI is red (${latestRun.conclusion}), and the tip subject is a fix.${runUrl}`);
            } else if (env.EVB_PREPUSH_ACK_RED_MAIN === '1') {
                write(`pre-push: latest main CI is red (${latestRun.conclusion}); EVB_PREPUSH_ACK_RED_MAIN=1 acknowledged it.${runUrl}`);
            } else {
                writeError(
                    `pre-push: latest main CI is red (${latestRun.conclusion}).${runUrl} `
                    + 'Set EVB_PREPUSH_ACK_RED_MAIN=1 to proceed, or make the tip subject include the word "fix".',
                );
                return {
                    passed: false,
                    skipped: false,
                };
            }
        }
    }

    write(`pre-push: bounded gate passed in ${elapsedMs()} ms.`);
    return {
        changedFiles: changedFileList,
        passed: true,
        skipped: false,
    };
}

const isEntryPoint = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
    try {
        const result = runPrePushGate({input: readFileSync(0, 'utf8')});
        process.exitCode = result.passed ? 0 : 1;
    } catch (error) {
        console.error(`pre-push: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
