import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    appendFile,
    copyFile,
    unlink,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
    runNativeToolCommand: vi.fn(),
    isNativePageOpsDisabled: vi.fn(),
    resolveNativePageOpsPath: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
    isAllowedOriginalSavePath: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    atomicReplace: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/features/page-ops/public', () => ({
    isNativePageOpsDisabled: (...args: unknown[]) => mocks.isNativePageOpsDisabled(...args),
    resolveNativePageOpsPath: (...args: unknown[]) => mocks.resolveNativePageOpsPath(...args),
}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    findWorkingCopyPathByOriginalPath: (...args: unknown[]) => mocks.findWorkingCopyPathByOriginalPath(...args),
}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', () => ({isAllowedOriginalSavePath: (...args: unknown[]) => mocks.isAllowedOriginalSavePath(...args)}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: [string, string]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));

describe('handleNativeNoteTextSave', () => {
    let tempRoot = '';
    const event = {sender: {id: 42}} as Electron.IpcMainInvokeEvent;

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-native-note-save-test-'));
        mocks.isNativePageOpsDisabled.mockReturnValue(false);
        mocks.resolveNativePageOpsPath.mockReturnValue('/native/evb-pdf-page-ops');
        mocks.isAllowedOriginalSavePath.mockReturnValue(true);
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await copyFile(sourcePath, targetPath);
            await unlink(sourcePath);
        });
        mocks.copyFileCopyOnWrite.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await copyFile(sourcePath, targetPath);
        });
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('runs the native append command against a temp snapshot and syncs the refreshed working copy', async () => {
        const requestedWorkingPath = join(tempRoot, 'requested-working.pdf');
        const latestWorkingPath = join(tempRoot, 'latest-working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const tempPath = `${originalPath}.tmp`;
        writeFileSync(requestedWorkingPath, 'working-before');
        writeFileSync(latestWorkingPath, 'latest-before');
        writeFileSync(originalPath, 'original-before');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(latestWorkingPath);
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args).toEqual(expect.arrayContaining([
                '--input',
                tempPath,
                '--output',
                tempPath,
                '--append',
            ]));
            await appendFile(tempPath, '\n% native incremental update');
        });
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/handleNativeNoteTextSave');

        const result = await handleNativeNoteTextSave(event, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'');

        expect(result).toMatchObject({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
            },
        });
        expect(mocks.copyFileCopyOnWrite).toHaveBeenNthCalledWith(1, requestedWorkingPath, tempPath);
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                'update-note-text',
                '--input',
                tempPath,
                '--output',
                tempPath,
            ]),
            expect.objectContaining({commandLabel: 'evb-pdf-page-ops(update-note-text)'}),
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, originalPath);
        expect(mocks.copyFileCopyOnWrite).toHaveBeenLastCalledWith(originalPath, latestWorkingPath);
        expect(readFileSyncUtf8(latestWorkingPath)).toContain('% native incremental update');
    });

    it('runs the native note changes append command for FreeText note upserts', async () => {
        const requestedWorkingPath = join(tempRoot, 'requested-working.pdf');
        const latestWorkingPath = join(tempRoot, 'latest-working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const tempPath = `${originalPath}.tmp`;
        writeFileSync(requestedWorkingPath, 'working-before');
        writeFileSync(latestWorkingPath, 'latest-before');
        writeFileSync(originalPath, 'original-before');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(latestWorkingPath);
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args[0]).toBe('save-note-changes');
            const changesFilePath = args[args.indexOf('--changes-file') + 1];
            if (!changesFilePath) {
                throw new Error('Missing changes file path');
            }
            const changesPayload = JSON.parse(readFileSync(changesFilePath, 'utf8')) as {deletes?: unknown[]};
            expect(changesPayload.deletes).toMatchObject([
                {
                    pageIndex: 0,
                    objectNumber: 3856,
                    generationNumber: 0,
                },
                {
                    pageIndex: 0,
                    stableKey: 'uid:0:pdfjs_internal_editor_0',
                    createdAt: 1781009077000,
                },
            ]);
            expect(args).toEqual(expect.arrayContaining([
                '--changes-file',
                expect.stringMatching(/changes\.json$/u),
                '--append',
            ]));
            await appendFile(tempPath, '\n% native note changes');
        });
        const { handleNativeNoteChangesSave } = await import('@electron/features/documents/main/handleNativeNoteTextSave');

        const freeTextNotes = [{
            pageIndex: 0,
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            text: 'Editor note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
        }];
        const result = await handleNativeNoteChangesSave(
            event,
            requestedWorkingPath,
            {
                updates: [],
                freeTextNotes,
                deletes: [
                    {
                        pageIndex: 0,
                        objectNumber: 3856,
                        generationNumber: 0,
                    },
                    {
                        pageIndex: 0,
                        stableKey: 'uid:0:pdfjs_internal_editor_0',
                        createdAt: 1781009077000,
                    },
                ],
            },
            'D:20260609133855+03\'00\'',
        );

        expect(result).toMatchObject({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
            },
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                'save-note-changes',
                '--input',
                tempPath,
                '--output',
                tempPath,
            ]),
            expect.objectContaining({commandLabel: 'evb-pdf-page-ops(save-note-changes)'}),
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, originalPath);
        expect(mocks.copyFileCopyOnWrite).toHaveBeenLastCalledWith(originalPath, latestWorkingPath);
        expect(readFileSyncUtf8(latestWorkingPath)).toContain('% native note changes');
    });

    it('queues refreshed working-copy sync behind that working copy mutation queue', async () => {
        const requestedWorkingPath = join(tempRoot, 'requested-working.pdf');
        const latestWorkingPath = join(tempRoot, 'latest-working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const tempPath = `${originalPath}.tmp`;
        writeFileSync(requestedWorkingPath, 'working-before');
        writeFileSync(latestWorkingPath, 'latest-before');
        writeFileSync(originalPath, 'original-before');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(latestWorkingPath);
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await appendFile(tempPath, '\n% native incremental update');
        });
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockedLatestMutation = deferred<undefined>();
        const blockingMutation = enqueueWorkingCopyMutation(latestWorkingPath, () => blockedLatestMutation.promise);
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/handleNativeNoteTextSave');

        const savePromise = handleNativeNoteTextSave(event, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'');
        await waitForSettledQueueTurn();

        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, originalPath);
        expect(mocks.copyFileCopyOnWrite).not.toHaveBeenCalledWith(originalPath, latestWorkingPath);
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');

        blockedLatestMutation.resolve(undefined);
        await blockingMutation;
        await expect(savePromise).resolves.toMatchObject({applied: true});
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(originalPath, latestWorkingPath);
        expect(readFileSyncUtf8(latestWorkingPath)).toContain('% native incremental update');
    });
});

function readFileSyncUtf8(path: string) {
    return readFileSync(path, 'utf8');
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

async function waitForSettledQueueTurn() {
    await delay(20);
}
