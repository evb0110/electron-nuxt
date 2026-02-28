export {
    detectArchitecture,
    detectPlatform,
    compareInstallersForSelect,
    formatArch,
    formatExtension,
    formatFileSize,
    formatInstallerLabel,
    formatInstallerVariantLabel,
    formatPlatform,
    getAssetExtension,
    INSTALLER_PLATFORM_ORDER,
    isInstallerAsset,
    normalizeInstallers,
    parseArchitectureHint,
    parsePlatformHint,
    parseUserAgent,
    recommendInstaller,
    selectPreferredInstallers,
} from './release-selection';

export type {
    ILatestReleaseResponse,
    IReleaseInstaller,
    IReleaseSummary,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from '@contracts';
