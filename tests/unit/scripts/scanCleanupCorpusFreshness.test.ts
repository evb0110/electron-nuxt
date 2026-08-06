import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    utimes,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

interface ICargoArtifactFreshnessModule {
    assertStagedCargoArtifactFresh: (options: {
        binaryPath: string;
        buildCommand: string;
        sourcePaths: string[];
    }) => Promise<{
        binaryMtimeMs: number;
        newestSource: {
            mtimeMs: number;
            path: string;
        };
    }>;
    collectCargoSourceInputs: (metadata: unknown, rootManifestPath: string) => string[];
}

interface ICorpusVerifyModule {
    compareModeDistribution: (
        outputModes: string[],
        expectedDistribution: Record<string, number>,
    ) => {
        actual: Record<string, number>;
        expected: Record<string, number>;
        passed: boolean;
    };
    parsePdfImages: (output: string) => Array<{
        bitsPerComponent: number;
        encoding: string;
        number: number;
        page: number;
        type: string;
    }>;
    parseQpdfPageContentCounts: (output: string) => Array<{
        contentStreamCount: number;
        pageNumber: number;
    }>;
    parseConnectedComponents: (output: string) => Array<{
        area: number;
        gray: number;
        height: number;
        left: number;
        top: number;
        width: number;
    }>;
    resolveFixtureExpectations: (
        fixture: Record<string, unknown>,
        canonicalExpected?: Record<string, unknown>,
    ) => Record<string, unknown>;
    resolveFixtureOptions: (
        fixture: Record<string, unknown>,
    ) => Record<string, unknown>;
    resolveFixturePages: (fixture: Record<string, unknown>) => number[];
    scannerBoundaryComponents: (
        components: Array<{
            area: number;
            gray: number;
            height: number;
            left: number;
            top: number;
            width: number;
        }>,
        width: number,
        height: number,
        dpi: number,
    ) => unknown[];
}

interface IModeMatrixFixture {
    id: string;
    options: {
        binarization: string;
        cropContent: boolean;
    };
}

interface IModeMatrixConfig {fixtures: IModeMatrixFixture[];}

const {
    assertStagedCargoArtifactFresh,
    collectCargoSourceInputs,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/cargo-artifacts.mjs')).href
) as ICargoArtifactFreshnessModule;
const {
    compareModeDistribution,
    parseConnectedComponents,
    parsePdfImages,
    parseQpdfPageContentCounts,
    resolveFixtureExpectations,
    resolveFixtureOptions,
    resolveFixturePages,
    scannerBoundaryComponents,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/diagnostics/scan-cleanup-corpus-verify.mjs')).href
) as ICorpusVerifyModule;
const modeMatrix = JSON.parse(await readFile(
    path.join(process.cwd(), 'scripts/diagnostics/rome-mode-matrix-corpus-config.json'),
    'utf8',
)) as IModeMatrixConfig;

const tempRoots: string[] = [];

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(tempRoot => rm(tempRoot, {
        force: true,
        recursive: true,
    })));
});

async function createFreshnessFixture() {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-scan-cleanup-freshness-'));
    tempRoots.push(tempRoot);
    const binaryPath = path.join(tempRoot, '.tmp/scan-cleanup/bin/evb-scan-cleanup');
    const sourcePath = path.join(tempRoot, 'native/scan-cleanup/src/main.rs');
    await mkdir(path.dirname(binaryPath), {recursive: true});
    await mkdir(path.dirname(sourcePath), {recursive: true});
    await writeFile(binaryPath, 'binary');
    await writeFile(sourcePath, 'fn main() {}');
    return {
        binaryPath,
        sourcePath,
        tempRoot,
    };
}

