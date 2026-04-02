import { orderBy } from 'es-toolkit/array';

export type TReleasePlatform = 'macos' | 'windows' | 'linux' | 'unknown';
export type TReleaseArch = 'arm64' | 'x64' | 'universal' | 'unknown';

export interface IReleaseInstaller {
    id: number;
    name: string;
    downloadUrl: string;
    size: number;
    updatedAt: string;
    contentType: string;
    extension: string;
    platform: TReleasePlatform;
    arch: TReleaseArch;
    isLegacy: boolean;
}

export interface IReleaseSummary {
    tag: string;
    name: string;
    publishedAt: string;
    htmlUrl: string;
}

export interface IUserAgentProfile {
    platform: TReleasePlatform;
    arch: TReleaseArch;
}

export interface ILatestReleaseResponse {
    release: IReleaseSummary;
    assets: IReleaseInstaller[];
    recommendation: {
        platform: TReleasePlatform;
        arch: TReleaseArch;
        assetId: number | null;
    };
}

const INSTALLER_EXTENSIONS = new Set([
    'appimage',
    'deb',
    'dmg',
    'exe',
    'msi',
    'pkg',
    'rpm',
    'tar.gz',
    'zip',
]);

const NON_INSTALLER_SUFFIXES = [
    '.blockmap',
    '.sha256',
    '.sha512',
    '.sig',
    '.txt',
    '.xml',
    '.yml',
    '.yaml',
];

export const INSTALLER_PLATFORM_ORDER: TReleasePlatform[] = [
    'macos',
    'windows',
    'linux',
    'unknown',
];

const PREFERRED_EXTENSION_ORDER: Record<TReleasePlatform, string[]> = {
    macos: ['dmg', 'pkg', 'zip'],
    windows: ['exe', 'msi'],
    linux: ['deb', 'appimage', 'rpm', 'tar.gz', 'zip'],
    unknown: ['dmg', 'exe', 'deb', 'appimage', 'zip'],
};

const EXTENSION_LABEL: Record<string, string> = {
    appimage: 'AppImage',
    deb: 'DEB',
    dmg: 'DMG',
    exe: 'EXE',
    msi: 'MSI',
    pkg: 'PKG',
    rpm: 'RPM',
    'tar.gz': 'TAR.GZ',
    zip: 'ZIP',
};

const INSTALLER_ARCH_ORDER: Record<TReleaseArch, number> = {
    x64: 0,
    arm64: 1,
    universal: 2,
    unknown: 3,
};

export function getAssetExtension(assetName: string): string {
    const lowerName = assetName.toLowerCase();
    if (lowerName.endsWith('.tar.gz')) {
        return 'tar.gz';
    }

    const lastDot = lowerName.lastIndexOf('.');
    if (lastDot === -1) {
        return '';
    }

    return lowerName.slice(lastDot + 1);
}

export function isInstallerAsset(assetName: string): boolean {
    const lowerName = assetName.toLowerCase();

    if (NON_INSTALLER_SUFFIXES.some(suffix => lowerName.endsWith(suffix))) {
        return false;
    }

    if (lowerName.includes('latest-mac') || lowerName.includes('latest-linux') || lowerName.includes('latest.yml')) {
        return false;
    }

    return INSTALLER_EXTENSIONS.has(getAssetExtension(assetName));
}

export function isLegacyInstallerAsset(assetName: string): boolean {
    return assetName.toLowerCase().includes('legacy');
}

export function detectPlatform(assetName: string): TReleasePlatform {
    const lowerName = assetName.toLowerCase();
    const extension = getAssetExtension(assetName);

    if (lowerName.includes('darwin') || lowerName.includes('mac') || extension === 'dmg' || extension === 'pkg') {
        return 'macos';
    }

    if (lowerName.includes('win') || extension === 'exe' || extension === 'msi') {
        return 'windows';
    }

    if (lowerName.includes('linux') || extension === 'appimage' || extension === 'deb' || extension === 'rpm' || extension === 'tar.gz') {
        return 'linux';
    }

    return 'unknown';
}

