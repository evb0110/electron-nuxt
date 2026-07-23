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
import {
    DOCUMENT_MENU_PLATFORM_FEATURE,
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_PLATFORM_FEATURES,
} from '@contracts/documentsPlatformFeature';
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

    it('keeps documents ipc aliases explicit while counting shared channel values once', async () => {
        const { DOCUMENTS_IPC_CHANNEL_ALIASES } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        expect(DOCUMENTS_IPC_CHANNEL_ALIASES).toEqual([
            {
                aliasKey: 'openPdfDirect',
                ownerKey: 'openDocumentDirect',
            },
            {
                aliasKey: 'openPdfDirectBatch',
                ownerKey: 'openDocumentDirectBatch',
            },
        ]);
        for (const {
            aliasKey,
            ownerKey,
        } of DOCUMENTS_IPC_CHANNEL_ALIASES) {
            expect(DOCUMENTS_CHANNELS[aliasKey]).toBe(DOCUMENTS_CHANNELS[ownerKey]);
        }
        expect(DOCUMENT_PICKER_PLATFORM_FEATURE.methods.openPdfDialog.aliasOf)
            .toBe('openDocumentDialog');
    });

    it('attaches serialized pdf persistence ports from the documents raw event channel', async () => {
        const {
            eventHandlers,
            eventRegistrar,
            registrar,
        } = createRegistrationHarness();
        const event = {sender: {id: 47}} as IpcMainEvent;
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        registerDocumentsIpcAdapter(registrar as never, undefined, {eventRegistrar});
        eventHandlers.get(DOCUMENTS_CHANNELS.fileSavePdfDataPort)?.(event, 'session-1');

        expect(mocks.attachSerializedPdfPersistencePort).toHaveBeenCalledWith(event, 'session-1');
    });

    it('translates invoke events to open/menu/recent service contexts at the adapter edge', async () => {
        const {
            eventRegistrar,
            handlers,
            registrar,
        } = createRegistrationHarness();
        const window = {id: 7};
        const sender = {id: 48};
        const service = {
            getRecentFiles: vi.fn(async () => []),
            openDocumentDirect: vi.fn(async () => null),
            setMenuTabCount: vi.fn(),
        };
        mocks.fromWebContents.mockReturnValue(window);
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        registerDocumentsIpcAdapter(registrar as never, service as never, {eventRegistrar});
        await handlers.get(DOCUMENTS_CHANNELS.openDocumentDirect)?.({sender}, '/tmp/open.pdf');
        await handlers.get(DOCUMENT_RECENT_FILES_PLATFORM_FEATURE.invokeChannels.get)?.({sender});
        handlers.get(DOCUMENT_MENU_PLATFORM_FEATURE.invokeChannels.setMenuTabCount)?.({sender}, 3);

        expect(service.openDocumentDirect).toHaveBeenCalledWith({
            sender,
            senderId: 48,
        }, '/tmp/open.pdf');
        expect(service.getRecentFiles).toHaveBeenCalledWith({
            sender,
            senderId: 48,
        });
        expect(service.setMenuTabCount).toHaveBeenCalledWith({
            senderId: 48,
            window,
        }, 3);
        expect(mocks.fromWebContents).toHaveBeenCalledWith(sender);
    });

    it('registers native PDF preview handlers and delegates them with sender-id context', async () => {
        const {
            eventRegistrar,
            handlers,
            registrar,
        } = createRegistrationHarness();
        const sender = {id: 49};
        const service = {
            getPdfOpeningGeometry: vi.fn(async () => ({
                pageNumber: 1 as const,
                pageCount: 431,
                width: 612,
                height: 792,
                rotation: 0 as const,
                size: 28_000_000,
                modifiedAt: 1_720_000_000_000,
            })),
            getPdfNativePageSizes: vi.fn(async () => [{
                width: 612,
                height: 792,
            }]),
            cancelPdfNativePagePreview: vi.fn(async () => ({canceled: true})),
            renderPdfNativePagePreview: vi.fn(async () => ({
                bytes: new Uint8Array([1]),
                width: 900,
                height: 1200,
            })),
        };
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        registerDocumentsIpcAdapter(registrar as never, service as never, {eventRegistrar});
        await expect(handlers.get(DOCUMENTS_CHANNELS.pdfOpeningGeometry)?.({sender}, '/tmp/huge.pdf'))
            .resolves
            .toMatchObject({
                pageNumber: 1,
                pageCount: 431,
            });
        await expect(handlers.get(DOCUMENTS_CHANNELS.pdfNativePageSizes)?.({sender}, '/tmp/huge.pdf'))
            .resolves
            .toEqual([{
                width: 612,
                height: 792,
            }]);
        await expect(handlers.get(DOCUMENTS_CHANNELS.pdfNativePagePreviewCancel)?.(
            {sender},
            'preview-1',
        )).resolves.toEqual({canceled: true});
        await expect(handlers.get(DOCUMENTS_CHANNELS.pdfNativePagePreview)?.(
            {sender},
            '/tmp/huge.pdf',
            7,
            {
                targetWidthPx: 900,
                previewRequestId: 'preview-2',
            },
        )).resolves.toMatchObject({
            width: 900,
            height: 1200,
        });

        expect(service.getPdfOpeningGeometry).toHaveBeenCalledWith({
            sender,
            senderId: 49,
        }, '/tmp/huge.pdf');
        expect(service.getPdfNativePageSizes).toHaveBeenCalledWith({
            sender,
            senderId: 49,
        }, '/tmp/huge.pdf');
        expect(service.cancelPdfNativePagePreview).toHaveBeenCalledWith({
            sender,
            senderId: 49,
        }, 'preview-1');
        expect(service.renderPdfNativePagePreview).toHaveBeenCalledWith(
            {
                sender,
                senderId: 49,
            },
            '/tmp/huge.pdf',
            7,
            {
                targetWidthPx: 900,
                previewRequestId: 'preview-2',
            },
        );
    });

    it('delegates PDF path handoff handlers with sender-owned contexts', async () => {
        const {
            eventRegistrar,
            handlers,
            registrar,
        } = createRegistrationHarness();
        const window = {id: 12};
        const sender = {id: 50};
        const service = {
            openPdfInDefaultAppPath: vi.fn(async () => ({success: true})),
            printPdfPath: vi.fn(async () => ({success: true})),
        };
        mocks.fromWebContents.mockReturnValue(window);
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        registerDocumentsIpcAdapter(registrar as never, service as never, {eventRegistrar});
        await handlers.get(DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath)?.({sender}, '/tmp/owned.pdf', 'owned.pdf');
        await handlers.get(DOCUMENTS_CHANNELS.pdfPrintPath)?.({sender}, '/tmp/owned.pdf', 'owned.pdf', [1]);

        expect(service.openPdfInDefaultAppPath).toHaveBeenCalledWith({
            sender,
            senderId: 50,
        }, '/tmp/owned.pdf', 'owned.pdf');
        expect(service.printPdfPath).toHaveBeenCalledWith({
            senderId: 50,
            window,
        }, '/tmp/owned.pdf', 'owned.pdf', [1]);
    });

    it('forwards expected revision options for working-copy mutation channels', async () => {
        const {
            eventRegistrar,
            handlers,
            registrar,
        } = createRegistrationHarness();
        const sender = {id: 51};
        const expectedOptions = {expectedDocumentRevisionToken: 'drt1:test:renderer-base'};
        const service = {
            applyPdfNativeMutationsToWorkingCopy: vi.fn(async () => ({success: true})),
            replaceWorkingCopyFromPath: vi.fn(async () => true),
            savePdfNativeMutations: vi.fn(async () => ({success: true})),
            savePdfNoteChanges: vi.fn(async () => ({success: true})),
            savePdfNoteTextUpdates: vi.fn(async () => ({success: true})),
            writeFile: vi.fn(async () => true),
        };
        const { registerDocumentsIpcAdapter } = await import('@electron/features/documents/registerDocumentsIpcAdapter');

        registerDocumentsIpcAdapter(registrar as never, service as never, {eventRegistrar});

        await handlers.get(DOCUMENTS_CHANNELS.fileWrite)?.(
            {sender},
            '/tmp/work.pdf',
            new Uint8Array([1]),
            expectedOptions,
        );
        await handlers.get(DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath)?.(
            {sender},
            '/tmp/work.pdf',
            '/tmp/ocr-output.pdf',
            expectedOptions,
        );
        await handlers.get(DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates)?.(
            {sender},
            '/tmp/work.pdf',
            [],
            '2026-07-04T00:00:00.000Z',
            expectedOptions,
        );
        await handlers.get(DOCUMENTS_CHANNELS.fileSavePdfNoteChanges)?.(
            {sender},
            '/tmp/work.pdf',
            [],
            '2026-07-04T00:00:00.000Z',
            expectedOptions,
        );
        await handlers.get(DOCUMENTS_CHANNELS.fileSavePdfNativeMutations)?.(
            {sender},
            '/tmp/work.pdf',
            [],
            '2026-07-04T00:00:00.000Z',
            expectedOptions,
        );
        await handlers.get(DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy)?.(
            {sender},
            '/tmp/work.pdf',
            [],
            '2026-07-04T00:00:00.000Z',
            {
                size: 11,
                mtimeMs: 22,
                contentFingerprint: 'base-fingerprint',
            },
            expectedOptions,
        );

        expect(service.writeFile).toHaveBeenCalledWith(
            {
                sender,
                senderId: 51,
            },
            '/tmp/work.pdf',
            new Uint8Array([1]),
            expectedOptions,
        );
        expect(service.replaceWorkingCopyFromPath).toHaveBeenCalledWith(
            {
                sender,
                senderId: 51,
            },
            '/tmp/work.pdf',
            '/tmp/ocr-output.pdf',
            expectedOptions,
        );
        expect(service.savePdfNoteTextUpdates).toHaveBeenCalledWith(
            {
                sender,
                senderId: 51,
            },
            '/tmp/work.pdf',
            [],
            '2026-07-04T00:00:00.000Z',
            expectedOptions,
        );
        expect(service.savePdfNoteChanges).toHaveBeenCalledWith(
            {
                sender,
                senderId: 51,
            },
            '/tmp/work.pdf',
            [],
            '2026-07-04T00:00:00.000Z',
            expectedOptions,
        );
        expect(service.savePdfNativeMutations).toHaveBeenCalledWith(
            {
                sender,
                senderId: 51,
            },
            '/tmp/work.pdf',
            [],
            '2026-07-04T00:00:00.000Z',
            expectedOptions,
        );
        expect(service.applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            {
                sender,
                senderId: 51,
            },
            '/tmp/work.pdf',
            [],
            '2026-07-04T00:00:00.000Z',
            {
                size: 11,
                mtimeMs: 22,
                contentFingerprint: 'base-fingerprint',
            },
            expectedOptions,
        );
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
