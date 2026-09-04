import {tmpdir} from 'node:os';
import path from 'node:path';
import {
    mkdir,
    mkdtemp,
    readFile,
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
import {sendSentrySourcemapCanaries} from '@scripts/release/send-sentry-sourcemap-canaries.mjs';
import {getPrivateSourcemapManifestPath} from '@scripts/release/stage-private-sourcemaps.mjs';

const roots: string[] = [];
const identity = {
    target: 'desktop',
    release: 'evb-viewer-desktop@1.2.3',
    dist: 'macos-arm64',
    environment: 'test',
} as const;

async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-sentry-canary-'));
    roots.push(root);
    const manifestPath = getPrivateSourcemapManifestPath({
        projectRoot: root,
        identity,
    });
    const stageRoot = path.dirname(manifestPath);
    await mkdir(path.join(stageRoot, 'maps/dist-electron'), {recursive: true});
    await writeFile(path.join(stageRoot, 'maps/dist-electron/main.js.map'), JSON.stringify({
        version: 3,
        file: 'main.js',
        sources: ['../../electron/main.ts'],
        names: ['start'],
        mappings: 'AAAAA',
        debug_id: '12345678-1234-5678-9abc-123456789abc',
    }));
    await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 1,
        identity,
        bundles: [{
            bundle: 'dist-electron/main.js',
            role: 'electron-main',
            sources: ['electron/main.ts'],
            stagedMapPath: 'maps/dist-electron/main.js.map',
        }],
    }));
    return root;
}

function environment(overrides: Record<string, string> = {}) {
    return {
        EVB_SENTRY_TARGET: 'desktop',
        EVB_SENTRY_RELEASE: identity.release,
        EVB_SENTRY_DIST: identity.dist,
        EVB_SENTRY_ENVIRONMENT: identity.environment,
        SENTRY_DESKTOP_DSN: 'https://public@o123.ingest.de.sentry.io/42',
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('Sentry source-map canaries', () => {
    it('sends one closed deterministic Debug-ID event per project-source bundle', async () => {
        const root = await setup();
        const sentEvents: unknown[] = [];
        const sendEvent = vi.fn(async (event: unknown) => {
            sentEvents.push(event);
        });
        const receipt = await sendSentrySourcemapCanaries({
            environment: environment(),
            projectRoot: root,
            sendEvent,
        });

        expect(sendEvent).toHaveBeenCalledOnce();
        expect(sentEvents[0]).toMatchObject({
            release: identity.release,
            dist: identity.dist,
            environment: 'test',
            tags: {
                evb_schema: 'evb-diagnostic-v1',
                evb_canary: 'sourcemap-v1',
            },
            debug_meta: {images: [{
                type: 'sourcemap',
                code_file: 'dist-electron/main.js',
                debug_id: '12345678-1234-5678-9abc-123456789abc',
            }]},
        });
        expect(receipt.events).toEqual([expect.objectContaining({
            bundle: 'dist-electron/main.js',
            eventId: '94967d8c2bc722b9146b2a557b56a6f5',
            expectedFunction: 'start',
            expectedLine: 1,
            expectedSource: 'electron/main.ts',
        })]);
        const written = await readFile(path.join(
            path.dirname(getPrivateSourcemapManifestPath({
                projectRoot: root,
                identity,
            })),
            'canary-receipt.json',
        ), 'utf8');
        expect(written).not.toContain('ingest.de.sentry.io');
        expect(written).not.toContain('public@');
    });

    it('records generated or vendor-only bundles that cannot prove an EVB mapping', async () => {
        const root = await setup();
        const manifestPath = getPrivateSourcemapManifestPath({
            projectRoot: root,
            identity,
        });
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {bundles: Array<Record<string, unknown>>};
        manifest.bundles.unshift({
            bundle: 'dist-electron/vendor.js',
            role: 'electron-main',
            sources: [],
            stagedMapPath: 'maps/dist-electron/vendor.js.map',
        });
        await writeFile(manifestPath, JSON.stringify(manifest));
        const sendEvent = vi.fn();

        const receipt = await sendSentrySourcemapCanaries({
            environment: environment(),
            projectRoot: root,
            sendEvent,
        });

        expect(sendEvent).toHaveBeenCalledOnce();
        expect(receipt.skippedBundles).toEqual([{
            bundle: 'dist-electron/vendor.js',
            reason: 'no-project-source',
            role: 'electron-main',
        }]);
    });

    it('rejects production without the explicit one-run override', async () => {
        const root = await setup();
        await expect(sendSentrySourcemapCanaries({
            environment: environment({EVB_SENTRY_ENVIRONMENT: 'production'}),
            projectRoot: root,
            sendEvent: vi.fn(),
        })).rejects.toThrow('explicit one-run override');
    });

    it('rejects a source-map path outside the private stage', async () => {
        const root = await setup();
        const manifestPath = getPrivateSourcemapManifestPath({
            projectRoot: root,
            identity,
        });
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {bundles: Array<{stagedMapPath: string}>};
        manifest.bundles[0]!.stagedMapPath = '../../outside.map';
        await writeFile(manifestPath, JSON.stringify(manifest));

        await expect(sendSentrySourcemapCanaries({
            environment: environment(),
            projectRoot: root,
            sendEvent: vi.fn(),
        })).rejects.toThrow('escapes the private source-map stage');
    });
});
