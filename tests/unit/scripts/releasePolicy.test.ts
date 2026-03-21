import {
    describe,
    expect,
    it,
} from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const {
    detectHostReleasePlatform,
    expectsUpdaterMetadata,
    getLocalReleaseTargets,
    getReleaseAutomationEnv,
    getRequiredArtifactPatterns,
    shouldVerifyPackagedStartup,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/policy.mjs')).href);

describe('release policy', () => {
    it('derives local release targets from host platform and arch', () => {
        expect(getLocalReleaseTargets({
            arch: 'arm64',
            platform: 'darwin',
        })).toEqual([
            {
                arch: 'arm64',
                expectsUpdaterMetadata: true,
                isPrimaryHostTarget: true,
                platform: 'mac',
            },
            {
                arch: 'x64',
                expectsUpdaterMetadata: false,
                isPrimaryHostTarget: false,
                platform: 'mac',
            },
        ]);

        expect(getLocalReleaseTargets({
            arch: 'x64',
            platform: 'win32',
        })).toEqual([{
            arch: 'x64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'win',
        }]);
    });

    it('keeps updater metadata and startup verification aligned with signing state', () => {
        const macTarget = {
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'mac',
        };
        const unsignedEnv = {};
        const signedEnv = {
            CSC_KEY_PASSWORD: 'secret',
            CSC_LINK: 'base64://cert',
        };

        expect(expectsUpdaterMetadata(macTarget, unsignedEnv)).toBe(false);
        expect(expectsUpdaterMetadata(macTarget, signedEnv)).toBe(true);
        expect(shouldVerifyPackagedStartup(macTarget, unsignedEnv)).toBe(false);
        expect(shouldVerifyPackagedStartup(macTarget, signedEnv)).toBe(true);
    });

    it('provides a release automation env that stays in CI mode', () => {
        expect(getReleaseAutomationEnv({ FOO: 'bar' })).toEqual({
            CI: 'true',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            FOO: 'bar',
        });
    });

    it('reports supported host platforms and required packaged artifacts', () => {
        expect(detectHostReleasePlatform('darwin')).toBe('mac');
        expect(detectHostReleasePlatform('linux')).toBe('linux');
        expect(detectHostReleasePlatform('win32')).toBe('win');
        expect(() => detectHostReleasePlatform('freebsd')).toThrow(
            'Unsupported local release platform "freebsd"',
        );

        expect(getRequiredArtifactPatterns({
            arch: 'arm64',
            platform: 'mac',
        }).map((pattern: RegExp) => pattern.source)).toEqual([
            '\\.dmg$',
            '\\.zip$',
        ]);
    });
});
