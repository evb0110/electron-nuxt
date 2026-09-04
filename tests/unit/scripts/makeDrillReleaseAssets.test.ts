import {createHash} from 'node:crypto';
import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertPublishUpdaterMetadataPolicy,
    assertPublishUpdaterMetadataReferences,
    assertUpdaterMetadataVersion,
    getLocalReleaseTargets,
    getRequiredArtifactPatterns,
} from '@scripts/release/policy.mjs';
import {
    DRILL_ASSET_BYTES,
    DRILL_MULTIPART_ASSET_BYTES,
    makeDrillReleaseAssets,
} from '@scripts/release/make-drill-release-assets.mjs';
import {MULTIPART_PART_BYTES} from '@scripts/release/publish-release-mirror.mjs';

const directories: string[] = [];
const policyEnvironment = {
    EVB_RELEASE_HAS_MAC_SIGNING: 'true',
    EVB_RELEASE_HAS_WINDOWS_SIGNING: 'true',
};

afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, {
    force: true,
    recursive: true,
}))));

async function collectArtifactFiles(root: string) {
    const groups = await readdir(root, {withFileTypes: true});
    const files = new Map<string, string>();
    for (const group of groups.filter(entry => entry.isDirectory())) {
        for (const file of await readdir(join(root, group.name))) {
            files.set(file, join(root, group.name, file));
        }
    }
    return files;
}

describe('drill release asset generator', () => {
    it('creates deterministic policy-valid assets for every core target group', async () => {
        const firstRoot = await mkdtemp(join(tmpdir(), 'evb-drill-assets-first-'));
        const secondRoot = await mkdtemp(join(tmpdir(), 'evb-drill-assets-second-'));
        directories.push(firstRoot, secondRoot);

        const first = await makeDrillReleaseAssets(firstRoot, '0.0.0-drill.42');
        const second = await makeDrillReleaseAssets(secondRoot, '0.0.0-drill.42');

        expect(first.targetGroups).toEqual([
            'dist-mac-arm64',
            'dist-linux-x64',
            'dist-linux-arm64',
            'dist-win-x64',
        ]);
        expect(first.artifactNames).toEqual(second.artifactNames);

        const firstFiles = await collectArtifactFiles(firstRoot);
        const secondFiles = await collectArtifactFiles(secondRoot);
        expect([...firstFiles.keys()].sort()).toEqual([...secondFiles.keys()].sort());
        for (const [
            name,
            firstPath,
        ] of firstFiles) {
            const firstBytes = await readFile(firstPath);
            expect(firstBytes.equals(await readFile(secondFiles.get(name) ?? ''))).toBe(true);
            if (!name.endsWith('.yml')) {
                expect(firstBytes.byteLength).toBe(name.endsWith('.dmg') ? DRILL_MULTIPART_ASSET_BYTES : DRILL_ASSET_BYTES);
            }
        }

        const metadata = new Map<string, string>();
        for (const name of first.artifactNames.filter(fileName => fileName.endsWith('.yml'))) {
            const filePath = firstFiles.get(name);
            expect(filePath).toBeDefined();
            const text = await readFile(filePath ?? '', 'utf8');
            metadata.set(name, text);
            expect(text).toContain('version: 0.0.0-drill.42');
            const pathName = /^path: (.+)$/mu.exec(text)?.[1];
            expect(pathName).toBeDefined();
            const pathBytes = await readFile(firstFiles.get(pathName ?? '') ?? '');
            const expectedPathHash = createHash('sha512').update(pathBytes).digest('base64');
            expect(text.split('\n').at(-2)).toBe(`sha512: ${expectedPathHash}`);
            const entries = [...text.matchAll(/^ {2}- url: (.+)\n {4}sha512: (.+)\n {4}size: (\d+)$/gmu)];
            expect(entries.length).toBeGreaterThan(0);
            for (const entry of entries) {
                const [
                    , entryName,
                    entryHash,
                    entrySize,
                ] = entry;
                const bytes = await readFile(firstFiles.get(entryName ?? '') ?? '');
                expect(entryHash).toBe(createHash('sha512').update(bytes).digest('base64'));
                expect(Number(entrySize)).toBe(bytes.byteLength);
            }
        }
        assertPublishUpdaterMetadataPolicy(first.artifactNames, policyEnvironment);
        expect(assertPublishUpdaterMetadataReferences(
            first.artifactNames,
            (fileName: string) => metadata.get(fileName) ?? '',
        )).toBe(true);
        expect(() => assertUpdaterMetadataVersion(
            first.artifactNames,
            (fileName: string) => metadata.get(fileName) ?? '',
            '0.0.0-drill.42',
        )).not.toThrow();

        for (const [
            platform,
            arch,
            group,
        ] of [
                [
                    'darwin',
                    'arm64',
                    'dist-mac-arm64',
                ],
                [
                    'linux',
                    'x64',
                    'dist-linux-x64',
                ],
                [
                    'linux',
                    'arm64',
                    'dist-linux-arm64',
                ],
                [
                    'win32',
                    'x64',
                    'dist-win-x64',
                ],
            ] as const) {
            const [target] = getLocalReleaseTargets({
                arch,
                platform,
            });
            const names = (await readdir(join(firstRoot, group))).filter(name => !name.endsWith('.yml'));
            for (const pattern of getRequiredArtifactPatterns(target, policyEnvironment)) {
                expect(names.some(name => pattern.test(name))).toBe(true);
            }
        }
    });

    it('seeds one asset that spans more than two mirror parts', () => {
        expect(DRILL_MULTIPART_ASSET_BYTES).toBeGreaterThan(MULTIPART_PART_BYTES * 2);
        expect(DRILL_MULTIPART_ASSET_BYTES).toBeLessThan(MULTIPART_PART_BYTES * 3);
    });

    it('rejects non-drill versions and does not create an incomplete output', async () => {
        const root = await mkdtemp(join(tmpdir(), 'evb-drill-assets-invalid-'));
        directories.push(root);

        await expect(makeDrillReleaseAssets(root, '1.2.3')).rejects.toThrow('Invalid drill version');
        await expect(stat(root)).resolves.toMatchObject({isDirectory: expect.any(Function)});
        await expect(readdir(root)).resolves.toEqual([]);
    });
});
