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
    collectTestsAsNeverCounts,
    compareTestsAsNeverToBaseline,
    parseTestsAsNeverBaseline,
    runTestsAsNeverRatchet,
    TESTS_AS_NEVER_BASELINE_PATH,
} from '@scripts/checkTestsAsNever';

const temporaryDirectories = createTemporaryDirectoryRegistry();

afterEach(async () => {
    await temporaryDirectories.cleanup();
});

async function createTemporaryProject(files: Record<string, string>) {
    const projectRoot = temporaryDirectories.register(
        await mkdtemp(path.join(tmpdir(), 'evb-tests-as-never-')),
    );
    await mkdir(path.join(projectRoot, 'tests'), {recursive: true});
    await Promise.all(Object.entries(files).map(async ([
        filePath,
        source,
    ]) => {
        const absolutePath = path.join(projectRoot, filePath);
        await mkdir(path.dirname(absolutePath), {recursive: true});
        await writeFile(absolutePath, source, 'utf8');
    }));
    return projectRoot;
}

describe('tests as never ratchet', () => {
    it('counts AST assertions without counting comments or strings', async () => {
        const projectRoot = await createTemporaryProject({'tests/fixture.ts': [
            '// const ignored = value as never;',
            'const text = "value as never";',
            'const value = 1 as never;',
        ].join('\n')});

        await expect(collectTestsAsNeverCounts(projectRoot)).resolves.toEqual({'tests/fixture.ts': 1});
    });

    it('rejects increases and positive files missing from the baseline', () => {
        const baseline = parseTestsAsNeverBaseline(JSON.stringify({
            version: 1,
            files: {'tests/fixture.ts': 1},
        }));
        const result = compareTestsAsNeverToBaseline({
            'tests/fixture.ts': 2,
            'tests/new-fixture.ts': 1,
        }, baseline);

        expect(result.passed).toBe(false);
        expect(result.failures).toEqual([
            'tests/fixture.ts increased from 1 to 2 as never assertions',
            'tests/new-fixture.ts is missing from the baseline with 1 as never assertion',
        ]);
    });

    it('lowers existing counts and removes zero or deleted files on update', async () => {
        const projectRoot = await createTemporaryProject({
            'tests/keep.ts': 'const first = 1 as never;\nconst second = 2 as never;',
            'tests/drop.ts': 'const value = 1;',
        });
        await writeFile(
            path.join(projectRoot, TESTS_AS_NEVER_BASELINE_PATH),
            JSON.stringify({
                version: 1,
                files: {
                    'tests/drop.ts': 1,
                    'tests/gone.ts': 4,
                    'tests/keep.ts': 3,
                },
            }),
            'utf8',
        );

        await expect(runTestsAsNeverRatchet(['--update-baseline'], projectRoot)).resolves.toMatchObject({passed: true});
        await expect(readFile(
            path.join(projectRoot, TESTS_AS_NEVER_BASELINE_PATH),
            'utf8',
        )).resolves.toBe(`${JSON.stringify({
            files: {'tests/keep.ts': 2},
            version: 1,
        }, null, 2)}\n`);
    });

    it('does not write an update when a count rises', async () => {
        const projectRoot = await createTemporaryProject({'tests/fixture.ts': 'const first = 1 as never;\nconst second = 2 as never;'});
        const baseline = JSON.stringify({
            version: 1,
            files: {'tests/fixture.ts': 1},
        });
        await writeFile(path.join(projectRoot, TESTS_AS_NEVER_BASELINE_PATH), baseline, 'utf8');

        await expect(runTestsAsNeverRatchet(['--update-baseline'], projectRoot)).resolves.toMatchObject({passed: false});
        await expect(readFile(
            path.join(projectRoot, TESTS_AS_NEVER_BASELINE_PATH),
            'utf8',
        )).resolves.toBe(baseline);
    });
});