describe('scan-cleanup corpus native freshness', () => {
    it('accepts a staged binary newer than every source input', async () => {
        const fixture = await createFreshnessFixture();
        const sourceTime = new Date('2026-07-24T01:00:00.000Z');
        const binaryTime = new Date('2026-07-24T01:00:02.000Z');
        await utimes(fixture.sourcePath, sourceTime, sourceTime);
        await utimes(fixture.binaryPath, binaryTime, binaryTime);

        await expect(assertStagedCargoArtifactFresh({
            binaryPath: fixture.binaryPath,
            buildCommand: 'pnpm run build:scan-cleanup',
            sourcePaths: [path.join(fixture.tempRoot, 'native/scan-cleanup')],
        })).resolves.toMatchObject({newestSource: {path: fixture.sourcePath}});
    });

    it('rejects stale staged bytes with the source and actionable restage command', async () => {
        const fixture = await createFreshnessFixture();
        const binaryTime = new Date('2026-07-24T01:00:00.000Z');
        const sourceTime = new Date('2026-07-24T01:00:02.000Z');
        await utimes(fixture.binaryPath, binaryTime, binaryTime);
        await utimes(fixture.sourcePath, sourceTime, sourceTime);

        await expect(assertStagedCargoArtifactFresh({
            binaryPath: fixture.binaryPath,
            buildCommand: 'pnpm run build:scan-cleanup',
            sourcePaths: [path.join(fixture.tempRoot, 'native/scan-cleanup')],
        })).rejects.toThrow([
            `Stale staged release binary: ${fixture.binaryPath}`,
            `Newer native source: ${fixture.sourcePath}`,
            'Run pnpm run build:scan-cleanup to rebuild and restage it.',
        ].join('\n'));
    });

    it('includes transitive local Cargo dependencies but not unrelated workspace crates', () => {
        const workspaceRoot = '/repo/native';
        const packageRecord = (name: string, dependencies: unknown[] = []) => ({
            dependencies,
            manifest_path: `${workspaceRoot}/${name}/Cargo.toml`,
        });
        const metadata = {
            packages: [
                packageRecord('scan-cleanup', [{path: `${workspaceRoot}/scan-primitives`}]),
                packageRecord('scan-primitives', [{path: `${workspaceRoot}/evb-native-support`}]),
                packageRecord('evb-native-support'),
                packageRecord('pdf-search'),
            ],
            workspace_root: workspaceRoot,
        };

        const inputs = collectCargoSourceInputs(
            metadata,
            `${workspaceRoot}/scan-cleanup/Cargo.toml`,
        );
        expect(inputs).toEqual(expect.arrayContaining([
            `${workspaceRoot}/Cargo.lock`,
            `${workspaceRoot}/Cargo.toml`,
            `${workspaceRoot}/scan-cleanup/src`,
            `${workspaceRoot}/scan-primitives/src`,
            `${workspaceRoot}/evb-native-support/src`,
        ]));
        expect(inputs).not.toContain(`${workspaceRoot}/pdf-search/src`);
    });
});

