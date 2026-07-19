import {
    fetchLatestReleaseWithRetry,
    getReleaseFetchStatusCode,
    detectArchitecture,
    detectPlatform,
    getAssetExtension,
    isInstallerAsset,
    normalizeInstallers,
    normalizeCanaryPercent,
    parseReleaseTagList,
    parseUserAgent,
    recommendInstaller,
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
        .filter(asset => isInstallerAsset(asset.name))
        .map<IReleaseInstaller>(asset => ({
            id: asset.id,
            name: asset.name,
            downloadUrl: asset.browser_download_url,
            mirrorDownloadUrl: `${mirrorBaseUrl}/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`,
            size: asset.size,
            updatedAt: asset.updated_at,
            contentType: asset.content_type,
            extension: getAssetExtension(asset.name),
            platform: detectPlatform(asset.name),
            arch: detectArchitecture(asset.name),
            isLegacy: isLegacyInstallerAsset(asset.name),
        }));

    return normalizeInstallers(installers);
}

export default defineEventHandler(async (event): Promise<ILatestReleaseResponse> => {
    const config = useRuntimeConfig(event);
    const githubApiBase = String(config.githubApiBase || 'https://api.github.com').replace(/\/+$/, '');
    const githubOwner = String(config.githubOwner || 'evb0110');
    const githubRepo = String(config.githubRepo || 'evb-viewer');
    const githubToken = String(config.githubToken || '');
    const releaseMirrorBaseUrl = String(config.releaseMirrorBaseUrl).replace(/\/+$/, '');

    const headers: Record<string, string> = {
        'accept': 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
    };

    if (githubToken) {
        headers.authorization = `Bearer ${githubToken}`;
    }

    async function fetchLatestRelease(): Promise<IGithubRelease> {
        const releases = await $fetch<IGithubRelease[]>(`${githubApiBase}/repos/${githubOwner}/${githubRepo}/releases`, {
            headers,
            query: {per_page: 30},
            retry: 0,
            timeout: 8_000,
        });
        const stableTags = parseReleaseTagList(String(config.releaseStableTags || ''));
        const selected = selectReleaseForRollout(releases, {
            canaryPercent: normalizeCanaryPercent(String(config.releaseCanaryPercent || '0')),
            canaryTag: String(config.releaseCanaryTag || '').trim() || null,
            stableTags,
            withdrawnTags: new Set(parseReleaseTagList(String(config.releaseWithdrawnTags || ''))),
        }, getHeader(event, 'x-forwarded-for') ?? getHeader(event, 'user-agent') ?? 'anonymous');
        if (!selected) {
            throw createError({
                statusCode: 503,
                statusMessage: stableTags.length > 0
                    ? 'No configured stable release is currently available'
                    : 'No public release is currently available',
            });
        }
        return selected;
    }

    let releaseResult: {
        release: IGithubRelease,
        installers: IReleaseInstaller[]
    };
    try {
        releaseResult = await fetchLatestReleaseWithRetry({
            fetchRelease: fetchLatestRelease,
            toInstallers: release => toInstallers(release, releaseMirrorBaseUrl),
        });
    } catch (error) {
        console.error('Unable to fetch latest release', {
            message: error instanceof Error ? error.message : String(error),
            statusCode: getReleaseFetchStatusCode(error) ?? undefined,
            statusMessage: typeof error === 'object' && error && 'statusMessage' in error ? error.statusMessage : undefined,
        });
        throw createError({
            statusCode: 502,
            statusMessage: 'Unable to fetch latest release data from GitHub',
        });
    }

    const {
        release, installers,
    } = releaseResult;

    const clientHintsPlatform = getHeader(event, 'sec-ch-ua-platform')?.replace(/"/g, '') ?? '';
    const profile = parseUserAgent(getHeader(event, 'user-agent') ?? '', clientHintsPlatform);
    const recommended = recommendInstaller(installers, profile);
    setHeader(event, 'vary', 'User-Agent, Sec-CH-UA-Platform');

    if (installers.length) {
        setHeader(event, 'cache-control', 'public, s-maxage=600, stale-while-revalidate=3600');
    } else {
        setHeader(event, 'cache-control', 'public, s-maxage=45, stale-while-revalidate=120');
    }

    return {
        release: {
            tag: release.tag_name,
            name: release.name ?? release.tag_name,
            publishedAt: release.published_at,
            htmlUrl: release.html_url,
        },
        assets: installers,
        recommendation: {
            platform: profile.platform,
            arch: profile.arch,
            assetId: recommended?.id ?? null,
        },
    };
});
