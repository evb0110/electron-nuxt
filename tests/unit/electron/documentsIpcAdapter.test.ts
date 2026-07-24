import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import type { IpcMainEvent } from 'electron';
import {
    beforeEach,
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
import { DOCUMENT_PLATFORM_FEATURES } from '@contracts/documentsPlatformFeature';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';

type TRegisteredEventHandler = (event: IpcMainEvent, ...args: unknown[]) => void;

const mocks = vi.hoisted(() => ({
    attachSerializedPdfPersistencePort: vi.fn(),
    allowOpenPath: vi.fn(),
    createDocumentsService: vi.fn(() => ({})),
    fromWebContents: vi.fn(),
    isSupportedOpenPath: vi.fn((_path: unknown) => true),
    requireOpenPath: vi.fn((..._args: unknown[]) => undefined),
    requireManagedWorkingCopyPath: vi.fn((..._args: unknown[]) => undefined),
}));

function makeUuid(index: number) {
    return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function createRegistrationHarness() {
    const handlers = new Map<string, TRegisteredHandler>();
    const eventHandlers = new Map<string, TRegisteredEventHandler>();
    const registrations: string[] = [];
    const registrar = {handle: vi.fn((channel: string, handler: TRegisteredHandler) => {
        registrations.push(channel);
        handlers.set(channel, handler);
    })};
    const eventRegistrar = {on: vi.fn((channel: string, handler: TRegisteredEventHandler) => {
        registrations.push(channel);
        eventHandlers.set(channel, handler);
    })};
    return {
        eventHandlers,
        eventRegistrar,
        handlers,
        registrar,
        registrations,
    };
}

vi.mock('@electron/features/documents/createDocumentsService', () => ({createDocumentsService: mocks.createDocumentsService}));
vi.mock('electron', () => ({
    app: {isPackaged: false},
    BrowserWindow: {fromWebContents: (...args: unknown[]) => mocks.fromWebContents(...args)},
}));
vi.mock('@electron/features/documents/public', () => ({attachSerializedPdfPersistencePort: (...args: unknown[]) => mocks.attachSerializedPdfPersistencePort(...args)}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args),
    requireOpenPath: (...args: unknown[]) => mocks.requireOpenPath(...args),
}));
vi.mock('@electron/image/pdfConversion', () => ({isSupportedOpenPath: (path: unknown) => mocks.isSupportedOpenPath(path)}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({requireManagedWorkingCopyPath: (path: unknown, owner: unknown) => mocks.requireManagedWorkingCopyPath(path, owner)}));

describe('documents ipc adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('registers every distinct documents channel value exactly once', async () => {
        const {
            eventHandlers,
            eventRegistrar,
            handlers,
            registrar,
            registrations,
        } = createRegistrationHarness();
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        registerDocumentsIpcAdapter(registrar as never, undefined, {eventRegistrar});

        const expectedChannels = [...new Set([
            ...Object.values(DOCUMENTS_CHANNELS),
            ...DOCUMENT_PLATFORM_FEATURES.flatMap(feature => [...feature.invokeChannelSet]),
        ])];
        expect(registrations).toHaveLength(expectedChannels.length);
        for (const channel of expectedChannels) {
            expect(registrations.filter(registeredChannel => registeredChannel === channel)).toHaveLength(1);
        }
        expect(handlers.has(DOCUMENTS_CHANNELS.fileSavePdfDataPort)).toBe(false);
        expect(eventHandlers.has(DOCUMENTS_CHANNELS.fileSavePdfDataPort)).toBe(true);
    });

    it('fails the documents ipc invariant for duplicate channel values', async () => {
        const { assertDocumentsIpcSingleRegistrationInvariant } = await import('@electron/features/documents/registerDocumentsIpcAdapter');
        const registeredChannels = [...new Set([
            ...Object.values(DOCUMENTS_CHANNELS),
            ...DOCUMENT_PLATFORM_FEATURES.flatMap(feature => [...feature.invokeChannelSet]),
        ])];

        expect(() => assertDocumentsIpcSingleRegistrationInvariant([
            ...registeredChannels,
            DOCUMENTS_CHANNELS.openDocumentDirect,
        ])).toThrow(/Duplicate documents IPC channel registration/u);
    });

    it('fails the documents ipc invariant for omitted channel values', async () => {
        const { assertDocumentsIpcSingleRegistrationInvariant } = await import('@electron/features/documents/registerDocumentsIpcAdapter');
        const registeredChannels = [...new Set([
            ...Object.values(DOCUMENTS_CHANNELS),
            ...DOCUMENT_PLATFORM_FEATURES.flatMap(feature => [...feature.invokeChannelSet]),
        ])]
            .filter(channel => channel !== DOCUMENTS_CHANNELS.fileSavePdfDataPort);

        expect(() => assertDocumentsIpcSingleRegistrationInvariant(registeredChannels))
            .toThrow(/Missing documents IPC channel registration/u);
    });

    it('grants renderer file-open paths to the sender webContents owner', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-documents-ipc-adapter-test-'));
        const filePath = join(tempRoot, 'opened.pdf');
        writeFileSync(filePath, new Uint8Array([1]));
        mocks.allowOpenPath.mockReturnValue(filePath);
        const {
            eventRegistrar,
            handlers,
            registrar,
        } = createRegistrationHarness();
        const sender = new EventEmitter() as EventEmitter & { id: number; };
        sender.id = 42;
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        try {
            registerDocumentsIpcAdapter(registrar as never, undefined, {eventRegistrar});

            expect(handlers.get(DOCUMENTS_CHANNELS.registerRendererFileOpenToken)?.(
                {sender},
                makeUuid(1),
            )).toBe(true);
            expect(handlers.get(DOCUMENTS_CHANNELS.allowRendererFileOpen)?.(
                {sender},
                {
                    filePath,
                    token: makeUuid(1),
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

    it('caps renderer file-open grants per sender and rejects non-UUID tokens', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-documents-ipc-adapter-batch-test-'));
        const firstFilePath = join(tempRoot, 'document-page-0001.png');
        writeFileSync(firstFilePath, new Uint8Array([1]));
        const tokenCount = 128;
        mocks.allowOpenPath.mockImplementation((filePath: string) => filePath);
        const {
            eventRegistrar,
            handlers,
            registrar,
        } = createRegistrationHarness();
        const sender = new EventEmitter() as EventEmitter & { id: number; };
        sender.id = 43;
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        try {
            registerDocumentsIpcAdapter(registrar as never, undefined, {eventRegistrar});

            expect(handlers.get(DOCUMENTS_CHANNELS.registerRendererFileOpenToken)?.(
                {sender},
                'token-0',
            )).toBe(false);

            for (let index = 0; index < tokenCount; index += 1) {
                expect(handlers.get(DOCUMENTS_CHANNELS.registerRendererFileOpenToken)?.(
                    {sender},
                    makeUuid(index),
                )).toBe(true);
            }

            expect(handlers.get(DOCUMENTS_CHANNELS.registerRendererFileOpenToken)?.(
                {sender},
                makeUuid(tokenCount),
            )).toBe(false);
            expect(handlers.get(DOCUMENTS_CHANNELS.allowRendererFileOpen)?.(
                {sender},
                {
                    filePath: firstFilePath,
                    token: makeUuid(0),
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

    it('grants renderer file-open paths in a validated sender batch', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-documents-ipc-adapter-grant-batch-test-'));
        const firstFilePath = join(tempRoot, 'first.pdf');
        const secondFilePath = join(tempRoot, 'second.pdf');
        writeFileSync(firstFilePath, new Uint8Array([1]));
        writeFileSync(secondFilePath, new Uint8Array([2]));
        mocks.allowOpenPath.mockImplementation((filePath: string) => filePath);
        const {
            eventRegistrar,
            handlers,
            registrar,
        } = createRegistrationHarness();
        const sender = new EventEmitter() as EventEmitter & { id: number; };
        sender.id = 46;
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        try {
            registerDocumentsIpcAdapter(registrar as never, undefined, {eventRegistrar});

            expect(handlers.get(DOCUMENTS_CHANNELS.registerRendererFileOpenTokens)?.(
                {sender},
                [
                    makeUuid(60),
                    makeUuid(61),
                ],
            )).toBe(true);
            expect(handlers.get(DOCUMENTS_CHANNELS.allowRendererFileOpenBatch)?.(
                {sender},
                [
                    {
                        filePath: firstFilePath,
                        token: makeUuid(60),
                    },
                    {
                        filePath: secondFilePath,
                        token: makeUuid(61),
                    },
                ],
            )).toBe(true);

            expect(mocks.allowOpenPath).toHaveBeenCalledWith(firstFilePath, sender);
            expect(mocks.allowOpenPath).toHaveBeenCalledWith(secondFilePath, sender);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('drops renderer file-open tokens on sender main-frame navigation', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-documents-ipc-adapter-navigation-test-'));
        const filePath = join(tempRoot, 'opened-after-navigation.pdf');
        writeFileSync(filePath, new Uint8Array([1]));
        mocks.allowOpenPath.mockReturnValue(filePath);
        const {
            eventRegistrar,
            handlers,
            registrar,
        } = createRegistrationHarness();
        const sender = new EventEmitter() as EventEmitter & { id: number; };
        sender.id = 44;
        const removeListenerSpy = vi.spyOn(sender, 'removeListener');
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        try {
            registerDocumentsIpcAdapter(registrar as never, undefined, {eventRegistrar});

            expect(handlers.get(DOCUMENTS_CHANNELS.registerRendererFileOpenToken)?.(
                {sender},
                makeUuid(50),
            )).toBe(true);

            sender.emit('did-start-navigation', {}, 'https://example.test/', false, true);

            expect(handlers.get(DOCUMENTS_CHANNELS.allowRendererFileOpen)?.(
                {sender},
                {
                    filePath,
                    token: makeUuid(50),
                },
            )).toBe(false);
            expect(mocks.allowOpenPath).not.toHaveBeenCalled();
            expect(removeListenerSpy).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
