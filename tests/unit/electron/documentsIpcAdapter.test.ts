import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'node:events';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';


const mocks = vi.hoisted(() => ({
    allowOpenPath: vi.fn(),
    createDocumentsService: vi.fn(() => ({})),
    isSupportedOpenPath: vi.fn((_path: unknown) => true),
    requireOpenPath: vi.fn((..._args: unknown[]) => undefined),
    requireManagedWorkingCopyPath: vi.fn((..._args: unknown[]) => undefined),
}));

vi.mock('@electron/features/documents/createDocumentsService', () => ({createDocumentsService: mocks.createDocumentsService}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args),
    requireOpenPath: (...args: unknown[]) => mocks.requireOpenPath(...args),
}));
vi.mock('@electron/image/pdfConversion', () => ({isSupportedOpenPath: (path: unknown) => mocks.isSupportedOpenPath(path)}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({requireManagedWorkingCopyPath: (path: unknown, owner: unknown) => mocks.requireManagedWorkingCopyPath(path, owner)}));

describe('documents ipc adapter', () => {
    it('grants renderer file-open paths to the sender webContents owner', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-documents-ipc-adapter-test-'));
        const filePath = join(tempRoot, 'opened.pdf');
        writeFileSync(filePath, new Uint8Array([1]));
        mocks.allowOpenPath.mockReturnValue(filePath);
        const handlers = new Map<string, TRegisteredHandler>();
        const sender = new EventEmitter() as EventEmitter & { id: number; };
        sender.id = 42;
        const registrar = {handle: vi.fn((channel: string, handler: TRegisteredHandler) => {
            handlers.set(channel, handler);
        })};
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        try {
            registerDocumentsIpcAdapter(registrar as never);

            expect(handlers.get(DOCUMENTS_CHANNELS.registerRendererFileOpenToken)?.(
                {sender},
                'token-1',
            )).toBe(true);
            expect(handlers.get(DOCUMENTS_CHANNELS.allowRendererFileOpen)?.(
                {sender},
                {
                    filePath,
                    token: 'token-1',
                },
            )).toBe(true);

            expect(mocks.allowOpenPath).toHaveBeenCalledWith(filePath, sender);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('keeps renderer file-open grants for thousands-page combine batches', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-documents-ipc-adapter-batch-test-'));
        const firstFilePath = join(tempRoot, 'document-page-0001.png');
        writeFileSync(firstFilePath, new Uint8Array([1]));
        const tokenCount = 3_000;
        mocks.allowOpenPath.mockImplementation((filePath: string) => filePath);
        const handlers = new Map<string, TRegisteredHandler>();
        const sender = new EventEmitter() as EventEmitter & { id: number; };
        sender.id = 43;
        const registrar = {handle: vi.fn((channel: string, handler: TRegisteredHandler) => {
            handlers.set(channel, handler);
        })};
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        try {
            registerDocumentsIpcAdapter(registrar as never);

            for (let index = 0; index < tokenCount; index += 1) {
                expect(handlers.get(DOCUMENTS_CHANNELS.registerRendererFileOpenToken)?.(
                    {sender},
                    `token-${index}`,
                )).toBe(true);
            }

            expect(handlers.get(DOCUMENTS_CHANNELS.allowRendererFileOpen)?.(
                {sender},
                {
                    filePath: firstFilePath,
                    token: 'token-0',
                },
            )).toBe(true);

            expect(mocks.allowOpenPath).toHaveBeenCalledWith(firstFilePath, sender);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
