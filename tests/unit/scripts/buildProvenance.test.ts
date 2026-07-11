import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertMatchingBuildProvenance} from '@scripts/release/build-provenance.mjs';

const dirs: string[] = [];

async function writeProvenance(overrides: Record<string, unknown> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'evb-provenance-'));
    dirs.push(dir);
    const path = join(dir, 'provenance.json');
    await writeFile(path, JSON.stringify({
        schemaVersion: 1,
        commitSha: 'abc',
        version: '1.2.3',
        arch: 'x64',
        channel: 'direct',
        appAsar: {sha256: 'asar-hash'},
        lockfileSha256: 'lock-hash',
        ...overrides,
    }));
    return path;
}

afterEach(async () => Promise.all(dirs.splice(0).map(dir => rm(dir, {
    recursive: true,
    force: true,
}))));

describe('release build provenance', () => {
    it('accepts independently packaged applications with identical inputs and ASAR', async () => {
        await expect(assertMatchingBuildProvenance(
            await writeProvenance({channel: 'direct'}),
            await writeProvenance({channel: 'store'}),
        )).resolves.toBeDefined();
    });

    it('rejects a Store package whose application payload differs', async () => {
        await expect(assertMatchingBuildProvenance(
            await writeProvenance(),
            await writeProvenance({appAsar: {sha256: 'different'}}),
        )).rejects.toThrow('app.asar hash mismatch');
    });
});
