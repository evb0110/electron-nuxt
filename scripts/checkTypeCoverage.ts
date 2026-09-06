import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    spawn,
    spawnSync,
} from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ITypeCoverageProject {
    floor: number;
    id: string;
    ignoreFiles: string[];
    project?: string;
}

interface ITypeCoverageJsonResult {
    atLeast: number;
    atLeastFailed: boolean;
    correctCount: number;
    percent: number | null;
    percentString: string;
    succeeded: boolean;
    totalCount: number;
}

interface ITypeCoverageRunResult {
    covered: number | null;
    floor: number;
    id: string;
    output: string;
    percent: number | null;
    status: number;
    total: number | null;
}

const TYPE_COVERAGE_BIN = resolve('node_modules/type-coverage/bin/type-coverage');

const PROJECTS = [
    {
        id: 'app',
        project: 'tsconfig.type-coverage.app.json',
        floor: 99.5,
        ignoreFiles: [
            '.nuxt/**',
            'node_modules/**',
            'nuxt-output/**',
            'dist-electron/**',
            'release/**',
            'public/**',
            'coverage/**',
            'landing/**',
            'tests/**',
            'scripts/**',
            'electron/**',
            '**/*.mjs',
            '**/*.cjs',
            '**/*.d.ts',
        ],
    },
    {
        id: 'electron',
        project: 'electron/tsconfig.json',
        floor: 98,
        ignoreFiles: [
            'node_modules/**',
            '**/*.d.ts',
        ],
    },
    {
        id: 'tests',
        project: 'tests/tsconfig.json',
        floor: 96,
        ignoreFiles: [
            'node_modules/**',
            '.nuxt/**',
            '**/*.d.ts',
        ],
    },
    {
        id: 'scripts',
        project: 'tsconfig.scripts.json',
        floor: 99,
        ignoreFiles: [
            'node_modules/**',
            '**/*.d.ts',
        ],
    },
] as const satisfies readonly ITypeCoverageProject[];

function findProject(projectId: string) {
    const project = PROJECTS.find(candidate => candidate.id === projectId);

    if (!project) {
        throw new Error(`Unknown type-coverage project "${projectId}". Expected one of: ${PROJECTS.map(candidate => candidate.id).join(', ')}.`);
    }

    return project;
}

function createTypeCoverageArgs(project: ITypeCoverageProject, jsonOutput: boolean, floor = project.floor) {
    const args = [
        '--max-old-space-size=8192',
        TYPE_COVERAGE_BIN,
        '--strict',
        '--at-least',
        String(floor),
    ];

    if (project.project) {
        args.push('-p', project.project);
    }

    for (const ignoreFile of project.ignoreFiles) {
        args.push('--ignore-files', ignoreFile);
    }

    if (jsonOutput) {
        args.push('--json-output');
    }

    return args;
}

function parseJsonResult(output: string) {
    const trimmed = output.trim();
    if (!trimmed) {
        return null;
    }

    try {
        return JSON.parse(trimmed) as ITypeCoverageJsonResult;
    } catch {
        return null;
    }
}

function runProject(project: ITypeCoverageProject): Promise<ITypeCoverageRunResult> {
    return new Promise(resolve => {
        const child = spawn(process.execPath, createTypeCoverageArgs(project, true, 0), {stdio: [
            'ignore',
            'pipe',
            'pipe',
        ]});
        let stdout = '';
        let stderr = '';
        let settled = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        const finish = (status: number, error?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            const output = `${stdout}${stderr}${error ? `\n${error.message}` : ''}`;
            const parsed = parseJsonResult(stdout);
            const passed = status === 0
                && parsed?.percent !== null
                && parsed?.percent !== undefined
                && parsed.percent >= project.floor;
            resolve({
                covered: parsed?.correctCount ?? null,
                floor: project.floor,
                id: project.id,
                output,
                percent: parsed?.percent ?? null,
                status: passed ? 0 : 1,
                total: parsed?.totalCount ?? null,
            });
        };
        child.once('error', error => finish(1, error));
        child.once('close', (status, signal) => finish(
            status ?? 1,
            signal ? new Error(`type-coverage exited after signal ${signal}`) : undefined,
        ));
    });
}

export function checkTypeCoverage(
    runner: (project: ITypeCoverageProject) => Promise<ITypeCoverageRunResult> = runProject,
) {
    return Promise.all(PROJECTS.map(project => runner(project)));
}

function printSummary(results: ITypeCoverageRunResult[]) {
    console.log('Type coverage summary:');
    console.log('project    coverage    floor    identifiers');

    for (const result of results) {
        const coverage = result.percent === null
            ? 'n/a'
            : `${result.percent.toFixed(2)}%`;
        const identifiers = result.covered === null || result.total === null
            ? 'n/a'
            : `${result.covered} / ${result.total}`;
        const status = result.status === 0 ? 'ok' : 'failed';

        console.log(`${result.id.padEnd(9)} ${coverage.padEnd(10)} ${String(result.floor).padEnd(8)} ${identifiers} ${status}`);
    }
}

function runDetail(projectId: string) {
    const project = findProject(projectId);
    const result = spawnSync(
        process.execPath,
        [
            ...createTypeCoverageArgs(project, false),
            '--detail',
            '--show-relative-path',
        ],
        { stdio: 'inherit' },
    );

    process.exit(result.status ?? 1);
}

async function main() {
    const [
        command,
        projectId,
    ] = process.argv.slice(2);

    if (command === '--detail') {
        if (!projectId) {
            throw new Error('--detail requires a project id.');
        }

        runDetail(projectId);
        return;
    }

    if (command !== undefined) {
        throw new Error(`Unknown argument "${command}". Use "--detail <project>" for detail output.`);
    }

    const results = await checkTypeCoverage();
    printSummary(results);

    const failedResults = results.filter(result => result.status !== 0);
    if (failedResults.length > 0) {
        console.error('\nType coverage failed:');
        for (const result of failedResults) {
            console.error(`\n[${result.id}]`);
            console.error(result.output.trim());
        }
        process.exitCode = 1;
    }
}

const isDirectRun = process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
    main().catch(error => {
        console.error(getErrorMessage(error));
        process.exitCode = 1;
    });
}
