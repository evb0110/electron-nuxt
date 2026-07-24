import {
    mkdir,
    mkdtemp,
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
    resolveFixtureExpectations: (
        fixture: Record<string, unknown>,
        canonicalExpected?: Record<string, unknown>,
    ) => Record<string, unknown>;
}

const {
    assertStagedCargoArtifactFresh,
    collectCargoSourceInputs,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/cargo-artifacts.mjs')).href
) as ICargoArtifactFreshnessModule;
const {
    compareModeDistribution,
    resolveFixtureExpectations,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/diagnostics/scan-cleanup-corpus-verify.mjs')).href
) as ICorpusVerifyModule;

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
    it('merges config-local distribution and size over canonical fixture expectations', () => {
        expect(resolveFixtureExpectations({
            id: 'linguae-armenian',
            expectedModeDistribution: {bw: 8},
            expectedOutputBytes: 1_000_000,
        }, {
            expectedOutputBytes: 900_000,
            pages: {'1': {mode: 'bw'}},
        })).toEqual({
            expectedModeDistribution: {bw: 8},
            expectedOutputBytes: 1_000_000,
            pages: {'1': {mode: 'bw'}},
        });
    });

    it.each([
        {expectedModeDistribution: {}},
        {expectedModeDistribution: {sepia: 8}},
        {expectedModeDistribution: {bw: -1}},
        {expectedOutputBytes: 0},
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
});
