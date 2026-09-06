import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

interface ILineBudgetModule {
    collectScanCleanupLineCounts: (root: string) => {
        homes: Record<string, {total: number}>;
        productionTotal: number;
        tests: {
            byFile: Record<string, number>;
            total: number
        };
    };
    countCodeLines: (source: string) => number;
    splitRustTestCodeLines: (source: string) => {
        productionLines: number[];
        testCodeLines: number[]
    };
    validateScanCleanupBaseline: (value: unknown, label?: string) => unknown;
    compareScanCleanupBaselines: (current: {
        homes: Record<string, {
            lines: number;
            path: string
        }>;
        productionTotal: number;
    }, previous: {
        homes: Record<string, {
            lines: number;
            path: string
        }>;
        productionTotal: number;
    } | null, options?: {
            allowHomeIncrease?: boolean;
            baseCommit?: string
        }) => {
        bootstrap: boolean;
        failures: string[]
        homeIncreased?: boolean
    };
    evaluateScanCleanupLineBudget: (counts: {
        homes: Record<string, {total: number}>;
        productionTotal: number;
    }, baseline: {
            homes: Record<string, {lines: number}>;
            productionTotal: number;
        }, options?: {allowBaselineIncrease?: boolean}) => {
        failures: string[];
        passed: boolean
    };
}

const module = await import(pathToFileURL(join(process.cwd(), 'scripts/scan-cleanup-line-budget.mjs')).href) as ILineBudgetModule;
const temporaryDirectories: string[] = [];
const homePaths = {
    app: 'app/modules/scan-cleanup',
    electron: 'electron/features/scan-cleanup',
    contracts: 'packages/contracts/scan-cleanup',
    core: 'scan-cleanup-core',
    adapters: 'scan-cleanup-adapters',
    native: 'native/scan-cleanup',
};

function baseline(lines: Partial<Record<keyof typeof homePaths, number>> = {}, productionTotal = 20) {
    return {
        version: 1,
        productionTotal,
        homes: Object.fromEntries(Object.entries(homePaths).map(([
            name,
            path,
        ]) => [
            name,
            {
                lines: lines[name as keyof typeof homePaths] ?? 0,
                path,
            },
        ])),
    };
}

function baselineIdentity(value: ReturnType<typeof baseline>) {
    return createHash('sha256').update(JSON.stringify({
        version: value.version,
        productionTotal: value.productionTotal,
        homes: value.homes,
    })).digest('hex');
}

function approvedBaseline(current: ReturnType<typeof baseline>, previous: ReturnType<typeof baseline>, baseCommit = '0123456789012345678901234567890123456789') {
    return {
        ...current,
        consolidationApproval: {
            version: 1 as const,
            reason: 'consolidation: rebalance test homes',
            baseCommit,
            previousIdentity: baselineIdentity(previous),
            currentIdentity: baselineIdentity(current),
        },
    };
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
        force: true,
        recursive: true,
    })));
});

