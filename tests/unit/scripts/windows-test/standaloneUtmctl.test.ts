import {createHash} from 'node:crypto';
import {
    chmod,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {windowsTestHostLayout} from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    prepareStandaloneUtmctl,
    resolvePreparedStandaloneUtmctl,
    standaloneUtmctlPaths,
} from '@scripts/windows-test/host/standaloneUtmctl';

const roots: string[] = [];
const SOURCE_BYTES = '#!/bin/sh\nprintf utmctl\n';

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

async function harness() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-windows-utmctl-'));
    roots.push(root);
    const layout = windowsTestHostLayout(root);
    const sourcePath = path.join(root, 'installed-utmctl');
    await writeFile(sourcePath, SOURCE_BYTES, 'utf8');
    await chmod(sourcePath, 0o755);
    return {
        layout,
        sourcePath,
        verifyCodeSignature: async () => undefined,
    };
}

describe('standalone utmctl preparation', () => {
    it('copies identical executable bytes into the tools cache and records the source digest', async () => {
        const options = await harness();
        const result = await prepareStandaloneUtmctl(options);
        const paths = standaloneUtmctlPaths(options.layout);
        const sourceBytes = await readFile(options.sourcePath);
        const copyBytes = await readFile(paths.executable);

        expect(result.standaloneUtmctlPath).toBe(paths.executable);
        expect(copyBytes).toEqual(sourceBytes);
        expect(createHash('sha256').update(copyBytes).digest('hex')).toBe(result.sourceSha256);
        expect((await stat(paths.executable)).mode & 0o111).not.toBe(0);
        await expect(resolvePreparedStandaloneUtmctl(options)).resolves.toBe(paths.executable);
    });

    it('rejects a source or cached copy that drifts after preparation', async () => {
        const options = await harness();
        await prepareStandaloneUtmctl(options);

        await writeFile(options.sourcePath, `${SOURCE_BYTES}drift\n`, 'utf8');
        await expect(resolvePreparedStandaloneUtmctl(options)).rejects.toThrow(/windows:test:prepare/u);

        await prepareStandaloneUtmctl(options);
        const paths = standaloneUtmctlPaths(options.layout);
        await writeFile(paths.executable, `${SOURCE_BYTES}modified\n`, 'utf8');
        await chmod(paths.executable, 0o755);
        await expect(resolvePreparedStandaloneUtmctl(options)).rejects.toThrow(/stale or modified/u);
    });

    it('removes a partial cache when code-signature verification fails', async () => {
        const options = await harness();
        await expect(prepareStandaloneUtmctl({
            ...options,
            verifyCodeSignature: async () => {
                throw new Error('signature rejected');
            },
        })).rejects.toThrow(/signature rejected/u);
        await expect(stat(standaloneUtmctlPaths(options.layout).executable)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('fails closed when the standalone cache is absent instead of returning the installed path', async () => {
        const options = await harness();

        await expect(resolvePreparedStandaloneUtmctl(options)).rejects.toThrow(/utmctl metadata/u);
        expect(standaloneUtmctlPaths(options.layout).executable).not.toBe(options.sourcePath);
    });
});
