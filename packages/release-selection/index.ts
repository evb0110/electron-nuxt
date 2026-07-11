export {
    buildClientProfile,
    detectArchitecture,
    detectPlatform,
    compareInstallersForSelect,
    formatArch,
    formatExtension,
    formatFileSize,
    formatInstallerArchLabel,
    formatInstallerLabel,
    formatInstallerMeta,
    formatInstallerVariantLabel,
    formatPlatform,
    getAssetExtension,
    INSTALLER_PLATFORM_ORDER,
    isInstallerAsset,
    isLegacyInstallerAsset,
    normalizeInstallers,
    parseArchitectureHint,
    parsePlatformHint,
    parseUserAgent,
    recommendInstaller,
    selectPreferredInstallers,
} from '@evb/releaseSelection/releaseSelection';

export type {
    ILatestReleaseResponse,
    IReleaseInstaller,
    IReleaseSummary,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from '@contracts';

export {
    fetchLatestReleaseWithRetry,
    getReleaseFetchStatusCode,
    parseRetryAfterMs,
    shouldRetryReleaseFetch,
} from '@evb/releaseSelection/latestReleaseRetry';

export {
    normalizeCanaryPercent,
    parseReleaseTagList,
    selectReleaseForRollout,
} from '@evb/releaseSelection/releaseRolloutPolicy';
export type {
    IReleaseRolloutPolicy, IRolloutRelease,
} from '@evb/releaseSelection/releaseRolloutPolicy';
