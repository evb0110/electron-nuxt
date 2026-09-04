import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {SentryBuildIdentity} from '@contracts/diagnostics/releaseIdentity.js';
import {
    getPrivateSourcemapManifestPath,
    stagePrivateSourcemaps,
} from '@scripts/release/stage-private-sourcemaps.mjs';
import {uploadSentrySourcemaps} from '@scripts/release/upload-sentry-sourcemaps.mjs';

const temporaryRoots: string[] = [];
const identity: SentryBuildIdentity = {
    target: 'desktop',
    release: 'evb-viewer-desktop@0.1.449',
    dist: 'macos-arm64',
    environment: 'test',
};

async function createFixture() {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'evb-sentry-upload-'));
    temporaryRoots.push(projectRoot);
    await mkdir(path.join(projectRoot, 'dist-electron'), {recursive: true});
    await mkdir(path.join(projectRoot, 'electron'), {recursive: true});
    await writeFile(path.join(projectRoot, 'electron/main.ts'), 'throw new Error("fixture");\n');
    await writeFile(
        path.join(projectRoot, 'dist-electron/main.js'),
        'throw new Error("fixture");\n//# sourceMappingURL=main.js.map\n',
    );
    await writeFile(path.join(projectRoot, 'dist-electron/main.js.map'), JSON.stringify({
        file: 'main.js',
        mappings: 'AAAA',
        names: [],
        sources: ['../electron/main.ts'],
        version: 3,
    }));
    await stagePrivateSourcemaps({
        projectRoot,
        identity,
        outputRoots: ['dist-electron'],
        reset: true,
    });
    return projectRoot;
}

function privateEnvironment() {
    return {
        SENTRY_AUTH_TOKEN: 'private-upload-token',
        SENTRY_DESKTOP_PROJECT: 'private-desktop-project',
        SENTRY_ORG: 'private-organization',
    };
}

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('uploadSentrySourcemaps', () => {
    it('uploads one exact private tree and records a credential-free receipt', async () => {
        const projectRoot = await createFixture();
        const runCli = vi.fn(async (args: string[], options: {token: string}) => {
            const uploadRoot = args.at(-1);
            expect(uploadRoot).toBeTypeOf('string');
            expect(await readFile(path.join(uploadRoot!, 'dist-electron/main.js'), 'utf8'))
                .toContain('_sentryDebugIds');
            expect(JSON.parse(await readFile(
                path.join(uploadRoot!, 'dist-electron/main.js.map'),
                'utf8',
            ))).toMatchObject({version: 3});
            expect(await readFile(path.join(uploadRoot!, 'electron/main.ts'), 'utf8'))
                .toContain('fixture');
            expect(options).toEqual({token: 'private-upload-token'});
        });

        const receipt = await uploadSentrySourcemaps({
            identity,
            projectRoot,
            environment: privateEnvironment(),
            runCli,
        });

        expect(runCli).toHaveBeenCalledOnce();
        expect(runCli.mock.calls[0]?.[0]).toEqual([
            'sourcemaps',
            'upload',
            '--org',
            'private-organization',
            '--project',
            'private-desktop-project',
            '--release',
            identity.release,
            '--dist',
            identity.dist,
            '--validate',
            '--strict',
            '--wait',
            '--quiet',
            '--ext',
            'js',
            '--ext',
            'cjs',
            '--ext',
            'mjs',
            '--ext',
            'map',
            '--ext',
            'jsbundle',
            '--ext',
            'bundle',
            '--ext',
            'ts',
            '--ext',
            'tsx',
            '--ext',
            'vue',
            '--ext',
            'json',
            expect.stringContaining('.upload-'),
        ]);
        expect(receipt).toMatchObject({
            bundleCount: 1,
            identity,
            schemaVersion: 1,
        });
        const stageRoot = path.dirname(getPrivateSourcemapManifestPath({
            projectRoot,
            identity,
        }));
        const receiptText = await readFile(path.join(stageRoot, 'upload-receipt.json'), 'utf8');
        expect(receiptText).not.toContain('private-upload-token');
        expect(receiptText).not.toContain('private-organization');
        expect(receiptText).not.toContain('private-desktop-project');
        expect((await readdir(stageRoot)).some(entry => entry.startsWith('.upload-'))).toBe(false);
    });

    it('treats a matching private receipt as an exact-build no-op', async () => {
        const projectRoot = await createFixture();
        const runCli = vi.fn().mockResolvedValue(undefined);
        const options = {
            identity,
            projectRoot,
            environment: privateEnvironment(),
            runCli,
        };

        const first = await uploadSentrySourcemaps(options);
        const second = await uploadSentrySourcemaps(options);

        expect(second).toEqual(first);
        expect(runCli).toHaveBeenCalledOnce();
    });

    it('removes temporary private bytes and writes no receipt after upload failure', async () => {
        const projectRoot = await createFixture();
        const stageRoot = path.dirname(getPrivateSourcemapManifestPath({
            projectRoot,
            identity,
        }));

        await expect(uploadSentrySourcemaps({
            identity,
            projectRoot,
            environment: privateEnvironment(),
            runCli: vi.fn().mockRejectedValue(new Error('remote failure with private-upload-token')),
        })).rejects.toThrow('Private Sentry source-map upload failed');

        expect((await readdir(stageRoot)).some(entry => entry.startsWith('.upload-'))).toBe(false);
        await expect(readFile(path.join(stageRoot, 'upload-receipt.json')))
            .rejects.toMatchObject({code: 'ENOENT'});
    });

    it('rejects missing private configuration without disclosing supplied values', async () => {
        const projectRoot = await createFixture();
        const runCli = vi.fn().mockResolvedValue(undefined);

        await expect(uploadSentrySourcemaps({
            identity,
            projectRoot,
            environment: {
                SENTRY_AUTH_TOKEN: 'private-upload-token',
                SENTRY_DESKTOP_PROJECT: 'private-desktop-project',
            },
            runCli,
        })).rejects.toThrow('Missing or invalid private Sentry organization configuration');
        expect(runCli).not.toHaveBeenCalled();
    });
});
