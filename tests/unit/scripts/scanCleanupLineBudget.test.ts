import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
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
        expect(counts.tests.total).toBe(2);
        expect(Object.keys(counts.tests.byFile)).toHaveLength(2);
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
});
