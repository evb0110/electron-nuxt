import type { LiteralUnion } from 'type-fest';

export const RELEASE_PLATFORMS = [
    'macos',
    'windows',
    'linux',
    'unknown',
] as const;
export const RELEASE_ARCHES = [
    'arm64',
    'x64',
    'universal',
    'unknown',
] as const;

export type TReleasePlatform = typeof RELEASE_PLATFORMS[number];
export type TReleaseArch = typeof RELEASE_ARCHES[number];
export type TReleaseInstallerExtension = LiteralUnion<
    'appimage' | 'deb' | 'dmg' | 'exe' | 'msi' | 'pkg' | 'rpm' | 'tar.gz' | 'zip',
    string
>;

export interface IReleaseInstaller {
    id: number;
    name: string;
    downloadUrl: string;
    size: number;
    updatedAt: string;
    contentType: string;
    extension: TReleaseInstallerExtension;
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
