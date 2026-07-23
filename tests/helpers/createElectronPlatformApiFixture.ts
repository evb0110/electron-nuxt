import { ELECTRON_PLATFORM_MANIFEST } from '@contracts/platformApi';
import {
    createPlatformApiFixture,
    type TPlatformApiFixtureOverrides,
} from '@tests/helpers/createPlatformApiFixture';

export function createElectronPlatformApiFixture<TOverrides extends TPlatformApiFixtureOverrides = TPlatformApiFixtureOverrides>(
    overrides: TOverrides = {} as TOverrides,
) {
    return createPlatformApiFixture({
        backend: 'electron',
        manifest: ELECTRON_PLATFORM_MANIFEST,
        overrides,
    });
}
