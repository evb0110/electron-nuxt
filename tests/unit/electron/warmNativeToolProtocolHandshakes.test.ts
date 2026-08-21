import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    exists: vi.fn(() => true),
    resolveNativeToolPath: vi.fn((options: {
        binaryName: string;
        crateName: string;
    }) => `/tools/${options.binaryName}`),
    verifyNativeToolProtocol: vi.fn(async () => undefined),
}));

vi.mock('node:fs', () => ({existsSync: mocks.exists}));
vi.mock('@electron/native-tools/resolveNativeToolPath', () => ({resolveNativeToolPath: mocks.resolveNativeToolPath}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({verifyNativeToolProtocol: mocks.verifyNativeToolProtocol}));

describe('native tool protocol warmup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.exists.mockReturnValue(true);
        mocks.resolveNativeToolPath.mockImplementation(options => `/tools/${options.binaryName}`);
        mocks.verifyNativeToolProtocol.mockResolvedValue(undefined);
    });

    it('warms only the interactive tools', async () => {
        const { warmNativeToolProtocolHandshakes } = await import('@electron/native-tools/warmNativeToolProtocolHandshakes');

        await warmNativeToolProtocolHandshakes();

        const warmedCrates = mocks.resolveNativeToolPath.mock.calls.map(
            ([options]) => options.crateName,
        );
        expect(warmedCrates.toSorted()).toEqual([
            'pdf-page-ops',
            'pdf-search',
        ]);
        expect(mocks.verifyNativeToolProtocol).toHaveBeenCalledTimes(2);
    });

    it('skips tools whose binary is not installed', async () => {
        mocks.exists.mockReturnValue(false);
        const { warmNativeToolProtocolHandshakes } = await import('@electron/native-tools/warmNativeToolProtocolHandshakes');

        await warmNativeToolProtocolHandshakes();

        expect(mocks.verifyNativeToolProtocol).not.toHaveBeenCalled();
    });

    it('never rejects when a handshake fails', async () => {
        mocks.verifyNativeToolProtocol.mockRejectedValue(new Error('unsupported protocol version'));
        const { warmNativeToolProtocolHandshakes } = await import('@electron/native-tools/warmNativeToolProtocolHandshakes');

        await expect(warmNativeToolProtocolHandshakes()).resolves.toBeUndefined();
    });
});
