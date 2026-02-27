export {
    detectArchitecture,
    detectPlatform,
    formatArch,
    formatExtension,
    formatFileSize,
    formatInstallerLabel,
    formatPlatform,
    getAssetExtension,
    isInstallerAsset,
    normalizeInstallers,
    parseArchitectureHint,
    parsePlatformHint,
    parseUserAgent,
    recommendInstaller,
} from './release-selection';

export type {
    ILatestReleaseResponse,
    IReleaseInstaller,
    IReleaseSummary,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from '@contracts';
