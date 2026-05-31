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
