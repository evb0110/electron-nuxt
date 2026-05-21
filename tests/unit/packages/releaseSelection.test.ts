import {
    describe,
    expect,
    it,
} from 'vitest';
import type { IReleaseInstaller } from '@contracts';
import {
    isLegacyInstallerAsset,
    parseArchitectureHint,
    recommendInstaller,
} from '@releaseSelection';

function createInstaller(partial: Partial<IReleaseInstaller> & Pick<IReleaseInstaller, 'id' | 'name' | 'extension' | 'arch'>): IReleaseInstaller {
    return {
        contentType: 'application/octet-stream',
        downloadUrl: `https://example.test/${partial.name}`,
        isLegacy: false,
        platform: 'macos',
        size: 1,
        updatedAt: '2026-01-01T00:00:00Z',
        ...partial,
    };
}

describe('release selection', () => {
    it('classifies legacy installers by filename', () => {
        expect(isLegacyInstallerAsset('EVB-Viewer-win7-legacy-x64.exe')).toBe(true);
        expect(isLegacyInstallerAsset('EVB-Viewer-win-x64.exe')).toBe(false);
    });

    it('normalizes Chromium UA-CH architecture hints', () => {
        expect(parseArchitectureHint('arm')).toBe('arm64');
        expect(parseArchitectureHint('x86')).toBe('x64');
        expect(parseArchitectureHint('arm64')).toBe('arm64');
        expect(parseArchitectureHint('x86_64')).toBe('x64');
    });

    it('prefers mac x64 compatible installers before extension rank', () => {
        const recommended = recommendInstaller([
            createInstaller({
                arch: 'arm64',
                extension: 'dmg',
                id: 1,
                name: 'EVB-Viewer-mac-arm64.dmg',
            }),
            createInstaller({
                arch: 'x64',
                extension: 'zip',
                id: 2,
                name: 'EVB-Viewer-mac-x64.zip',
            }),
            createInstaller({
                arch: 'universal',
                extension: 'pkg',
                id: 3,
                name: 'EVB-Viewer-mac-universal.pkg',
            }),
        ], {
            arch: 'x64',
            platform: 'macos',
        });

        expect(recommended?.name).toBe('EVB-Viewer-mac-x64.zip');
    });
});
