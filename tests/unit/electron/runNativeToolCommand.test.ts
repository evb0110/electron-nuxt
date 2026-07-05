import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({runNativeCommand: vi.fn()}));

vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));

async function loadModule() {
    vi.resetModules();
    return import('@electron/native-tools/runNativeToolCommand');
}

describe('runNativeToolCommand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.runNativeCommand.mockResolvedValue({
            exitCode: 0,
            stderr: '',
            stdout: '1\n',
        });
    });

    it('performs a cached Rust native tool protocol handshake before use', async () => {
        const { runNativeToolCommand } = await loadModule();

        await runNativeToolCommand('/tools/evb-pdf-page-ops', ['page-sizes']);
        await runNativeToolCommand('/tools/evb-pdf-page-ops', ['page-sizes']);

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(3);
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            1,
            '/tools/evb-pdf-page-ops',
            ['--protocol-version'],
            expect.objectContaining({timeoutMs: 5_000}),
        );
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            2,
            '/tools/evb-pdf-page-ops',
            ['page-sizes'],
            expect.any(Object),
        );
    });

    it('rejects unsupported Rust native tool protocols', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '99\n',
        });
        const { runNativeToolCommand } = await loadModule();

        await expect(runNativeToolCommand('/tools/evb-pdf-search', ['search'])).rejects.toThrow('unsupported');
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);
    });
});
