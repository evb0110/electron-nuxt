import { getErrorMessage } from '@contracts/getErrorMessage';
import {isRecord} from '@contracts/runtimeGuards';
import {
    readFile,
    readdir,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

export const TESTS_AS_NEVER_BASELINE_PATH = 'tests-as-never-baseline.json';

interface ITestsAsNeverBaseline {
    files: Record<string, number>;
    version: 1;
}

interface ITestsAsNeverComparison {
    failures: string[];
    passed: boolean;
}

export interface ITestsAsNeverRatchetResult {
    counts: Record<string, number>;
    message: string;
    passed: boolean;
}

function normalizePath(filePath: string) {
    return filePath.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function countAsNeverAssertions(source: string, filePath: string) {
    const sourceFile = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    let count = 0;
    const visit = (node: ts.Node): void => {
        if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.NeverKeyword) {
            count += 1;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return count;
}

async function collectTestFiles(projectRoot: string) {
    const testRoot = path.join(projectRoot, 'tests');
    async function collect(directory: string, relativeDirectory: string): Promise<string[]> {
        const entries = await readdir(directory, {withFileTypes: true});
        const files = await Promise.all(entries.map(async entry => {
            const absolutePath = path.join(directory, entry.name);
            const relativePath = path.posix.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) {
                return collect(absolutePath, relativePath);
            }
            return entry.isFile()
                && !entry.name.endsWith('.d.ts')
                && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
                ? [relativePath]
                : [];
        }));
        return files.flat();
    }
    return collect(testRoot, 'tests');
}

export async function collectTestsAsNeverCounts(projectRoot = process.cwd()) {
    const filePaths = await collectTestFiles(projectRoot);
    const entries = await Promise.all(filePaths.map(async filePath => {
        const source = await readFile(path.join(projectRoot, filePath), 'utf8');
        return [
            normalizePath(filePath),
            countAsNeverAssertions(source, filePath),
        ] as const;
    }));
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function assertNonnegativeInteger(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative integer.`);
    }
    return value;
}

export function parseTestsAsNeverBaseline(source: string): ITestsAsNeverBaseline {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.files)) {
        throw new TypeError('Tests as never baseline is invalid or unsupported.');
    }
    const files = Object.fromEntries(Object.entries(parsed.files).map(([
        filePath,
        count,
    ]) => [
        normalizePath(filePath),
        assertNonnegativeInteger(count, `Tests as never baseline ${filePath}`),
    ]));
    return {
        files,
        version: 1,
    };
}

export function compareTestsAsNeverToBaseline(
    counts: Record<string, number>,
    baseline: ITestsAsNeverBaseline,
): ITestsAsNeverComparison {
    const failures: string[] = [];
    for (const [
        filePath,
        count,
    ] of Object.entries(counts)) {
        const expected = baseline.files[filePath];
        if (expected === undefined) {
            if (count > 0) {
                failures.push(`${filePath} is missing from the baseline with ${count} as never assertion${count === 1 ? '' : 's'}`);
            }
        } else if (count > expected) {
            failures.push(`${filePath} increased from ${expected} to ${count} as never assertions`);
        }
    }
    return {
        failures,
        passed: failures.length === 0,
    };
}

function createBaseline(counts: Record<string, number>): ITestsAsNeverBaseline {
    return {
        files: Object.fromEntries(Object.entries(counts)
            .filter(([
                , count,
            ]) => count > 0)
            .sort(([left], [right]) => left.localeCompare(right))),
        version: 1,
    };
}

function summarizeCounts(counts: Record<string, number>) {
    const entries = Object.entries(counts);
    return {
        files: entries.filter(([
            , count,
        ]) => count > 0).length,
        total: entries.reduce((total, [
            , count,
        ]) => total + count, 0),
    };
}

function createMessage(
    counts: Record<string, number>,
    comparison: ITestsAsNeverComparison,
    action: string,
) {
    const summary = summarizeCounts(counts);
    return [
        comparison.passed ? `Tests as never ratchet ${action}.` : 'Tests as never ratchet failed.',
        `  ${summary.total} assertions in ${summary.files} test files.`,
        ...comparison.failures.map(failure => `  ERROR: ${failure}`),
    ].join('\n');
}

export async function runTestsAsNeverRatchet(
    args = process.argv.slice(2),
    projectRoot = process.cwd(),
): Promise<ITestsAsNeverRatchetResult> {
    const counts = await collectTestsAsNeverCounts(projectRoot);
    const baselinePath = path.join(projectRoot, TESTS_AS_NEVER_BASELINE_PATH);
    let baseline: ITestsAsNeverBaseline | undefined;
    try {
        baseline = parseTestsAsNeverBaseline(await readFile(baselinePath, 'utf8'));
    } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
        }
    }

    if (baseline === undefined) {
        if (!args.includes('--update-baseline')) {
            return {
                counts,
                message: 'Tests as never ratchet failed.\n  ERROR: Tests as never baseline is missing.',
                passed: false,
            };
        }
        await writeFile(baselinePath, `${JSON.stringify(createBaseline(counts), null, 2)}\n`, 'utf8');
        return {
            counts,
            message: createMessage(counts, {
                failures: [],
                passed: true,
            }, 'baseline created'),
            passed: true,
        };
    }

    const comparison = compareTestsAsNeverToBaseline(counts, baseline);
    if (!comparison.passed || !args.includes('--update-baseline')) {
        return {
            counts,
            message: createMessage(counts, comparison, 'passed'),
            passed: comparison.passed,
        };
    }

    await writeFile(baselinePath, `${JSON.stringify(createBaseline(counts), null, 2)}\n`, 'utf8');
    return {
        counts,
        message: createMessage(counts, comparison, 'baseline lowered'),
        passed: true,
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        const result = await runTestsAsNeverRatchet();
        console.log(result.message);
        if (!result.passed) {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(getErrorMessage(error));
        process.exitCode = 1;
    }
}
