import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdir,
    mkdtemp,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTemporaryDirectoryRegistry} from '@tests/helpers/createTemporaryDirectoryRegistry';
import {
    compareCoverageToBaseline,
    createCoverageBaseline,
    DEFAULT_COVERAGE_AREAS,
    LOAD_BEARING_COVERAGE_FILES,
    parseCoverageSummary,
    runCoverageRatchet,
} from '@scripts/checkCoverageRatchet';

const temporaryDirectories = createTemporaryDirectoryRegistry();

afterEach(() => temporaryDirectories.cleanup());

function metricSummary(pct: number) {
    return Object.fromEntries([
        'statements',
        'branches',
        'functions',
        'lines',
    ].map(metric => [
        metric,
        {
            covered: pct,
            pct,
            skipped: 0,
            total: 100,
        },
    ]));
}

function summary(totalPct: number, filePct = totalPct, projectRoot = '/repo') {
    return JSON.stringify({
        total: metricSummary(totalPct),
        ...Object.fromEntries(LOAD_BEARING_COVERAGE_FILES.map(filePath => [
            `${projectRoot}/${filePath}`,
            metricSummary(filePct),
        ])),
        [`${projectRoot}/app/runtime.ts`]: metricSummary(filePct),
        [`${projectRoot}/electron/main.ts`]: metricSummary(filePct),
        [`${projectRoot}/electron/features/djvu/open.ts`]: metricSummary(filePct),
        [`${projectRoot}/electron/ocr/recognize.ts`]: metricSummary(filePct),
        [`${projectRoot}/app/modules/pdf-viewer/viewer.ts`]: metricSummary(filePct),
        [`${projectRoot}/app/modules/workspace-shell/workspace.ts`]: metricSummary(filePct),
        [`${projectRoot}/scan-cleanup-adapters/renderers.ts`]: metricSummary(filePct),
        [`${projectRoot}/scan-cleanup-core/detection.ts`]: metricSummary(filePct),
        [`${projectRoot}/scripts/release/build.ts`]: metricSummary(filePct),
    });
}

async function createTemporaryProject() {
    const projectRoot = temporaryDirectories.register(
        await mkdtemp(path.join(tmpdir(), 'evb-coverage-ratchet-')),
    );
    await Promise.all([
        'app/.nuxt',
        'coverage',
        'electron',
        'scan-cleanup-adapters',
        'scan-cleanup-core',
        'scripts/release',
    ].map(directory => mkdir(path.join(projectRoot, directory), {recursive: true})));
    return projectRoot;
}

