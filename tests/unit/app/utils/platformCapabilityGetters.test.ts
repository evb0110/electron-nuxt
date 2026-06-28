import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const platformApiMock = vi.hoisted(() => ({
    agent: {source: 'agent'},
    host: {source: 'host'},
    system: {source: 'system'},
}));

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => platformApiMock }));

const { getAgentCapability } = await import('@app/utils/getAgentCapability');
const { getHostCapability } = await import('@app/utils/getHostCapability');
const { getSystemCapability } = await import('@app/utils/getSystemCapability');

describe('platform capability getters', () => {
    it('returns the required platform agent capability directly', () => {
        expect(getAgentCapability()).toBe(platformApiMock.agent);
    });

    it('returns the required platform host capability directly', () => {
        expect(getHostCapability()).toBe(platformApiMock.host);
    });

    it('returns the required platform system capability directly', () => {
        expect(getSystemCapability()).toBe(platformApiMock.system);
    });

    it('falls back to unavailable system memory info when a narrow platform mock omits system', () => {
        const originalSystem = platformApiMock.system;
        try {
            (platformApiMock as { system?: unknown }).system = undefined;

            expect(getSystemCapability().getMemoryInfo()).toBeNull();
        } finally {
            platformApiMock.system = originalSystem;
        }
    });
});
