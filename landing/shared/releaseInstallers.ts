export {
    INSTALLER_PLATFORM_ORDER,
    compareInstallersForSelect,
    detectArchitecture,
    detectPlatform,
    formatArch,
    formatExtension,
    formatFileSize,
    formatInstallerLabel,
    formatInstallerVariantLabel,
    formatPlatform,
    getAssetExtension,
    isInstallerAsset,
    normalizeInstallers,
    parseArchitectureHint,
    parsePlatformHint,
    parseUserAgent,
    recommendInstaller,
    selectPreferredInstallers,
} from '@releaseSelection';

export type {
    ILatestReleaseResponse,
    IReleaseInstaller,
    IReleaseSummary,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from '@releaseSelection';
