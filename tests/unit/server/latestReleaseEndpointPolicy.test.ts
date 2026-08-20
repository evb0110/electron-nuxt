import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const release = {
    tag_name: 'v2.0.0',
    name: 'EVB Viewer v2',
    published_at: '2026-08-19T00:00:00Z',
    html_url: 'https://github.com/evb0110/evb-viewer/releases/tag/v2.0.0',
    assets: [{
        id: 1,
        name: 'EVB-Viewer-2.0.0-x64.exe',
        browser_download_url: 'https://github.com/evb0110/evb-viewer/releases/download/v2.0.0/EVB-Viewer-2.0.0-x64.exe',
        size: 1_024,
        updated_at: '2026-08-19T00:00:00Z',
        content_type: 'application/octet-stream',
    }],
};

describe('latest release endpoint policy', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('sets a private response and an opaque cohort cookie without freezing a device recommendation', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const setHeader = vi.fn();
        const setCookie = vi.fn();
        const fetch = vi.fn(async () => [release]);
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
        vi.stubGlobal('useRuntimeConfig', () => ({
            githubApiBase: 'https://api.github.com',
            githubOwner: 'evb0110',
            githubRepo: 'evb-viewer',
            githubToken: '',
            releaseMirrorBaseUrl: 'https://mirror.example.test/releases',
            releaseStableTags: '',
            releaseWithdrawnTags: '',
            releaseCanaryTag: '',
            releaseCanaryPercent: '0',
        }));
        vi.stubGlobal('setHeader', setHeader);
        vi.stubGlobal('getCookie', vi.fn(() => undefined));
        vi.stubGlobal('setCookie', setCookie);
        vi.stubGlobal('$fetch', fetch);
        vi.stubGlobal('createError', (details: {statusMessage: string}) => new Error(details.statusMessage));
        const endpointPath = resolve(process.cwd(), 'landing/server/api/releases/latest.get.ts');
        const {default: handler} = await import(endpointPath);

        const response = await handler({} as never);

        expect(setHeader).toHaveBeenCalledWith({}, 'cache-control', 'private, no-store, max-age=0');
        expect(setCookie).toHaveBeenCalledWith(
            {},
            'evb_release_cohort',
            expect.stringMatching(/^[a-f\d-]{36}$/u),
            expect.objectContaining({
                httpOnly: true,
                maxAge: 7_776_000,
                path: '/api/releases/latest',
                sameSite: 'lax',
                secure: true,
            }),
        );
        expect(response.recommendation).toEqual({
            platform: 'unknown',
            arch: 'unknown',
            assetId: null,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('uses the policy-neutral releases index only while selected release data is unavailable', () => {
        const source = readFileSync(resolve(process.cwd(), 'landing/app/pages/index.vue'), 'utf8');

        expect(source).toContain('releaseData.value?.release.htmlUrl ?? `${GITHUB_REPOSITORY_URL}/releases`');
        expect(source).not.toContain('`${GITHUB_REPOSITORY_URL}/releases/latest`');
    });
});
