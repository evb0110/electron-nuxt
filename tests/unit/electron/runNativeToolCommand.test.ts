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
        const {runNativeToolCommand} = await loadModule();

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
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            3,
            '/tools/evb-pdf-page-ops',
            ['page-sizes'],
            expect.any(Object),
        );
    });

    it('runs shared protocol handshakes without caller cancellation controls', async () => {
        const {runNativeToolCommand} = await loadModule();
        const controller = new AbortController();
        const log = vi.fn();

        await runNativeToolCommand('/tools/evb-pdf-search', ['search'], {
            cancelGroup: 'search-request-1',
            cwd: '/work',
            env: {EVB_TEST: '1'},
            log,
            signal: controller.signal,
        });

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(2);
        const handshakeOptions = mocks.runNativeCommand.mock.calls[0]?.[2];
        const commandOptions = mocks.runNativeCommand.mock.calls[1]?.[2];
        expect(handshakeOptions).toMatchObject({
            cwd: '/work',
            env: {EVB_TEST: '1'},
            log,
            timeoutMs: 5_000,
        });
        expect(handshakeOptions).not.toHaveProperty('cancelGroup');
        expect(handshakeOptions).not.toHaveProperty('signal');
        expect(commandOptions).toMatchObject({
            cancelGroup: 'search-request-1',
            cwd: '/work',
            env: {EVB_TEST: '1'},
            log,
            signal: controller.signal,
        });
    });

    it('rejects unsupported Rust native tool protocols before running the real command', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '99\n',
        });
        const {runNativeToolCommand} = await loadModule();

        await expect(runNativeToolCommand('/tools/evb-pdf-search', ['search'])).rejects.toMatchObject({
            name: 'NativeToolProtocolVersionError',
            message: 'evb-pdf-search unsupported native protocol version: expected 1, got 99',
        });
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runNativeCommand).toHaveBeenCalledWith(
            '/tools/evb-pdf-search',
            ['--protocol-version'],
            expect.objectContaining({timeoutMs: 5_000}),
        );
    });

    it('retries failed native tool handshakes instead of caching them forever', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: 'bogus\n',
        });
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '3\n',
        });
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: 'ok\n',
        });
        const {runNativeToolCommand} = await loadModule();

        await expect(runNativeToolCommand('/tools/evb-pdf-image-combine', [
            '--output',
            'out.pdf',
        ])).rejects.toThrow('expected 3, got bogus');
        await expect(runNativeToolCommand('/tools/evb-pdf-image-combine', [
            '--output',
            'out.pdf',
        ])).resolves.toMatchObject({
            exitCode: 0,
            stderr: '',
            stdout: 'ok\n',
        });

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(3);
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            1,
            '/tools/evb-pdf-image-combine',
            ['--protocol-version'],
            expect.objectContaining({timeoutMs: 5_000}),
        );
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            2,
            '/tools/evb-pdf-image-combine',
            ['--protocol-version'],
            expect.objectContaining({timeoutMs: 5_000}),
        );
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            3,
            '/tools/evb-pdf-image-combine',
            [
                '--output',
                'out.pdf',
            ],
            expect.any(Object),
        );
    });

    it('does not handshake non-evb commands', async () => {
        const {runNativeToolCommand} = await loadModule();

        await runNativeToolCommand('/tools/qpdf', ['--version']);

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runNativeCommand).toHaveBeenCalledWith(
            '/tools/qpdf',
            ['--version'],
            expect.any(Object),
        );
    });
});
