import { EventEmitter } from 'node:events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    mkdtemp: vi.fn(),
    readFile: vi.fn(),
    rm: vi.fn(),
    resolveExistingReadablePdfPath: vi.fn(),
    buildPopplerEnv: vi.fn(),
    getPdfNativeToolPaths: vi.fn(),
    runNativeToolCommand: vi.fn(),
    cancelNativeCommandGroup: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    mkdtemp: (...args: unknown[]) => mocks.mkdtemp(...args),
    readFile: (...args: unknown[]) => mocks.readFile(...args),
    rm: (...args: unknown[]) => mocks.rm(...args),
}));
vi.mock('@electron/features/documents/main/documentFilePathResolution', () => ({resolveExistingReadablePdfPath: (...args: unknown[]) => mocks.resolveExistingReadablePdfPath(...args)}));
vi.mock('@electron/native-tools/buildPopplerEnv', () => ({buildPopplerEnv: (...args: unknown[]) => mocks.buildPopplerEnv(...args)}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: (...args: unknown[]) => mocks.getPdfNativeToolPaths(...args)}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({cancelNativeCommandGroup: (...args: unknown[]) => mocks.cancelNativeCommandGroup(...args)}));

class FakeSender extends EventEmitter {
    destroyed = false;
    readonly id = 42;

    isDestroyed() {
        return this.destroyed;
    }
}

function createPngBytes(width: number, height: number) {
    const bytes = Buffer.alloc(24);
    bytes.set([
        0x89,
        0x50,
        0x4e,
        0x47,
    ], 0);
    bytes.set([
        0x49,
        0x48,
        0x44,
        0x52,
    ], 12);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}

