import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    BROWSER_PLATFORM_MANIFEST,
    PLATFORM_CONTRACT_VERSION,
} from '@contracts/platformManifest';
import { validatePlatformApi } from '@app/platform/validatePlatformApi';
import { createPlatformApiFixture } from '@tests/helpers/createPlatformApiFixture';

function createBrowserApiFixture() {
    return createPlatformApiFixture({
        backend: 'browser',
        manifest: BROWSER_PLATFORM_MANIFEST,
    });
}

describe('validatePlatformApi', () => {
    it('accepts a manifest-backed browser platform contract', () => {
        const result = validatePlatformApi(createBrowserApiFixture(), 'browser');

        expect(result).toEqual({
            ok: true,
            failures: [],
        });
    });

    it('rejects stale preload manifests before backend use', () => {
        const api = createBrowserApiFixture();
        api.manifest = {
            ...api.manifest,
            contractVersion: PLATFORM_CONTRACT_VERSION + 1,
        } as typeof api.manifest;

        const result = validatePlatformApi(api, 'browser');

        expect(result.ok).toBe(false);
        expect(result.failures).toEqual(expect.arrayContaining([expect.objectContaining({
            code: 'unsupported-contract-version',
            path: 'manifest.contractVersion',
        })]));
    });

    it('requires structured save method when the manifest advertises structured saves', () => {
        const api = createBrowserApiFixture();
        delete (api.documentFiles as {saveFileStructured?: unknown}).saveFileStructured;

        const result = validatePlatformApi(api, 'browser');

        expect(result.ok).toBe(false);
        expect(result.failures).toEqual(expect.arrayContaining([expect.objectContaining({
            code: 'missing-required-method',
            path: 'documentFiles.saveFileStructured',
        })]));
    });
});