export function detectArchitecture(assetName: string): TReleaseArch {
    const lowerName = assetName.toLowerCase();

    if (/\b(universal|all)\b/.test(lowerName)) {
        return 'universal';
    }

    if (/(arm64|aarch64|armv8)/.test(lowerName)) {
        return 'arm64';
    }

    if (/(x64|x86_64|amd64|win64)/.test(lowerName)) {
        return 'x64';
    }

    return 'unknown';
}

export function parsePlatformHint(hint: string | null | undefined): TReleasePlatform {
    const normalizedHint = (hint || '').toLowerCase();

    if (normalizedHint.includes('mac') || normalizedHint.includes('darwin')) {
        return 'macos';
    }

    if (normalizedHint.includes('win')) {
        return 'windows';
    }

    if (normalizedHint.includes('linux')) {
        return 'linux';
    }

    return 'unknown';
}

export function parseArchitectureHint(hint: string | null | undefined): TReleaseArch {
    const normalizedHint = (hint || '').toLowerCase();

    if (normalizedHint.includes('arm64') || normalizedHint.includes('aarch64')) {
        return 'arm64';
    }

    if (normalizedHint.includes('x86_64') || normalizedHint.includes('x64') || normalizedHint.includes('amd64')) {
        return 'x64';
    }

    return 'unknown';
}

export function parseUserAgent(userAgent: string, platformHint = ''): IUserAgentProfile {
    const normalized = `${platformHint} ${userAgent}`.toLowerCase();

    let platform: TReleasePlatform = 'unknown';
    if (/(macintosh|mac os x|darwin)/.test(normalized)) {
        platform = 'macos';
    } else if (/(windows|win32|win64)/.test(normalized)) {
        platform = 'windows';
    } else if (/(linux|x11)/.test(normalized)) {
        platform = 'linux';
    }

    let arch: TReleaseArch = 'unknown';
    if (/(arm64|aarch64|armv8|apple silicon)/.test(normalized)) {
        arch = 'arm64';
    } else if (/(x86_64|x64|amd64|wow64|intel|win64)/.test(normalized)) {
        arch = 'x64';
    }

    return { platform, arch };
}

export function recommendInstaller(assets: IReleaseInstaller[], profile: IUserAgentProfile): IReleaseInstaller | null {
    const preferredAssets = assets.filter(asset => !asset.isLegacy);
    const candidatePool = preferredAssets.length ? preferredAssets : assets;

    if (!candidatePool.length) {
        return null;
    }

    const extensionPreference = PREFERRED_EXTENSION_ORDER[profile.platform] || PREFERRED_EXTENSION_ORDER.unknown;
    const platformFiltered = candidatePool.filter(asset => profile.platform !== 'unknown' && asset.platform === profile.platform);
    const platformScopedAssets = platformFiltered.length ? platformFiltered : candidatePool;

    const preferredScopedAssets = platformScopedAssets.filter(asset => extensionPreference.includes(asset.extension));
    const candidateAssets = preferredScopedAssets.length ? preferredScopedAssets : platformScopedAssets;

    const sorted = orderBy(candidateAssets, [
        asset => extensionRank(asset.extension, extensionPreference),
        asset => architectureRank(asset.arch, profile.arch),
        asset => knownPlatformRank(asset.platform),
    ], [
        'asc',
        'asc',
        'asc',
    ]);

    sorted.sort((left, right) => {
        const extensionDiff = extensionRank(left.extension, extensionPreference) - extensionRank(right.extension, extensionPreference);
        if (extensionDiff !== 0) {
            return 0;
        }

        const archDiff = architectureRank(left.arch, profile.arch) - architectureRank(right.arch, profile.arch);
        if (archDiff !== 0) {
            return 0;
        }

        const platformDiff = knownPlatformRank(left.platform) - knownPlatformRank(right.platform);
        if (platformDiff !== 0) {
            return 0;
        }

        return left.name.localeCompare(right.name);
    });

    return sorted[0] || null;
}