describe('native PDF preview lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.mkdtemp.mockResolvedValue('/tmp/native-preview');
        mocks.readFile.mockResolvedValue(createPngBytes(640, 480));
        mocks.rm.mockResolvedValue(undefined);
        mocks.resolveExistingReadablePdfPath.mockResolvedValue('/tmp/input.pdf');
        mocks.buildPopplerEnv.mockReturnValue({POPPLER: '1'});
        mocks.getPdfNativeToolPaths.mockReturnValue({
            pdfinfo: '/mock/pdfinfo',
            pdftoppm: '/mock/pdftoppm',
        });
        mocks.runNativeToolCommand.mockResolvedValue({
            exitCode: 0,
            stdout: '',
            stderr: '',
        });
    });

    afterEach(async () => {
        const { resetMainOperationLifecycleForTests } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        resetMainOperationLifecycleForTests();
    });

    it('aborts the pdftoppm command when the requesting renderer is destroyed', async () => {
        const sender = new FakeSender();
        const capturedOptions: Array<{
            signal?: AbortSignal;
            cancelGroup?: string;
        }> = [];
        mocks.runNativeToolCommand.mockImplementationOnce((_command: string, _args: string[], options: {
            signal?: AbortSignal;
            cancelGroup?: string;
        }) => {
            capturedOptions.push(options);
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason);
                }, {once: true});
            });
        });
        const { handlePdfNativePagePreview } = await import('@electron/features/documents/main/nativePdfPreview');
        const { snapshotMainOperations } = await import('@electron/operation-lifecycle/mainOperationLifecycle');

        const previewPromise = handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1);
        await vi.waitFor(() => {
            expect(capturedOptions).toHaveLength(1);
        });
        const [options] = capturedOptions;
        if (!options) {
            throw new Error('Expected pdftoppm options to be captured.');
        }

        expect(snapshotMainOperations()).toEqual([expect.objectContaining({
            kind: 'abortable-work',
            ownerWebContentsId: sender.id,
            workingCopyPath: '/tmp/input.pdf',
        })]);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.cancelGroup).toMatch(/^pdf-native-preview:/u);

        sender.destroyed = true;
        sender.emit('destroyed');

        await expect(previewPromise).rejects.toThrow('Renderer lifecycle ended');
        expect(options.signal?.aborted).toBe(true);
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledWith(expect.stringMatching(/^pdf-native-preview:/u));
        expect(snapshotMainOperations()).toEqual([]);
    });

    it('aborts native page-size discovery when the requesting renderer is destroyed', async () => {
        const sender = new FakeSender();
        const capturedOptions: Array<{
            signal?: AbortSignal;
            cancelGroup?: string;
        }> = [];
        mocks.runNativeToolCommand.mockImplementationOnce((_command: string, _args: string[], options: {
            signal?: AbortSignal;
            cancelGroup?: string;
        }) => {
            capturedOptions.push(options);
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason);
                }, {once: true});
            });
        });
        const { handlePdfNativePageSizes } = await import('@electron/features/documents/main/nativePdfPreview');
        const { snapshotMainOperations } = await import('@electron/operation-lifecycle/mainOperationLifecycle');

        const pageSizesPromise = handlePdfNativePageSizes({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf');
        await vi.waitFor(() => {
            expect(capturedOptions).toHaveLength(1);
        });
        const [options] = capturedOptions;
        if (!options) {
            throw new Error('Expected pdfinfo options to be captured.');
        }

        expect(snapshotMainOperations()).toEqual([expect.objectContaining({
            kind: 'abortable-work',
            ownerWebContentsId: sender.id,
            workingCopyPath: '/tmp/input.pdf',
        })]);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.cancelGroup).toMatch(/^pdf-native-page-sizes:/u);

        sender.destroyed = true;
        sender.emit('destroyed');

        await expect(pageSizesPromise).rejects.toThrow('Renderer lifecycle ended');
        expect(options.signal?.aborted).toBe(true);
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledWith(expect.stringMatching(/^pdf-native-page-sizes:/u));
        expect(snapshotMainOperations()).toEqual([]);
    });

    it('uses one abort scope for both native page-size discovery commands', async () => {
        const sender = new FakeSender();
        const capturedOptions: Array<{
            signal?: AbortSignal;
            cancelGroup?: string;
        }> = [];
        mocks.runNativeToolCommand
            .mockImplementationOnce((_command: string, _args: string[], options: {
                signal?: AbortSignal;
                cancelGroup?: string;
            }) => {
                capturedOptions.push(options);
                return Promise.resolve({
                    exitCode: 0,
                    stderr: '',
                    stdout: 'Pages: 2\nPage size: 612 x 792 pts\n',
                });
            })
            .mockImplementationOnce((_command: string, _args: string[], options: {
                signal?: AbortSignal;
                cancelGroup?: string;
            }) => {
                capturedOptions.push(options);
                return Promise.resolve({
                    exitCode: 0,
                    stderr: '',
                    stdout: [
                        'Pages: 2',
                        'Page 1 size: 612 x 792 pts',
                        'Page 2 size: 300 x 400 pts',
                        '',
                    ].join('\n'),
                });
            });
        const { handlePdfNativePageSizes } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfNativePageSizes({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf')).resolves.toEqual([
            {
                width: 612,
                height: 792,
            },
            {
                width: 300,
                height: 400,
            },
        ]);

        expect(capturedOptions).toHaveLength(2);
        expect(capturedOptions[0]?.signal).toBeInstanceOf(AbortSignal);
        expect(capturedOptions[1]?.signal).toBe(capturedOptions[0]?.signal);
        expect(capturedOptions[0]?.cancelGroup).toMatch(/^pdf-native-page-sizes:/u);
        expect(capturedOptions[1]?.cancelGroup).toBe(capturedOptions[0]?.cancelGroup);
        expect(mocks.runNativeToolCommand).toHaveBeenNthCalledWith(
            2,
            '/mock/pdfinfo',
            [
                '-box',
                '-f',
                '1',
                '-l',
                '2',
                '/tmp/input.pdf',
            ],
            expect.objectContaining({
                commandLabel: 'pdfinfo',
                env: {POPPLER: '1'},
                rejectOnStdoutTruncation: true,
            }),
        );
    });

    it('cancels an in-flight native preview by request id', async () => {
        const sender = new FakeSender();
        const capturedOptions: Array<{
            signal?: AbortSignal;
            cancelGroup?: string;
        }> = [];
        mocks.runNativeToolCommand.mockImplementationOnce((_command: string, _args: string[], options: {
            signal?: AbortSignal;
            cancelGroup?: string;
        }) => {
            capturedOptions.push(options);
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason);
                }, {once: true});
            });
        });
        const {
            handleCancelPdfNativePagePreview,
            handlePdfNativePagePreview,
        } = await import('@electron/features/documents/main/nativePdfPreview');

        const previewPromise = handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1, {previewRequestId: 'preview-1'});
        await vi.waitFor(() => {
            expect(capturedOptions).toHaveLength(1);
        });

        await expect(handleCancelPdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, 'preview-1')).resolves.toEqual({canceled: true});
        await expect(previewPromise).rejects.toThrow('Native PDF preview canceled');
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalledWith(expect.stringMatching(/^pdf-native-preview:/u));
    });

    it('caps requested native preview width at a high-DPI friendly limit', async () => {
        const sender = new FakeSender();
        const { handlePdfNativePagePreview } = await import('@electron/features/documents/main/nativePdfPreview');

        await expect(handlePdfNativePagePreview({
            sender: sender as never,
            senderId: sender.id,
        }, '/tmp/input.pdf', 1, {targetWidthPx: 8_000})).resolves.toMatchObject({
            width: 640,
            height: 480,
        });

        const args = mocks.runNativeToolCommand.mock.calls[0]?.[1] as string[] | undefined;
        expect(args).toBeDefined();
        const scaleToXIndex = args?.indexOf('-scale-to-x') ?? -1;
        expect(scaleToXIndex).toBeGreaterThanOrEqual(0);
        expect(args?.[scaleToXIndex + 1]).toBe('4096');
    });
});
