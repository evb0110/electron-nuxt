import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const browserDocumentStoreMock = vi.hoisted(() => ({
    getSourceRef: vi.fn(),
    getSaveTarget: vi.fn(),
    stat: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    assertDocumentRevisionCurrent: vi.fn(),
    assignSaveTarget: vi.fn(),
    touchRecentFile: vi.fn(),
    replaceWithHandleBackedDocument: vi.fn(),
}));

const filePickerMock = vi.hoisted(() => ({
    saveBytesToPickerOrDownload: vi.fn(),
    writeDocumentRefToHandle: vi.fn(),
}));

vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_MAX_FULL_READ_BYTES: 64 * 1024 * 1024,
    browserDocumentStore: browserDocumentStoreMock,
}));

vi.mock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
    saveBytesToPickerOrDownload: (...args: unknown[]) => filePickerMock.saveBytesToPickerOrDownload(...args),
    writeDocumentRefToHandle: (...args: unknown[]) => filePickerMock.writeDocumentRefToHandle(...args),
}));

describe('browserSaveTargets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        browserDocumentStoreMock.getSourceRef.mockResolvedValue('browser://documents/source');
        browserDocumentStoreMock.getSaveTarget.mockResolvedValue({
            saveName: 'source.pdf',
            saveKind: 'pdf',
            saveHandle: null,
        });
        browserDocumentStoreMock.stat.mockResolvedValue({size: 3});
        browserDocumentStoreMock.read.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        browserDocumentStoreMock.assertDocumentRevisionCurrent.mockResolvedValue(undefined);
        browserDocumentStoreMock.write.mockResolvedValue(true);
        browserDocumentStoreMock.assignSaveTarget.mockResolvedValue(undefined);
        browserDocumentStoreMock.touchRecentFile.mockResolvedValue(undefined);
    });

    it('returns structured success when browser save completes', async () => {
        filePickerMock.saveBytesToPickerOrDownload.mockResolvedValue({
            canceled: false,
            fileName: 'saved.pdf',
            handle: null,
        });
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured('browser://documents/working', () => 'hint'))
            .resolves
            .toEqual({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
                validation: null,
            });
    });

    it('returns user-canceled when the picker is canceled', async () => {
        filePickerMock.saveBytesToPickerOrDownload.mockResolvedValue({canceled: true});
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured('browser://documents/working', () => 'hint'))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'user-canceled',
                externalWriteCommitted: false,
                validation: null,
            });
    });

    it('returns write-failed when the browser write path throws', async () => {
        filePickerMock.saveBytesToPickerOrDownload.mockRejectedValue(new Error('disk denied'));
        const { saveWorkingBytesToSourceStructured } = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(saveWorkingBytesToSourceStructured('browser://documents/working', () => 'hint'))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'write-failed',
                message: 'disk denied',
                externalWriteCommitted: false,
                validation: null,
            });
    });
});
