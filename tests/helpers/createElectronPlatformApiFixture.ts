import { ELECTRON_PLATFORM_MANIFEST } from '@contracts/platformApi';
import {
    createPlatformApiFixture,
    type TPlatformApiFixtureOverrides,
} from '@tests/helpers/createPlatformApiFixture';

export function createElectronPlatformApiFixture(
    overrides: TPlatformApiFixtureOverrides = {},
) {
    return createPlatformApiFixture({
        backend: 'electron',
        manifest: ELECTRON_PLATFORM_MANIFEST,
        overrides,
    });
}
