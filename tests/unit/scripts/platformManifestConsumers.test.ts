import {
    describe,
    expect,
    it,
} from 'vitest';
import { PLATFORM_API_DESCRIPTOR } from '@contracts/platformApiDescriptor';
import { platformMethodManifest } from '@contracts/platformMethodManifest';

describe('platform manifest consumer boundary', () => {
    it('uses the canonical platform descriptor method inventory without a second list', () => {
        expect(platformMethodManifest).toBe(PLATFORM_API_DESCRIPTOR.methods);
        expect(platformMethodManifest.map(descriptor => descriptor.path.join('.'))).toEqual(
            PLATFORM_API_DESCRIPTOR.methods.map(descriptor => descriptor.path.join('.')),
        );
    });
});
