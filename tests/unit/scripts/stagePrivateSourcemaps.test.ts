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

async function writeNuxtClientManifest(projectRoot: string, bundleNames: string[]) {
    const manifestPath = path.join(
        projectRoot,
        'node_modules/.cache/nuxt/.nuxt/dist/server/client.manifest.mjs',
    );
    await mkdir(path.dirname(manifestPath), {recursive: true});
    const entries = Object.fromEntries(bundleNames.map((file, index) => [
        `generated-${index}`,
        {
            file,
            resourceType: 'script',
        },
    ]));
    await writeFile(manifestPath, `export default (${JSON.stringify(entries)})\n`);
}

async function writeFixture(projectRoot: string) {
    await writeSource(projectRoot, 'electron/main.ts', 'const source = "private-source";\n');
    await writeSource(projectRoot, 'electron/preload.ts');
    await writeBundle(projectRoot, 'dist-electron/main.js', '../electron/main.ts');
    const mainMapPath = path.join(projectRoot, 'dist-electron/main.js.map');
    const mainMap = JSON.parse(await readFile(mainMapPath, 'utf8')) as {sources: string[]};
    mainMap.sources.push('<define:__EVB_SENTRY_BUILD_IDENTITY__>');
    mainMap.sources.push('../../virtual:nuxt:generated%2Fskeleton.ts');
    mainMap.sources.push('../node_modules/.pnpm/dependency/src/missing.ts');
    mainMap.sources.push('webpack://pdf.js/node_modules/core-js/internals/a-callable.js');
    await writeFile(mainMapPath, `${JSON.stringify(mainMap)}\n`);
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

function webIdentity() {
    return createSentryBuildIdentity({
        target: 'web',
        version: '1.2.3',
        dist: 'preview-local',
        environment: 'preview',
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
    it('records manifest-proven generated browser bundles but rejects unlisted map gaps', async () => {
        const projectRoot = await createTemporaryRoot();
        const outputRoot = '.vercel/output';
        const mappedBundle = `${outputRoot}/static/_nuxt/app.js`;
        const generatedBundle = `${outputRoot}/static/_nuxt/facade.js`;

        await writeSource(projectRoot, 'app/app.vue');
        await writeBundle(projectRoot, mappedBundle, '../../app/app.vue');
        await writeSource(
            projectRoot,
            generatedBundle,
            'import {value} from "./app.js"; export {value};\n',
        );
        await writeNuxtClientManifest(projectRoot, [
            'app.js',
            'facade.js',
        ]);
        const manifest = await stagePrivateSourcemaps({
            projectRoot,
            identity: webIdentity(),
            outputRoots: [outputRoot],
            reset: true,
            removePublicOutputMaps: false,
        });

        expect(manifest.bundles).toHaveLength(1);
        expect(manifest.unmappedGeneratedBundles).toEqual([expect.objectContaining({
            bundle: generatedBundle,
            producer: 'nuxt-client-manifest',
            role: 'browser-generated-mapless',
        })]);
        expect(await readFile(path.join(projectRoot, generatedBundle), 'utf8'))
            .not.toContain('_sentryDebugIds');

        await writeSource(
            projectRoot,
            `${outputRoot}/static/_nuxt/unmapped-app.js`,
            'export const data = "small but not producer-listed";\n',
        );
        await expect(stagePrivateSourcemaps({
            projectRoot,
            identity: webIdentity(),
            outputRoots: [outputRoot],
            reset: true,
            removePublicOutputMaps: false,
        })).rejects.toThrow('Reportable bundle has no external source map');

        await rm(path.join(projectRoot, `${outputRoot}/static/_nuxt/unmapped-app.js`));
        await writeSource(
            projectRoot,
            `${outputRoot}/static/_nuxt/nested/facade.js`,
            'export const nested = true;\n',
        );
        await writeNuxtClientManifest(projectRoot, [
            'app.js',
            'facade.js',
            'other/facade.js',
        ]);
        await expect(stagePrivateSourcemaps({
            projectRoot,
            identity: webIdentity(),
            outputRoots: [outputRoot],
            reset: true,
            removePublicOutputMaps: false,
        })).rejects.toThrow('Reportable bundle has no external source map');

        await rm(path.join(projectRoot, `${outputRoot}/static/_nuxt/nested/facade.js`));
        await writeSource(
            projectRoot,
            `${outputRoot}/static/_nuxt/dangling.js`,
            'export const dangling = true;\n//# sourceMappingURL=missing.js.map\n',
        );
        await writeNuxtClientManifest(projectRoot, [
            'app.js',
            'facade.js',
            'dangling.js',
        ]);
        await expect(stagePrivateSourcemaps({
            projectRoot,
            identity: webIdentity(),
            outputRoots: [outputRoot],
            reset: true,
            removePublicOutputMaps: false,
        })).rejects.toThrow('Reportable bundle has no external source map');
    });

    it('keeps one current manifest state when a bundle gains or loses its map', async () => {
        const projectRoot = await createTemporaryRoot();
        const outputRoot = '.vercel/output';
        const relativeBundle = `${outputRoot}/static/_nuxt/facade.js`;
        const identity = webIdentity();

        await writeNuxtClientManifest(projectRoot, ['facade.js']);
        await writeSource(projectRoot, relativeBundle, 'export const value = 1;\n');
        const maplessManifest = await stagePrivateSourcemaps({
            projectRoot,
            identity,
            outputRoots: [outputRoot],
            reset: true,
            removePublicOutputMaps: false,
        });
        expect(maplessManifest.bundles).toHaveLength(0);
        expect(maplessManifest.unmappedGeneratedBundles).toHaveLength(1);

        await writeSource(projectRoot, 'app/app.vue');
        await writeBundle(projectRoot, relativeBundle, '../../../../app/app.vue');
        const mappedManifest = await stagePrivateSourcemaps({
            projectRoot,
            identity,
            outputRoots: [outputRoot],
            removePublicOutputMaps: false,
        });
        expect(mappedManifest.bundles).toHaveLength(1);
        expect(mappedManifest.unmappedGeneratedBundles).toHaveLength(0);

        await writeSource(projectRoot, relativeBundle, 'export const value = 2;\n');
        await rm(path.join(projectRoot, `${relativeBundle}.map`));
        const maplessAgainManifest = await stagePrivateSourcemaps({
            projectRoot,
            identity,
            outputRoots: [outputRoot],
            removePublicOutputMaps: false,
        });
        expect(maplessAgainManifest.bundles).toHaveLength(0);
        expect(maplessAgainManifest.unmappedGeneratedBundles).toHaveLength(1);
    });

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
        expect(firstManifestText).not.toContain('virtual:nuxt');

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

    it('replaces a completed prior-build identity lock for a standalone Electron build', async () => {
        const projectRoot = await createTemporaryRoot();
        const previousIdentity = createSentryBuildIdentity({
            target: 'desktop',
            version: '1.2.2',
            dist: 'macos-arm64',
            environment: 'test',
        });
        const nextIdentity = desktopIdentity('macos-arm64');

        await stagePrivateSourcemaps({
            projectRoot,
            identity: previousIdentity,
            outputRoots: [],
            removePublicOutputMaps: false,
        });
        await expect(stagePrivateSourcemaps({
            projectRoot,
            identity: nextIdentity,
            outputRoots: [],
            removePublicOutputMaps: false,
            resetCompletedIdentityLock: true,
        })).resolves.toMatchObject({identity: nextIdentity});

        await expect(readFile(getSentryBuildIdentityLockPath({projectRoot}), 'utf8'))
            .resolves.toBe(`${JSON.stringify(nextIdentity, null, 2)}\n`);
    });
});