describe('scan-cleanup corpus local expectations', () => {
    it('keeps the standing mode matrix at 16 Rome cases plus the linguae edge-band case', () => {
        const expectedIds = [
            'headers2',
            'acceptance2',
        ].flatMap(corpus => [
            'auto',
            'otsu',
            'sauvola',
            'wolf',
        ].flatMap(method => [
            `${corpus}-${method}-crop`,
            `${corpus}-${method}-no-crop`,
        ]));
        expect(modeMatrix.fixtures).toHaveLength(17);
        expect(modeMatrix.fixtures.map(fixture => fixture.id)).toEqual([
            ...expectedIds,
            'linguae-scripts-auto-crop',
        ]);
        expect(modeMatrix.fixtures.every(fixture => (
            [
                'auto',
                'otsu',
                'sauvola',
                'wolf',
            ].includes(fixture.options.binarization)
            && typeof fixture.options.cropContent === 'boolean'
        ))).toBe(true);
    });

    it('routes the two standing fixture overrides through the shared native resolver options', () => {
        expect(resolveFixtureOptions({
            id: 'rome-sauvola-no-crop',
            options: {
                binarization: 'sauvola',
                cropContent: false,
            },
        })).toMatchObject({
            binarization: 'sauvola',
            crop: false,
        });
    });

    it('rejects fixture knobs outside the standing mode matrix', () => {
        expect(() => resolveFixtureOptions({
            id: 'invalid-fixture',
            options: {outputMode: 'bw'},
        })).toThrow('Only binarization and cropContent');
    });

    it('expands an inclusive page range without a 392-entry local config', () => {
        expect(resolveFixturePages({
            id: 'rome-full',
            pageRange: {
                from: 1,
                to: 392,
            },
        })).toHaveLength(392);
        expect(resolveFixturePages({
            id: 'rome-selected',
            pages: [
                1,
                33,
                392,
            ],
        })).toEqual([
            1,
            33,
            392,
        ]);
    });

    it('merges config-local distribution and size over canonical fixture expectations', () => {
        expect(resolveFixtureExpectations({
            id: 'linguae-armenian',
            expectedModeDistribution: {bw: 8},
            expectedOutputBytes: 1_000_000,
            maxOutputToSourceRatio: 1.4,
        }, {
            expectedOutputBytes: 900_000,
            pages: {'1': {mode: 'bw'}},
        })).toEqual({
            expectedModeDistribution: {bw: 8},
            expectedOutputBytes: 1_000_000,
            maxOutputToSourceRatio: 1.4,
            pages: {'1': {mode: 'bw'}},
        });
    });

    it.each([
        {expectedModeDistribution: {}},
        {expectedModeDistribution: {sepia: 8}},
        {expectedModeDistribution: {bw: -1}},
        {expectedOutputBytes: 0},
        {maxOutputToSourceRatio: 0},
    ])('rejects invalid config-local expectation %#', expectation => {
        expect(() => resolveFixtureExpectations({
            id: 'invalid-fixture',
            ...expectation,
        })).toThrow('Invalid expected');
    });

    it('requires the exact output-mode distribution, including absent modes', () => {
        expect(compareModeDistribution([
            'bw',
            'bw',
            'grayscale',
        ], {
            bw: 2,
            grayscale: 1,
        })).toMatchObject({passed: true});
        expect(compareModeDistribution([
            'bw',
            'bw',
            'grayscale',
        ], {bw: 2})).toMatchObject({passed: false});
        expect(compareModeDistribution([
            'bw',
            'future-mode',
        ], {bw: 1})).toMatchObject({passed: false});
    });

    it('preserves global image numbers after layered pages', () => {
        const rows = parsePdfImages(`page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio
  45     2 image    2198  3354  rgb     3   8  jpeg   no       136  0   360   360  916K 4.2%
  45     3 stencil  2198  3354  -       1   1  jbig2  no       137  0   360   360 57.5K 6.4%
  46     4 image    2198  3354  gray    1   1  jbig2  no       140  0   360   360 68.0K 7.6%`);
        expect(rows.map(row => ({
            number: row.number,
            page: row.page,
            type: row.type,
        }))).toEqual([
            {
                number: 2,
                page: 45,
                type: 'image',
            },
            {
                number: 3,
                page: 45,
                type: 'stencil',
            },
            {
                number: 4,
                page: 46,
                type: 'image',
            },
        ]);
    });

    it('detects page content arrays that can disappear in limited PDF renderers', () => {
        expect(parseQpdfPageContentCounts(`page 1: 3 0 R
  content:
    23 0 R
page 2: 4 0 R
  content:
    31 0 R
    32 0 R
    33 0 R
`)).toEqual([
            {
                contentStreamCount: 1,
                pageNumber: 1,
            },
            {
                contentStreamCount: 3,
                pageNumber: 2,
            },
        ]);
    });

    it('rejects a page-spanning foreground component confined to the scanner boundary', () => {
        const components = parseConnectedComponents(`Objects (id: bounding-box centroid area mean-color):
  0: 2198x3355+0+0 1112.7,1688.8 7.22016e+06 gray(255)
  2: 355x1234+72+446 131.6,1015.7 130027 gray(0)
  3: 1750x828+80+1084 923.9,1478.2 408123 gray(0)`);
        expect(scannerBoundaryComponents(components, 2198, 3355, 360)).toEqual([expect.objectContaining({
            area: 130027,
            height: 1234,
            left: 72,
            width: 355,
        })]);
    });
});
