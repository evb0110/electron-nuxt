import {
    mkdir,
    readFile,
    rm,
    stat,
    writeFile,
    mkdtemp,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {WORKER_BUNDLES} from '@electron-worker-bundles/electronWorkerBundles.js';
import {createSentryBuildIdentity} from '@contracts/diagnostics/releaseIdentity.js';
import {
    assertPublicOutputMapFree,
    getPrivateSourcemapManifestPath,
    getSentryBuildIdentityLockPath,
    stagePrivateSourcemaps,
} from '@scripts/release/stage-private-sourcemaps.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

async function createTemporaryRoot() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-private-sourcemaps-'));
    temporaryRoots.push(root);
    return root;
}

async function writeBundle(
    projectRoot: string,
    relativeBundle: string,
    source: string,
    {sourceRoot}: {sourceRoot?: string} = {},
) {
    const bundlePath = path.join(projectRoot, relativeBundle);
    await mkdir(path.dirname(bundlePath), {recursive: true});
    await writeFile(
        bundlePath,
        `export const source = ${JSON.stringify(source)};\n//# sourceMappingURL=${path.basename(relativeBundle)}.map\n`,
    );
    await writeFile(`${bundlePath}.map`, `${JSON.stringify({
        version: 3,
        file: path.basename(relativeBundle),
        sourceRoot,
        sources: [source],
        names: [],
        mappings: '',
    })}\n`);
}

async function writeSource(projectRoot: string, relativePath: string, content = 'export {};\n') {
    const sourcePath = path.join(projectRoot, relativePath);
    await mkdir(path.dirname(sourcePath), {recursive: true});
    await writeFile(sourcePath, content);
}

async function writeFixture(projectRoot: string) {
    await writeSource(projectRoot, 'electron/main.ts', 'const source = "private-source";\n');
    await writeSource(projectRoot, 'electron/preload.ts');
    await writeBundle(projectRoot, 'dist-electron/main.js', '../electron/main.ts');
    await writeBundle(projectRoot, 'dist-electron/main-chunk-renderer.js', '../electron/main.ts');
    await writeBundle(projectRoot, 'dist-electron/preload.cjs', '../electron/preload.ts');
    await writeSource(projectRoot, 'dist-electron/pdf.worker.mjs');

    for (const worker of WORKER_BUNDLES) {
        const sourcePath = `electron/${worker.id}.ts`;
        await writeSource(projectRoot, sourcePath);
        await writeBundle(projectRoot, `dist-electron/${worker.fileName}`, `../${sourcePath}`);
    }

    await writeSource(projectRoot, 'app/app.vue');
    await writeSource(projectRoot, 'app/browser-worker.ts');
    await writeBundle(projectRoot, 'nuxt-output/public/_nuxt/app.js', '../../../app/app.vue');
    await writeBundle(
        projectRoot,
        'nuxt-output/public/_nuxt/pdf-worker.js',
        'app/browser-worker.ts',
        {sourceRoot: '../../../'},
    );
    await writeSource(projectRoot, 'server/index.ts');
    await writeBundle(projectRoot, 'nuxt-output/server/index.mjs', '../../server/index.ts');

    await writeSource(projectRoot, 'landing/app/landing.ts');
    await writeBundle(projectRoot, 'landing/.vercel/output/public/_nuxt/landing.js', '../landing.ts');
}

function desktopIdentity(dist: 'macos-arm64' | 'windows-x64') {
    return createSentryBuildIdentity({
        target: 'desktop',
        version: '1.2.3+ci.7',
        dist,
        environment: 'test',
    });
}