describe('coverage ratchet', () => {
    it('detects broad regressions beyond the configured tolerance', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70), '/repo'));
        const result = compareCoverageToBaseline(
            parseCoverageSummary(summary(69.49), '/repo'),
            baseline,
        );

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('total lines regressed by 0.51 percentage points');
    });

    it('rejects malformed coverage reports at each metric boundary', () => {
        expect(() => parseCoverageSummary('null')).toThrow('Coverage summary must be an object.');
        expect(() => parseCoverageSummary('{"total":null}')).toThrow(
            'Coverage summary total must be an object.',
        );
        expect(() => parseCoverageSummary('{"total":{"statements":null}}')).toThrow(
            'Coverage summary total.statements must be an object.',
        );
        expect(() => parseCoverageSummary(JSON.stringify({total: {
            ...metricSummary(70),
            statements: {
                ...metricSummary(70).statements,
                covered: 'invalid',
            },
        }}))).toThrow('Coverage summary total.statements.covered must be a finite number.');
    });

    it('detects a per-area regression even when total coverage is stable', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70, 80), '/repo'));
        const snapshot = parseCoverageSummary(summary(70, 79), '/repo');
        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain('electron-core lines regressed by 1.00 percentage points');
    });

    it('tracks major application and release areas', () => {
        expect(DEFAULT_COVERAGE_AREAS).toMatchObject({
            'app-core': {include: ['app/']},
            'electron-core': {include: ['electron/']},
            'pdf-viewer': {include: ['app/modules/pdf-viewer/']},
            'release-scripts': {include: ['scripts/release/']},
            'scan-cleanup-adapters': {include: ['scan-cleanup-adapters/']},
            'scan-cleanup-core': {include: ['scan-cleanup-core/']},
            'scripts-core': {include: ['scripts/']},
            'workspace-shell': {include: ['app/modules/workspace-shell/']},
        });
    });

    it('ratchets lifecycle-critical files and rejects zero execution', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70, 80), '/repo'));
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const targetPath = LOAD_BEARING_COVERAGE_FILES[0];
        const target = snapshot.files.find(file => file.filePath === targetPath)!;
        target.metrics.lines = {
            covered: 0,
            pct: 0,
            total: 100,
        };

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(`${targetPath} has zero executed lines`);
    });

    it('detects a load-bearing file regression hidden by stable aggregate coverage', () => {
        const baseline = createCoverageBaseline(parseCoverageSummary(summary(70, 80), '/repo'));
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const targetPath = LOAD_BEARING_COVERAGE_FILES[0];
        const target = snapshot.files.find(file => file.filePath === targetPath)!;
        target.metrics.lines = {
            covered: 79.49,
            pct: 79.49,
            total: 100,
        };

        const result = compareCoverageToBaseline(snapshot, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(`${targetPath} lines regressed by 0.51 percentage points`);
    });

    it('rejects a coverage denominator shrink while source files remain on disk', () => {
        const baselineSnapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const baseline = createCoverageBaseline(baselineSnapshot);
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        snapshot.files = snapshot.files.filter(file => file.filePath !== 'app/runtime.ts');

        const result = compareCoverageToBaseline(
            snapshot,
            baseline,
            baselineSnapshot.files.map(file => file.filePath),
        );

        expect(result.passed).toBe(false);
        expect(result.failures).toContain(
            'app-core coverage file count shrank from 6 to 5 while 6 source files remain on disk',
        );
    });

    it('allows a stored denominator to shrink only with the on-disk source set', () => {
        const baselineSnapshot = parseCoverageSummary(summary(70, 80), '/repo');
        const baseline = createCoverageBaseline(baselineSnapshot);
        const snapshot = parseCoverageSummary(summary(70, 80), '/repo');
        snapshot.files = snapshot.files.filter(file => file.filePath !== 'app/runtime.ts');

        const result = compareCoverageToBaseline(
            snapshot,
            baseline,
            snapshot.files.map(file => file.filePath),
        );

        expect(result.failures).not.toContain(
            'app-core coverage file count shrank from 6 to 5',
        );
    });

    it('checks report shrinkage against recursively discovered source files', async () => {
        const projectRoot = await createTemporaryProject();
        const sourceFiles: Array<[string, string]> = [
            [
                'app/runtime.ts',
                'export const runtime = true;',
            ],
            [
                'app/Viewer.vue',
                '<template><main /></template>',
            ],
            [
                'app/types.d.ts',
                'export declare const ignored: true;',
            ],
            [
                'app/ignored.js',
                'export const ignored = true;',
            ],
            [
                'app/.nuxt/generated.ts',
                'export const generated = true;',
            ],
            [
                'scripts/check.ts',
                'export const check = true;',
            ],
            [
                'scripts/legacy.cjs',
                'module.exports = true;',
            ],
            [
                'scripts/release/build.mjs',
                'export const build = true;',
            ],
            [
                'scripts/types.d.ts',
                'export declare const ignored: true;',
            ],
            [
                'scripts/ignored.js',
                'export const ignored = true;',
            ],
        ];
        await Promise.all(sourceFiles.map(([
            relativePath,
            contents,
        ]) => writeFile(path.join(projectRoot, relativePath), contents, 'utf8')));

        const baselineSource = summary(70, 80, projectRoot);
        const snapshot = JSON.parse(baselineSource) as Record<string, unknown>;
        Reflect.deleteProperty(snapshot, `${projectRoot}/app/runtime.ts`);
        await Promise.all([
            writeFile(
                path.join(projectRoot, 'coverage-baseline.json'),
                JSON.stringify(createCoverageBaseline(parseCoverageSummary(baselineSource, projectRoot))),
                'utf8',
            ),
            writeFile(
                path.join(projectRoot, 'coverage/coverage-summary.json'),
                JSON.stringify(snapshot),
                'utf8',
            ),
        ]);

        const result = await runCoverageRatchet([], projectRoot);

        expect(result.passed).toBe(false);
        expect(result.message).toContain(
            'app-core coverage file count shrank from 6 to 5 while 2 source files remain on disk',
        );
    });

    it('updates the stored baseline from the current report', async () => {
        const projectRoot = await createTemporaryProject();
        await writeFile(
            path.join(projectRoot, 'coverage/coverage-summary.json'),
            summary(70, 80, projectRoot),
            'utf8',
        );

        const result = await runCoverageRatchet(['--update-baseline'], projectRoot);
        const baseline = JSON.parse(await readFile(
            path.join(projectRoot, 'coverage-baseline.json'),
            'utf8',
        )) as {areas: Record<string, {fileCount: number}>};

        expect(result).toEqual({
            message: 'Coverage baseline updated.',
            passed: true,
        });
        expect(baseline.areas['scripts-core']?.fileCount).toBe(1);
    });

    it('rejects an unsupported stored baseline before comparing files', async () => {
        const projectRoot = await createTemporaryProject();
        await Promise.all([
            writeFile(
                path.join(projectRoot, 'coverage/coverage-summary.json'),
                summary(70, 80, projectRoot),
                'utf8',
            ),
            writeFile(
                path.join(projectRoot, 'coverage-baseline.json'),
                JSON.stringify({version: 1}),
                'utf8',
            ),
        ]);

        await expect(runCoverageRatchet([], projectRoot)).rejects.toThrow(
            'Coverage baseline is invalid or unsupported.',
        );
    });
});
