import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    EVB_RUNTIME_IDENTITY,
    getRuntimeIdentityUrl,
    isTrustedRuntimeIdentityPayload,
} from '@contracts/runtime-identity';

describe('runtime identity helpers', () => {
    it('resolves the identity endpoint from the runtime server origin', () => {
        expect(getRuntimeIdentityUrl('http://127.0.0.1:3235/electron'))
            .toBe('http://127.0.0.1:3235/api/runtime/identity');
    });

    it('accepts only the expected runtime identity payload', () => {
        expect(isTrustedRuntimeIdentityPayload(EVB_RUNTIME_IDENTITY)).toBe(true);
        expect(isTrustedRuntimeIdentityPayload({
            ...EVB_RUNTIME_IDENTITY,
            runtime: 'other-runtime',
        })).toBe(false);
        expect(isTrustedRuntimeIdentityPayload(null)).toBe(false);
    });
});
