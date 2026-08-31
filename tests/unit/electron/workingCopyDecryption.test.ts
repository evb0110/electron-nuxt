import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(async (_source: string, _target: string, _options?: unknown) => undefined),
    createManagedScratchTempDir: vi.fn(async (_prefix: string) => '/tmp/pdf-page-ops-test'),
    isNativePageOpsDisabled: vi.fn(() => false),
    readFile: vi.fn(async (_path: string, _encoding: string) => JSON.stringify({
        format: 'evb-pdf-decrypt',
        schemaVersion: 1,
        outcome: 'rewritten',
        wasEncrypted: true,
        revision: 6,
    })),
    resolveNativePageOpsPath: vi.fn(() => '/native/evb-pdf-page-ops'),
    rm: vi.fn(async (_path: string, _options?: unknown) => undefined),
    runNativeToolCommand: vi.fn(async (
        _command: string,
        _args: string[],
        _options?: {signal?: AbortSignal},
    ) => undefined),
    stat: vi.fn(async (_path: string) => ({size: 1})),
    writeFile: vi.fn(async (_path: string, _data: string, _options?: unknown) => undefined),
}));

vi.mock('fs/promises', () => ({
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
}));
vi.mock('@electron/utils/atomicReplace', () => ({atomicReplace: mocks.atomicReplace}));
vi.mock('@electron/utils/managedScratchTemp', () => ({createManagedScratchTempDir: mocks.createManagedScratchTempDir}));
vi.mock('@electron/features/page-ops/main/nativePageOpsPath', () => ({
    isNativePageOpsDisabled: () => mocks.isNativePageOpsDisabled(),
    resolveNativePageOpsPath: () => mocks.resolveNativePageOpsPath(),
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));

describe('working-copy PDF decryption', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readFile.mockResolvedValue(JSON.stringify({
            format: 'evb-pdf-decrypt',
            schemaVersion: 1,
            outcome: 'rewritten',
            wasEncrypted: true,
            revision: 6,
        }));
        mocks.runNativeToolCommand.mockResolvedValue(undefined);
    });

    it('writes the password outside argv and atomically publishes only valid output', async () => {
        const signal = new AbortController().signal;
        const {decryptWorkingCopyWithWriter} = await import('@electron/file-access/workingCopyDecryption');

        await expect(decryptWorkingCopyWithWriter('/tmp/working.pdf', 'correct-password', signal))
            .resolves.toEqual({
                outcome: 'decrypted',
                wasEncrypted: true,
                revision: 6,
            });

        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/pdf-page-ops-test/password.txt',
            'correct-password\n',
            {
                encoding: 'utf8',
                mode: 0o600,
            },
        );
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            [
                'decrypt',
                '--input',
                '/tmp/working.pdf',
                '--output',
                '/tmp/pdf-page-ops-test/decrypted.pdf',
                '--password-file',
                '/tmp/pdf-page-ops-test/password.txt',
            ],
            expect.objectContaining({signal}),
        );
        expect(mocks.runNativeToolCommand.mock.calls[0]?.[1]).not.toContain('correct-password');
        expect(mocks.atomicReplace).toHaveBeenCalledWith(
            '/tmp/pdf-page-ops-test/decrypted.pdf',
            '/tmp/working.pdf',
            {markMutationCommitStarted: false},
        );
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-page-ops-test', {
            recursive: true,
            force: true,
        });
    });

    it('returns needs-password without replacing the encrypted working copy', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce({
            code: 'needs-password',
            message: 'The encrypted PDF requires the correct password',
        });
        const {decryptWorkingCopyWithWriter} = await import('@electron/file-access/workingCopyDecryption');

        await expect(decryptWorkingCopyWithWriter('/tmp/working.pdf', 'wrong-password'))
            .resolves.toEqual({
                outcome: 'needs-password',
                wasEncrypted: true,
                revision: null,
            });
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-page-ops-test', {
            recursive: true,
            force: true,
        });
    });

    it('preserves a password that already ends with a line terminator', async () => {
        const {decryptWorkingCopyWithWriter} = await import('@electron/file-access/workingCopyDecryption');

        await decryptWorkingCopyWithWriter('/tmp/working.pdf', 'line-ending\r\n');

        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/pdf-page-ops-test/password.txt',
            'line-ending\r\n\n',
            {
                encoding: 'utf8',
                mode: 0o600,
            },
        );
    });

    it('maps unsupported native encryption to the typed unsupported outcome', async () => {
        mocks.runNativeToolCommand.mockRejectedValueOnce({
            code: 'unsupported-filter',
            message: 'unsupported encryption filter',
        });
        const {decryptWorkingCopyWithWriter} = await import('@electron/file-access/workingCopyDecryption');

        await expect(decryptWorkingCopyWithWriter('/tmp/working.pdf'))
            .resolves.toEqual({
                outcome: 'unsupported',
                wasEncrypted: true,
                revision: null,
            });
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
    });

    it('passes cancellation to the native process and removes scratch state', async () => {
        const controller = new AbortController();
        mocks.runNativeToolCommand.mockImplementationOnce(async (
            _command: string,
            _args: string[],
            options?: {signal?: AbortSignal},
        ) => {
            expect(options?.signal).toBe(controller.signal);
            controller.abort(new Error('open canceled'));
            throw new Error('open canceled');
        });
        const {decryptWorkingCopyWithWriter} = await import('@electron/file-access/workingCopyDecryption');

        await expect(decryptWorkingCopyWithWriter('/tmp/working.pdf', undefined, controller.signal))
            .rejects.toThrow('open canceled');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/pdf-page-ops-test', {
            recursive: true,
            force: true,
        });
    });
});
