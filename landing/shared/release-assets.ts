import {
    compareInstallersForSelect,
    type IReleaseInstaller,
    type TReleasePlatform,
} from '~~/shared/release-selection';

export function isLegacyInstallerAsset(assetName: string): boolean {
    return assetName.toLowerCase().includes('legacy');
}

export function selectInstallersForPlatform(
    assets: IReleaseInstaller[],
    platform: TReleasePlatform,
): IReleaseInstaller[] {
    return assets
        .filter(asset => asset.platform === platform)
        .sort(compareInstallersForSelect);
}
