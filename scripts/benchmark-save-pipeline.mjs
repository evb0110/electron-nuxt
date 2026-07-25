#!/usr/bin/env node

import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {
    dirname,
    isAbsolute,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..');
const SCENARIOS = [
    {
        mode: 'native-freetext',
        tier: 'high',
    },
    {
        mode: 'serialized-fallback',
        tier: 'low',
    },
    {
        mode: 'serialized-fallback',
        tier: 'high',
    },
];

export function parseSavePipelineBenchmarkArgs(argv) {
    const options = {
        fixture: null,
        iterations: 10,
        output: null,
        warmups: 5,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const value = argv[index + 1];
        if (argument === '--fixture' || argument === '--pdf') {
            options.fixture = value ?? null;
            index += 1;
        } else if (argument === '--iterations') {
            options.iterations = Number.parseInt(value ?? '', 10);
            index += 1;
        } else if (argument === '--output' || argument === '--out') {
            options.output = value ?? null;
            index += 1;
        } else if (argument === '--warmups') {
            options.warmups = Number.parseInt(value ?? '', 10);
            index += 1;
        } else if (argument === '--help') {
            return {
                ...options,
                help: true,
            };
        } else {
            throw new Error(`Unknown benchmark option: ${argument}`);
        }
    }
    return {
        ...options,
        help: false,
    };
}

export function validateSavePipelineBenchmarkOptions(options) {
    if (!options.fixture || !isAbsolute(options.fixture)) {
        throw new Error('--fixture must be an absolute PDF path');
    }
    if (!options.output) {
        throw new Error('--output is required');
    }
    if (!Number.isSafeInteger(options.iterations) || options.iterations < 1) {
        throw new Error('--iterations must be a positive integer');
    }
    if (!Number.isSafeInteger(options.warmups) || options.warmups < 1) {
        throw new Error('--warmups must be a positive integer');
    }
    return {
        fixture: options.fixture,
        iterations: options.iterations,
        output: resolve(options.output),
        warmups: options.warmups,
    };
}

function run(command, args, env = process.env) {
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        env,
        stdio: 'inherit',
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`);
    }
}

function pnpmCommand() {
    return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

async function runScenario(options, scenario, temporaryDirectory) {
    const outputPath = join(
        temporaryDirectory,
        `${scenario.mode}-${scenario.tier}.json`,
    );
    run(pnpmCommand(), [
        'exec',
        'vitest',
        'run',
        '--project',
        'e2e-save-pipeline',
        'tests/e2e/electron/savePipelineBenchmark.e2e.test.ts',
        '--reporter',
        'verbose',
    ], {
        ...process.env,
        EVB_SAVE_PIPELINE_BENCHMARK_FIXTURE: options.fixture,
        EVB_SAVE_PIPELINE_BENCHMARK_ITERATIONS: String(options.iterations),
        EVB_SAVE_PIPELINE_BENCHMARK_MODE: scenario.mode,
        EVB_SAVE_PIPELINE_BENCHMARK_OUTPUT: outputPath,
        EVB_SAVE_PIPELINE_BENCHMARK_TIER: scenario.tier,
        EVB_SAVE_PIPELINE_BENCHMARK_WARMUPS: String(options.warmups),
    });
    return JSON.parse(await readFile(outputPath, 'utf8'));
}

function assertSemanticParity(results) {
    const baseline = JSON.stringify(results[0]?.semanticReopen ?? null);
    if (results.some(result => JSON.stringify(result.semanticReopen ?? null) !== baseline)) {
        throw new Error('Save benchmark scenarios produced different semantic reopen summaries');
    }
}

export async function runSavePipelineBenchmark(rawOptions) {
    const options = validateSavePipelineBenchmarkOptions(rawOptions);
    const fixtureStat = await stat(options.fixture);
    if (!fixtureStat.isFile() || fixtureStat.size === 0) {
        throw new Error('Benchmark fixture must be a non-empty PDF file');
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'evb-save-pipeline-benchmark-'));
    try {
        run(pnpmCommand(), [
            'run',
            'build:pdf-page-ops',
        ]);
        run(pnpmCommand(), [
            'run',
            'build:electron',
        ]);
        const results = [];
        for (const scenario of SCENARIOS) {
            results.push(await runScenario(options, scenario, temporaryDirectory));
        }
        assertSemanticParity(results);
        const report = {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            fixturePath: options.fixture,
            fixtureBytes: fixtureStat.size,
            inputPath: options.fixture,
            outputPath: options.output,
            warmups: options.warmups,
            iterations: options.iterations,
            hostProfile: results[0]?.hostProfile ?? null,
            hostTier: results[0]?.hostProfile?.tier ?? null,
            cloneMode: {
                measured: 'auto',
                forcedNoClone: 'unavailable',
            },
            scenarios: results,
        };
        await mkdir(dirname(options.output), {recursive: true});
        await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return report;
    } finally {
        await rm(temporaryDirectory, {
            force: true,
            recursive: true,
        });
    }
}

function printUsage() {
    process.stdout.write(
        'Usage: node scripts/benchmark-save-pipeline.mjs (--fixture|--pdf) /absolute/input.pdf --iterations 10 (--output|--out) .devkit/analysis/save-pipeline.json [--warmups 5]\n',
    );
}

const isMain = process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
if (isMain) {
    const options = parseSavePipelineBenchmarkArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
    } else {
        await runSavePipelineBenchmark(options);
    }
}
