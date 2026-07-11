import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IPageOpsService} from '@electron/features/page-ops/ports';
import type {IPageOpsInvokeMap} from '@electron/features/page-ops/contract';
import {cast} from '@tests/helpers/cast';
import {
    createHarnessEvent,
    createValidatedRegistrarHarness,
    getCapturedIpcHandler,
    type IValidatedRegistrarCase,
} from '@tests/unit/electron/helpers/validatedIpcRegistrarHarness';

const mocks = vi.hoisted(() => ({isTrustedIpcInvokeSender: vi.fn(() => true)}));

vi.mock('electron', () => ({
    app: {isPackaged: false},
    BrowserWindow: {fromWebContents: () => null},
    ipcMain: {handle: vi.fn()},
}));
vi.mock('@electron/platform-ipc/trustedIpcSender', () => mocks);
vi.mock('@electron/features/page-ops/createPageOpsService', () => ({createPageOpsService: vi.fn()}));

function createService() {
    return cast<IPageOpsService>({
        delete: vi.fn(async () => ({success: true})),
        extract: vi.fn(async () => ({success: true})),
        reorder: vi.fn(async () => ({success: true})),
        insert: vi.fn(async () => ({success: true})),
        insertFile: vi.fn(async () => ({success: true})),
        rotate: vi.fn(async () => ({success: true})),
        crop: vi.fn(async () => ({success: true})),
        removeCrop: vi.fn(async () => ({success: true})),
        getPageGeometry: vi.fn(async () => ({
            mediaBox: {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
            cropBox: null,
            rotation: 0,
        })),
    });
}

describe('page ops validated IPC decoder', () => {
    it('routes every channel through the real registrar and rejects malformed tuples and senders', async () => {
        const {PAGE_OPS_CHANNELS} = await import('@electron/features/page-ops/contract');
        const {PAGE_OPS_IPC_CODECS} = await import('@electron/features/page-ops/pageOpsIpcCodecs');
        const {registerPageOpsIpcAdapter} = await import('@electron/features/page-ops/registerPageOpsIpcAdapter');
        const service = createService();
        const cases: IValidatedRegistrarCase[] = [
            {
                channel: PAGE_OPS_CHANNELS.delete,
                validArgs: [
                    '/tmp/work.pdf',
                    [1],
                    3,
                    undefined,
                ],
            },
            {
                channel: PAGE_OPS_CHANNELS.extract,
                validArgs: [
                    '/tmp/work.pdf',
                    [1],
                ],
            },
            {
                channel: PAGE_OPS_CHANNELS.reorder,
                validArgs: [
                    '/tmp/work.pdf',
                    [
                        3,
                        2,
                        1,
                    ],
                    undefined,
                ],
            },
            {
                channel: PAGE_OPS_CHANNELS.insert,
                validArgs: [
                    '/tmp/work.pdf',
                    3,
                    1,
                    undefined,
                ],
            },
            {
                channel: PAGE_OPS_CHANNELS.insertFile,
                validArgs: [
                    '/tmp/work.pdf',
                    3,
                    1,
                    ['/tmp/source.pdf'],
                    undefined,
                    undefined,
                ],
            },
            {
                channel: PAGE_OPS_CHANNELS.rotate,
                validArgs: [
                    '/tmp/work.pdf',
                    [1],
                    3,
                    90,
                    {
                        expectedDocumentRevisionToken: 'drt1:test',
                        metadataSnapshot: {
                            pageLabels: [
                                'i',
                                '1',
                                '2',
                            ],
                            bookmarks: [{
                                title: 'Chapter',
                                pageIndex: 1,
                                namedDest: null,
                                bold: false,
                                italic: false,
                                color: null,
                                items: [],
                            }],
                            untitledBookmarkLabel: 'Untitled',
                        },
                    },
                ],
            },
            {
                channel: PAGE_OPS_CHANNELS.crop,
                validArgs: [
                    '/tmp/work.pdf',
                    [1],
                    3,
                    {
                        top: 1,
                        right: 1,
                        bottom: 1,
                        left: 1,
                    },
                    undefined,
                ],
            },
            {
                channel: PAGE_OPS_CHANNELS.removeCrop,
                validArgs: [
                    '/tmp/work.pdf',
                    [1],
                    3,
                    undefined,
                ],
            },
            {
                channel: PAGE_OPS_CHANNELS.getPageGeometry,
                validArgs: [
                    '/tmp/work.pdf',
                    1,
                ],
            },
        ];
        const handlers = createValidatedRegistrarHarness<IPageOpsInvokeMap, IPageOpsService>({
            channels: PAGE_OPS_CHANNELS,
            codecs: PAGE_OPS_IPC_CODECS,
            register: registerPageOpsIpcAdapter,
            service,
        });

        expect([...handlers.keys()].sort()).toEqual(Object.values(PAGE_OPS_CHANNELS).sort());
        for (const testCase of cases) {
            const handler = getCapturedIpcHandler(handlers, testCase.channel);
            mocks.isTrustedIpcInvokeSender.mockReturnValue(true);
            await expect(handler(createHarnessEvent(), ...testCase.validArgs)).resolves.not.toThrow();

            for (let index = 0; index < testCase.validArgs.length; index += 1) {
                const malformedArgs = [...testCase.validArgs];
                malformedArgs[index] = Symbol('malformed');
                await expect(handler(createHarnessEvent(), ...malformedArgs)).rejects.toThrow(
                    `Invalid IPC arguments for ${testCase.channel}`,
                );
            }
            await expect(handler(createHarnessEvent(), ...testCase.validArgs, 'extra')).rejects.toThrow(
                `Invalid IPC arguments for ${testCase.channel}`,
            );

            mocks.isTrustedIpcInvokeSender.mockReturnValue(false);
            await expect(handler(createHarnessEvent(), ...testCase.validArgs)).rejects.toThrow('IPC sender is not trusted');
        }
    });

    it('rejects malformed page-operation results at the preload boundary', async () => {
        const {PAGE_OPS_CHANNELS} = await import('@electron/features/page-ops/contract');
        const {PAGE_OPS_IPC_CODECS} = await import('@electron/features/page-ops/pageOpsIpcCodecs');

        expect(() => PAGE_OPS_IPC_CODECS[PAGE_OPS_CHANNELS.rotate].decodeResult({success: 'yes'})).toThrow(
            'page operation result must include success',
        );
        expect(() => PAGE_OPS_IPC_CODECS[PAGE_OPS_CHANNELS.getPageGeometry].decodeResult({
            mediaBox: {
                x: 0,
                y: 0,
                width: Number.NaN,
                height: 100,
            },
            cropBox: null,
            rotation: 0,
        })).toThrow('page geometry box must contain finite coordinates');
    });
});