export function normalizeInstallers(assets: IReleaseInstaller[]): IReleaseInstaller[] {
    const primaryAssets = assets.filter(asset => !asset.isLegacy);
    const windowsExeArchs = new Set(
        primaryAssets
            .filter(asset => asset.platform === 'windows' && asset.extension === 'exe' && asset.arch !== 'unknown')
            .map(asset => asset.arch),
    );

    const hasArchSpecificWindowsBuilds = windowsExeArchs.has('x64') && windowsExeArchs.has('arm64');
    if (!hasArchSpecificWindowsBuilds) {
        return assets;
    }

    return assets.filter(asset => !(
        asset.platform === 'windows'
        && asset.extension === 'exe'
        && asset.arch === 'unknown'
        && !asset.isLegacy
    ));
}

function extensionRank(extension: string, preferenceOrder: string[]): number {
    const index = preferenceOrder.indexOf(extension);
    return index !== -1 ? index : preferenceOrder.length + 4;
}

function architectureRank(assetArch: TReleaseArch, profileArch: TReleaseArch): number {
    if (profileArch === 'unknown') {
        if (assetArch === 'universal') {
            return 0;
        }
        if (assetArch === 'unknown') {
            return 1;
        }
        return 2;
    }

    if (assetArch === profileArch) {
        return 0;
    }
    if (assetArch === 'universal') {
        return 1;
    }
    if (assetArch === 'unknown') {
        return 2;
    }
    return 3;
}

function knownPlatformRank(platform: TReleasePlatform): number {
    return platform === 'unknown' ? 1 : 0;
}

export function compareInstallersForSelect(left: IReleaseInstaller, right: IReleaseInstaller): number {
    const platformDiff = INSTALLER_PLATFORM_ORDER.indexOf(left.platform) - INSTALLER_PLATFORM_ORDER.indexOf(right.platform);
    if (platformDiff !== 0) {
        return platformDiff;
    }

    const archDiff = INSTALLER_ARCH_ORDER[left.arch] - INSTALLER_ARCH_ORDER[right.arch];
    if (archDiff !== 0) {
        return archDiff;
    }

    const extensionDiff = formatExtension(left.extension).localeCompare(formatExtension(right.extension));
    if (extensionDiff !== 0) {
        return extensionDiff;
    }

    return left.name.localeCompare(right.name);
}

export function selectPreferredInstallers(assets: IReleaseInstaller[], platform: TReleasePlatform): IReleaseInstaller[] {
    return assets
        .filter(asset => asset.platform === platform)
        .sort(compareInstallersForSelect);
}

export function formatExtension(extension: string): string {
    return EXTENSION_LABEL[extension] ?? extension.toUpperCase();
}

export function formatPlatform(platform: TReleasePlatform): string {
    if (platform === 'macos') {
        return 'macOS';
    }
    if (platform === 'windows') {
        return 'Windows';
    }
    if (platform === 'linux') {
        return 'Linux';
    }
    return 'Other';
}

export function formatArch(arch: TReleaseArch): string {
    if (arch === 'x64') {
        return 'x64';
    }
    if (arch === 'arm64') {
        return 'ARM64';
    }
    if (arch === 'universal') {
        return 'Universal';
    }
    return 'Unknown';
}

export function formatInstallerVariantLabel(installer: IReleaseInstaller): string {
    return `${formatPlatform(installer.platform)} ${formatArch(installer.arch)}`;
}

export function formatInstallerLabel(installer: IReleaseInstaller): string {
    return `${formatInstallerVariantLabel(installer)} (${formatExtension(installer.extension)})`;
}

export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
