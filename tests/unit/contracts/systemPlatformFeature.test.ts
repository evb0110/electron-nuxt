import {
    describe,
    expect,
    it,
} from 'vitest';
import { SYSTEM_PLATFORM_FEATURE } from '@contracts/systemPlatformFeature';

describe('system platform feature schemas', () => {
    it('keeps memory information on a trusted direct sync binding', () => {
        expect(SYSTEM_PLATFORM_FEATURE.invokeChannels).toEqual({});
        expect(SYSTEM_PLATFORM_FEATURE.platformDescriptors.methods).toMatchObject([{
            kind: 'sync',
            browserLazy: 'direct',
        }]);
        expect(SYSTEM_PLATFORM_FEATURE.ipcCodecs).toEqual({});
    });
});
