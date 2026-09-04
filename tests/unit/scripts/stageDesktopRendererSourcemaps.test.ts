import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {stageDesktopRendererSourcemaps} from '@scripts/release/stage-desktop-renderer-sourcemaps.mjs';

const roots: string[] = [];

async function projectRoot() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-desktop-renderer-maps-'));
    roots.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({version: '1.2.3'}));
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('desktop renderer source-map staging', () => {
    it('stages Nuxt output before generic build pruning', async () => {
        const root = await projectRoot();
        const identity = {
            target: 'desktop',
            release: 'evb-viewer-desktop@1.2.3',
            dist: 'macos-arm64',
            environment: 'test',
        } as const;
        const manifest = {
            bundles: [],
            identity,
            removedPublicMaps: [],
            schemaVersion: 1,
            sources: [],
            unmappedGeneratedBundles: [],
        };
        const stage = vi.fn(async () => manifest);
        const loadStage = vi.fn(async () => stage);

        await expect(stageDesktopRendererSourcemaps({
            environment: {
                EVB_SENTRY_DIAGNOSTICS_BUILD: '1',
                EVB_SENTRY_TARGET: 'desktop',
                EVB_SENTRY_ENVIRONMENT: 'test',
                EVB_RELEASE_TARGET_PLATFORM: 'mac',
                EVB_RELEASE_TARGET_ARCH: 'arm64',
            },
            projectRoot: root,
            stageSourcemaps: loadStage,
        })).resolves.toEqual(manifest);

        expect(stage).toHaveBeenCalledWith({
            identity,
            outputRoots: ['nuxt-output'],
            projectRoot: root,
            reset: true,
            includeNitro: false,
        });
    });

    it('does not load map tooling for ordinary or web builds', async () => {
        const root = await projectRoot();
        const loadStage = vi.fn();

        await expect(stageDesktopRendererSourcemaps({
            environment: {},
            projectRoot: root,
            stageSourcemaps: loadStage,
        })).resolves.toBeNull();
        await expect(stageDesktopRendererSourcemaps({
            environment: {
                EVB_SENTRY_DIAGNOSTICS_BUILD: '1',
                EVB_SENTRY_TARGET: 'web',
                EVB_SENTRY_ENVIRONMENT: 'preview',
            },
            projectRoot: root,
            stageSourcemaps: loadStage,
        })).resolves.toBeNull();
        expect(loadStage).not.toHaveBeenCalled();
    });
});