describe('scan-cleanup line budget', () => {
    it('counts code while excluding blanks and comments, including inline comments', () => {
        expect(module.countCodeLines('// comment\n\nconst url = "https://example.test"; // code\n/* block\ncomment */\n<!-- Vue comment -->\nconst value = 1;')).toBe(2);
    });

    it('uses the six named homes and separates matching tests', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-lines-'));
        temporaryDirectories.push(root);
        await Promise.all([
            mkdir(join(root, 'app/modules/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'electron/features/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'packages/contracts/scan-cleanup'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-core'), {recursive: true}),
            mkdir(join(root, 'scan-cleanup-adapters'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/src'), {recursive: true}),
            mkdir(join(root, 'native/scan-cleanup/tests'), {recursive: true}),
            mkdir(join(root, 'tests/unit/scan-cleanup'), {recursive: true}),
        ]);
        await Promise.all([
            writeFile(join(root, 'app/modules/scan-cleanup/app.ts'), '// eslint-disable-next-line max-lines\nconst app = 1;\n'),
            writeFile(join(root, 'electron/features/scan-cleanup/electron.vue'), '<template>ok</template>\n'),
            writeFile(join(root, 'packages/contracts/scan-cleanup/contract.ts'), '// only comment\n'),
            writeFile(join(root, 'scan-cleanup-core/core.ts'), 'const core = 1;\n'),
            writeFile(join(root, 'scan-cleanup-adapters/adapter.ts'), 'const adapter = 1;\n'),
            writeFile(join(root, 'native/scan-cleanup/src/lib.rs'), 'fn main() {}\n'),
            writeFile(join(root, 'native/scan-cleanup/src/example_tests.rs'), '#[test]\nfn separate() {}\n'),
            writeFile(join(root, 'native/scan-cleanup/tests/lib.rs'), 'fn test() {}\n'),
            writeFile(join(root, 'tests/unit/scan-cleanup/example.test.ts'), 'it("works", () => {});\n'),
            writeFile(join(root, 'scan-cleanup-core/ignored.js'), 'const ignored = 1;\n'),
        ]);
        const counts = module.collectScanCleanupLineCounts(root);
        expect(Object.keys(counts.homes)).toEqual([
            'app',
            'electron',
            'contracts',
            'core',
            'adapters',
            'native',
        ]);
        expect(counts.productionTotal).toBe(5);
        expect(counts.tests.total).toBe(4);
        expect(Object.keys(counts.tests.byFile)).toHaveLength(3);
    });

    it('splits an inline Rust cfg test item with nested syntax from production', () => {
        const source = [
            'fn production() { let brace = "}"; }',
            '#[derive(Debug)]',
            '#[cfg(test)]',
            'mod tests {',
            '    /* outer /* nested */ comment */',
            '    fn nested() {',
            '        let raw = r#"{ // braces are data }"#;',
            '        let rawWithoutHashes = r"}";',
            '        let character = \'}\';',
            '    }',
            '}',
            'fn after() {}',
        ].join('\n');
        const split = module.splitRustTestCodeLines(source);
        expect(split.productionLines).toEqual([
            0,
            1,
            11,
        ]);
        expect(split.testCodeLines).toEqual([
            2,
            3,
            5,
            6,
            7,
            8,
            9,
            10,
        ]);
    });

    it('counts Rust code lines without comment-only lines and preserves literals', () => {
        const source = [
            'fn f<\'a>() {',
            '    // comment-only production line',
            '    let x = 1; /* trailing comment */',
            '    /* outer /* nested */ comment-only */',
            '    let character = \'{\';',
            '    let normal = "// not a comment { }";',
            '    let raw = br#"/* not a comment { } */"#;',
            '}',
            '#[cfg(test)] mod tests {',
            '    // comment-only test line',
            '    let test_value = 2; // trailing comment',
            '}',
        ].join('\n');
        const split = module.splitRustTestCodeLines(source);
        expect(split.productionLines).toEqual([
            0,
            2,
            4,
            5,
            6,
            7,
        ]);
        expect(split.testCodeLines).toEqual([
            8,
            10,
            11,
        ]);
    });

    it('ends cfg(test) semicolon items without capturing following production code', () => {
        const source = [
            '#[cfg(test)]',
            'use foo::{bar, baz};',
            '#[cfg(test)]',
            'const TEST_VALUE: &str = "}";',
            '#[cfg(test)]',
            'static TEST_STATIC: &[u8] = b"{";',
            'fn production() {}',
        ].join('\n');
        const split = module.splitRustTestCodeLines(source);
        expect(split.testCodeLines).toEqual([
            0,
            1,
            2,
            3,
            4,
            5,
        ]);
        expect(split.productionLines).toEqual([6]);
    });

    it('keeps the render module imports after its cfg(test) use in production', async () => {
        const source = await readFile(join(process.cwd(), 'native/scan-cleanup/src/engine/render.rs'), 'utf8');
        const split = module.splitRustTestCodeLines(source);
        expect(split.testCodeLines).toContain(0);
        expect(split.testCodeLines).toContain(1);
        expect(split.productionLines).toContain(2);
        expect(split.productionLines).toContain(3);
    });

    it('validates the complete baseline shape before comparison', () => {
        expect(() => module.validateScanCleanupBaseline(baseline())).not.toThrow();
        const missingHome = baseline();
        delete missingHome.homes.native;
        expect(() => module.validateScanCleanupBaseline(missingHome)).toThrow('exactly the six named');
        const missingTotal = baseline() as {productionTotal?: number};
        delete missingTotal.productionTotal;
        expect(() => module.validateScanCleanupBaseline(missingTotal)).toThrow('productionTotal');
        expect(() => module.validateScanCleanupBaseline(baseline({app: -1}))).toThrow('nonnegative');
        expect(() => module.validateScanCleanupBaseline({
            ...baseline(),
            version: 2,
        })).toThrow('unsupported');
        const wrongPath = baseline();
        wrongPath.homes.app!.path = 'wrong/home';
        expect(() => module.validateScanCleanupBaseline(wrongPath)).toThrow('unexpected path');
    });

    it('rejects raised home and total baselines, allows only an offsetting consolidation, and bootstraps', () => {
        const previous = baseline({
            app: 10,
            native: 10,
        });
        expect(module.compareScanCleanupBaselines({
            ...baseline({
                app: 11,
                native: 9,
            }),
            productionTotal: 20,
        }, previous).failures.join(' ')).toContain('app baseline increased by 1');
        expect(module.compareScanCleanupBaselines({
            ...baseline({
                app: 11,
                native: 9,
            }),
            productionTotal: 20,
        }, previous, {allowHomeIncrease: true}).failures).toEqual([]);
        expect(module.compareScanCleanupBaselines({
            ...baseline({
                app: 11,
                native: 10,
            }, 21),
            productionTotal: 21,
        }, previous, {allowHomeIncrease: true}).failures.join(' ')).toContain('production total baseline increased');
        expect(module.compareScanCleanupBaselines({
            ...baseline({app: 10}),
            productionTotal: 10,
        }, null)).toEqual({
            bootstrap: true,
            failures: [],
        });
    });

    it('accepts only the exact persisted consolidation transition in CI mode', () => {
        const previous = baseline({
            app: 10,
            native: 10,
        });
        const current = baseline({
            app: 11,
            native: 9,
        });
        const approved = approvedBaseline(current, previous);
        expect(module.compareScanCleanupBaselines(approved, approved, {baseCommit: 'fedcba98765432100123456789abcdef01234567'}).failures).toEqual([]);
        expect(module.compareScanCleanupBaselines(approved, previous, {baseCommit: approved.consolidationApproval.baseCommit}).failures).toEqual([]);
        expect(module.compareScanCleanupBaselines({
            ...approved,
            homes: {
                ...approved.homes,
                app: {
                    lines: 12,
                    path: homePaths.app,
                },
            },
        }, previous, {baseCommit: approved.consolidationApproval.baseCommit}).failures.join(' ')).toContain('current baseline');
        expect(module.compareScanCleanupBaselines(approved, {
            ...previous,
            homes: {
                ...previous.homes,
                native: {
                    lines: 11,
                    path: homePaths.native,
                },
            },
        }, {baseCommit: approved.consolidationApproval.baseCommit}).failures.join(' ')).toContain('base baseline');
        expect(module.compareScanCleanupBaselines(current, previous).failures.join(' ')).toContain('app baseline increased');
        expect(module.compareScanCleanupBaselines({
            ...approved,
            productionTotal: 21,
        }, previous, {baseCommit: approved.consolidationApproval.baseCommit}).failures.join(' ')).toContain('production total baseline increased');
        expect(module.compareScanCleanupBaselines(approved, previous, {baseCommit: 'fedcba98765432100123456789abcdef01234567'}).failures.join(' ')).toContain('supplied base ref');
    });

    it('reports the growing home and rejects production growth without an override', () => {
        const result = module.evaluateScanCleanupLineBudget({
            homes: {app: {total: 12}},
            productionTotal: 12,
        }, {
            homes: {app: {lines: 10}},
            productionTotal: 10,
        });
        expect(result.passed).toBe(false);
        expect(result.failures.join(' ')).toContain('app grew by 2');
    });

    it('allows a controlled increase only when the caller explicitly enables it', () => {
        const counts = {
            homes: {app: {total: 12}},
            productionTotal: 12,
        };
        const baseline = {
            homes: {app: {lines: 10}},
            productionTotal: 10,
        };
        expect(module.evaluateScanCleanupLineBudget(counts, baseline).passed).toBe(false);
        expect(module.evaluateScanCleanupLineBudget({
            homes: {
                app: {total: 12},
                native: {total: 8},
            },
            productionTotal: 20,
        }, {
            homes: {
                app: {lines: 10},
                native: {lines: 10},
            },
            productionTotal: 20,
        }, {allowBaselineIncrease: true}).passed).toBe(true);
        expect(module.evaluateScanCleanupLineBudget(counts, baseline, {allowBaselineIncrease: true}).passed).toBe(false);
    });

    it('does not hide a per-home increase behind an offsetting decrease elsewhere', () => {
        const result = module.evaluateScanCleanupLineBudget({
            homes: {
                app: {total: 12},
                native: {total: 8},
            },
            productionTotal: 20,
        }, {
            homes: {
                app: {lines: 10},
                native: {lines: 10},
            },
            productionTotal: 20,
        });
        expect(result.passed).toBe(false);
        expect(result.failures.join(' ')).toContain('app grew by 2');
    });

    it('runs the single command and rejects an override without baseline update', () => {
        const result = spawnSync(process.execPath, [
            'scripts/validation-gates.mjs',
            'scan-cleanup-lines',
            '--allow-baseline-increase=consolidation:test',
        ], {encoding: 'utf8'});
        expect(result.status).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain('only valid with --update-baseline');
    });

    it('fails closed for an unavailable explicit base ref and accepts the bootstrap base', () => {
        const invalid = spawnSync(process.execPath, [
            'scripts/validation-gates.mjs',
            'scan-cleanup-lines',
            '--base-ref=not-a-real-commit',
        ], {encoding: 'utf8'});
        expect(invalid.status).toBe(1);
        expect(`${invalid.stdout}${invalid.stderr}`).toContain('Cannot verify scan-cleanup baseline base ref');
        const bootstrap = spawnSync(process.execPath, [
            'scripts/validation-gates.mjs',
            'scan-cleanup-lines',
            '--base-ref=35b9779d0ef97cff342b0d8c414d771c8561a9e0',
        ], {encoding: 'utf8'});
        expect(bootstrap.status).toBe(0);
        expect(bootstrap.stdout).toContain('bootstrap, no baseline at ref');
    });
});