async function fileExists(filePath: string) {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

describe('private Sentry source-map staging', () => {
    it('stages every reportable bundle deterministically and leaves public outputs map-free', async () => {
        const projectRoot = await createTemporaryRoot();
        const identity = desktopIdentity('macos-arm64');

        await writeFixture(projectRoot);
        const firstManifest = await stagePrivateSourcemaps({
            projectRoot,
            identity,
            outputRoots: [
                'dist-electron',
                'nuxt-output',
            ],
            reset: true,
        });
        const firstManifestText = await readFile(
            getPrivateSourcemapManifestPath({
                projectRoot,
                identity,
            }),
            'utf8',
        );

        expect(firstManifest.identity).toEqual(identity);
        expect(firstManifest.bundles).toHaveLength(15);
        expect(firstManifest.bundles.every(bundle => (
            bundle.map.endsWith('.map')
            && bundle.stagedMapPath.startsWith('maps/')
            && bundle.sourceFiles.length > 0
        ))).toBe(true);
        for (const bundle of firstManifest.bundles) {
            const injectedBundle = await readFile(path.join(projectRoot, bundle.bundle), 'utf8');
            const privateMap = JSON.parse(await readFile(path.join(
                projectRoot,
                '.tmp/private-sourcemaps',
                'desktop',
                encodeURIComponent(identity.release),
                encodeURIComponent(identity.dist),
                encodeURIComponent(identity.environment),
                bundle.stagedMapPath,
            ), 'utf8')) as {
                debug_id?: unknown;
                debugId?: unknown;
            };
            expect(injectedBundle).toContain('_sentryDebugIds');
            expect(privateMap.debug_id ?? privateMap.debugId).toMatch(
                /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
            );
        }
        expect(firstManifest.bundles.some(bundle => bundle.role === 'electron-main')).toBe(true);
        expect(firstManifest.bundles.some(bundle => bundle.role === 'electron-utility-parent')).toBe(true);
        expect(firstManifest.bundles.some(bundle => bundle.role === 'electron-worker-parent')).toBe(true);
        expect(firstManifest.bundles.some(bundle => bundle.role === 'browser-renderer')).toBe(true);
        expect(firstManifest.bundles.some(bundle => bundle.role === 'browser-worker-parent')).toBe(true);
        expect(firstManifest.bundles.some(bundle => bundle.role === 'nitro-server')).toBe(true);
        expect(firstManifest.bundles.some(bundle => bundle.bundle.includes('preload'))).toBe(false);
        expect(firstManifest.bundles.some(bundle => bundle.bundle.includes('landing'))).toBe(false);
        expect(firstManifest.removedPublicMaps).toContain('dist-electron/preload.cjs.map');
        expect(firstManifestText).not.toContain('private-source');

        for (const bundle of firstManifest.bundles) {
            expect(await fileExists(path.join(
                projectRoot,
                '.tmp/private-sourcemaps',
                'desktop',
                encodeURIComponent(identity.release),
                encodeURIComponent(identity.dist),
                encodeURIComponent(identity.environment),
                bundle.stagedMapPath,
            ))).toBe(true);
            for (const source of bundle.sourceFiles) {
                expect(await fileExists(path.join(
                    projectRoot,
                    '.tmp/private-sourcemaps',
                    'desktop',
                    encodeURIComponent(identity.release),
                    encodeURIComponent(identity.dist),
                    encodeURIComponent(identity.environment),
                    source.stagedPath,
                ))).toBe(true);
            }
        }

        await assertPublicOutputMapFree({
            projectRoot,
            outputRoots: [
                'dist-electron',
                'nuxt-output',
            ],
        });
        expect(await fileExists(path.join(
            projectRoot,
            'landing/.vercel/output/public/_nuxt/landing.js.map',
        ))).toBe(true);

        await writeFixture(projectRoot);
        await stagePrivateSourcemaps({
            projectRoot,
            identity,
            outputRoots: [
                'dist-electron',
                'nuxt-output',
            ],
            reset: true,
        });
        const secondManifestText = await readFile(
            getPrivateSourcemapManifestPath({
                projectRoot,
                identity,
            }),
            'utf8',
        );
        expect(secondManifestText).toBe(firstManifestText);
    });

    it('atomically admits one of two concurrent conflicting identities', async () => {
        const projectRoot = await createTemporaryRoot();
        const identities = [
            desktopIdentity('macos-arm64'),
            desktopIdentity('windows-x64'),
        ];
        const results = await Promise.allSettled(identities.map(identity => stagePrivateSourcemaps({
            projectRoot,
            identity,
            outputRoots: [],
            removePublicOutputMaps: false,
        })));

        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        expect(rejected).toMatchObject({status: 'rejected'});
        expect(String(rejected?.reason)).toMatch(/conflicting.*Sentry build identit(?:y|ies)/iu);

        const lock = JSON.parse(await readFile(
            getSentryBuildIdentityLockPath({projectRoot}),
            'utf8',
        ));
        expect(identities).toContainEqual(lock);
    });
});
