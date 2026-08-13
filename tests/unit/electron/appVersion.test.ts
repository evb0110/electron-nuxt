import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

async function importAppVersion(buildGitSha: string | undefined) {
    vi.stubEnv('EVB_BUILD_GIT_SHA', buildGitSha);
    vi.resetModules();
    return import('@electron/appVersion');
}

describe('application version truth', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('uses signed bundle metadata in packaged builds', async () => {
        const {resolveApplicationVersion} = await importAppVersion(undefined);

        expect(resolveApplicationVersion({
            isPackaged: true,
            getVersion: () => '0.1.999',
        })).toBe('0.1.999');
    });

    it('uses the bare repository version when the build commit is absent', async () => {
        const {
            canonicalBundledApplicationVersion,
            developmentApplicationVersion,
            resolveApplicationVersion,
        } = await importAppVersion(undefined);

        expect(canonicalBundledApplicationVersion).toMatch(/^0\.1\.\d+$/u);
        expect(developmentApplicationVersion).toBe(canonicalBundledApplicationVersion);
        expect(resolveApplicationVersion({
            isPackaged: false,
            getVersion: () => '42.3.3',
        })).toBe(canonicalBundledApplicationVersion);
    });

    it('exposes the build commit in generic Electron development runs', async () => {
        const gitSha = 'a'.repeat(40);
        const {
            canonicalBundledApplicationVersion,
            developmentApplicationVersion,
            formatDevelopmentApplicationVersion,
            resolveApplicationVersion,
        } = await importAppVersion(gitSha);
        const expectedVersion = `${canonicalBundledApplicationVersion}+${gitSha}`;

        expect(formatDevelopmentApplicationVersion(gitSha)).toBe(expectedVersion);
        expect(developmentApplicationVersion).toBe(expectedVersion);
        expect(resolveApplicationVersion({
            isPackaged: false,
            getVersion: () => '42.3.3',
        })).toBe(expectedVersion);
    });
});
