import {
    createReleaseCatalogLoader,
    fetchReleaseDataWithRetry,
    getReleaseFetchStatusCode,
    getMissingConfiguredReleaseTags,
    detectArchitecture,
    detectPlatform,
    getAssetExtension,
    isInstallerAsset,
    normalizeInstallers,
    normalizeCanaryPercent,
    parseReleaseTagList,
    selectReleaseForRollout,
    type ILatestReleaseResponse,
    type IReleaseInstaller,
} from '@releaseSelection';
import { isLegacyInstallerAsset } from '@releaseSelection';

interface IGithubReleaseAsset {
    id: number
    name: string
    browser_download_url: string
    size: number
    updated_at: string
    content_type: string
}

const RELEASE_COHORT_COOKIE = 'evb_release_cohort';
const RELEASE_COHORT_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const releaseCatalogLoader = createReleaseCatalogLoader<IGithubRelease[]>();

function parseHttpsUrl(value: string): string | null {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.href.replace(/\/+$/u, '') : null;
    } catch {
        return null;
    }
}

function getReleaseCohortKey(event: Parameters<typeof getCookie>[0]) {
    const existingCohort = getCookie(event, RELEASE_COHORT_COOKIE);
    if (existingCohort && /^[a-f\d-]{16,64}$/iu.test(existingCohort)) {
        return existingCohort;
    }

    const cohortKey = crypto.randomUUID();
    setCookie(event, RELEASE_COHORT_COOKIE, cohortKey, {
        httpOnly: true,
        maxAge: RELEASE_COHORT_MAX_AGE_SECONDS,
        path: '/api/releases/latest',
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
    });
    return cohortKey;
}

interface IGithubRelease {
    draft?: boolean
    prerelease?: boolean
    tag_name: string
    name: string
    published_at: string
    html_url: string
    assets: IGithubReleaseAsset[]
}

function toInstallers(release: IGithubRelease, mirrorBaseUrl: string): IReleaseInstaller[] {
    const installers = (release.assets || [])
        .filter(asset => isInstallerAsset(asset.name) && parseHttpsUrl(asset.browser_download_url))
        .map<IReleaseInstaller>((asset) => {
            const mirrorDownloadUrl = mirrorBaseUrl
                ? `${mirrorBaseUrl}/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`
                : null;
            return {
                id: asset.id,
                name: asset.name,
                downloadUrl: asset.browser_download_url,
                ...(mirrorDownloadUrl ? {mirrorDownloadUrl} : {}),
                size: asset.size,
                updatedAt: asset.updated_at,
                contentType: asset.content_type,
                extension: getAssetExtension(asset.name),
                platform: detectPlatform(asset.name),
                arch: detectArchitecture(asset.name),
                isLegacy: isLegacyInstallerAsset(asset.name),
            };
        });

    return normalizeInstallers(installers);
}

export default defineEventHandler(async (event): Promise<ILatestReleaseResponse> => {
    const config = useRuntimeConfig(event);
    setHeader(event, 'cache-control', 'private, no-store, max-age=0');

    const githubApiBase = parseHttpsUrl(String(config.githubApiBase || 'https://api.github.com'));
    if (!githubApiBase) {
        throw createError({
            statusCode: 500,
            statusMessage: 'GitHub API base URL must use HTTPS',
        });
    }
    const githubOwner = String(config.githubOwner || 'evb0110');
    const githubRepo = String(config.githubRepo || 'evb-viewer');
    const githubToken = String(config.githubToken || '');
    const releaseMirrorBaseUrl = parseHttpsUrl(String(config.releaseMirrorBaseUrl)) ?? '';
    const stableTags = parseReleaseTagList(String(config.releaseStableTags || ''));
    const canaryTag = String(config.releaseCanaryTag || '').trim() || null;
    const configuredTags = Array.from(new Set([
        ...stableTags,
        ...(canaryTag ? [canaryTag] : []),
    ]));

    const headers: Record<string, string> = {
        'accept': 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
    };

    if (githubToken && new URL(githubApiBase).hostname.toLowerCase() === 'api.github.com') {
        headers.authorization = `Bearer ${githubToken}`;
    }

    const githubRepositoryApiUrl = `${githubApiBase}/repos/${encodeURIComponent(githubOwner)}/${encodeURIComponent(githubRepo)}`;

    async function fetchReleaseCatalog(signal: AbortSignal): Promise<IGithubRelease[]> {
        const releases = await $fetch<IGithubRelease[]>(`${githubRepositoryApiUrl}/releases`, {
            headers,
            query: {per_page: 100},
            retry: 0,
            signal,
            timeout: 6_000,
        });
        const exactReleases = await Promise.all(getMissingConfiguredReleaseTags(releases, configuredTags)
            .map(async (tag) => {
                try {
                    return await $fetch<IGithubRelease>(
                        `${githubRepositoryApiUrl}/releases/tags/${encodeURIComponent(tag)}`,
                        {
                            headers,
                            retry: 0,
                            signal,
                            timeout: 6_000,
                        },
                    );
                } catch (error) {
                    if (getReleaseFetchStatusCode(error) === 404) {
                        return null;
                    }
                    throw error;
                }
            }));
        return [
            ...releases,
            ...exactReleases.filter((release): release is IGithubRelease => release !== null),
        ];
    }

    let catalogResult: {
        catalog: IGithubRelease[]
        stale: boolean
    };
    try {
        const cacheKey = JSON.stringify([
            githubApiBase,
            githubOwner,
            githubRepo,
            configuredTags,
        ]);
        catalogResult = await releaseCatalogLoader({
            cacheKey,
            fetchCatalog: async () => {
                return fetchReleaseDataWithRetry({
                    fetchResult: fetchReleaseCatalog,
                    shouldRetryResult: catalog => catalog.length === 0,
                });
            },
            isUsableCatalog: catalog => catalog.length > 0,
        });
    } catch (error) {
        console.error('Unable to fetch release catalog', {
            message: error instanceof Error ? error.message : String(error),
            statusCode: getReleaseFetchStatusCode(error) ?? undefined,
            statusMessage: typeof error === 'object' && error && 'statusMessage' in error ? error.statusMessage : undefined,
        });
        throw createError({
            statusCode: 503,
            statusMessage: 'Release catalog is temporarily unavailable',
        });
    }

    const release = selectReleaseForRollout(catalogResult.catalog, {
        canaryPercent: normalizeCanaryPercent(String(config.releaseCanaryPercent || '0')),
        canaryTag,
        stableTags,
        withdrawnTags: new Set(parseReleaseTagList(String(config.releaseWithdrawnTags || ''))),
    }, getReleaseCohortKey(event));
    if (!release) {
        throw createError({
            statusCode: 503,
            statusMessage: stableTags.length > 0
                ? 'No configured stable release is currently available'
                : 'No public release is currently available',
        });
    }
    const installers = toInstallers(release, releaseMirrorBaseUrl);

    if (catalogResult.stale) {
        setHeader(event, 'x-evb-release-catalog', 'stale');
    }

    return {
        release: {
            tag: release.tag_name,
            name: release.name ?? release.tag_name,
            publishedAt: release.published_at,
            htmlUrl: parseHttpsUrl(release.html_url)
                ?? `https://github.com/${encodeURIComponent(githubOwner)}/${encodeURIComponent(githubRepo)}/releases/tag/${encodeURIComponent(release.tag_name)}`,
        },
        assets: installers,
        recommendation: {
            platform: 'unknown',
            arch: 'unknown',
            assetId: null,
        },
    };
});
