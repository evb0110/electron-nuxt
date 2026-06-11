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
import { createHash } from 'crypto';
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
    getWorkingCopyOriginalFileExpectation: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
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
    getWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.getWorkingCopyOriginalFileExpectation(...args),
    findWorkingCopyPathByOriginalPath: (...args: unknown[]) => mocks.findWorkingCopyPathByOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
    refreshWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.refreshWorkingCopyOriginalFileExpectation(...args),
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
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(null);
        mocks.refreshWorkingCopyOriginalFileExpectation.mockReturnValue(true);
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
        expect(mocks.copyFileCopyOnWrite).toHaveBeenLastCalledWith(originalPath, requestedWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native incremental update');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
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
        expect(mocks.copyFileCopyOnWrite).toHaveBeenLastCalledWith(originalPath, requestedWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native note changes');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('runs the generic native mutation append command for metadata changes', async () => {
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
            expect(args[0]).toBe('save-mutations');
            const mutationsFilePath = args[args.indexOf('--mutations-file') + 1];
            if (!mutationsFilePath) {
                throw new Error('Missing mutations file path');
            }
            const mutationsPayload = JSON.parse(readFileSync(mutationsFilePath, 'utf8')) as {
                pageLabels?: unknown;
                bookmarks?: unknown;
                shapes?: {
                    shapes?: unknown[];
                    deletedAnnotationIds?: string[];
                    deletedStableKeys?: string[];
                };
                markup?: {
                    overrides?: unknown[];
                    hints?: unknown[];
                };
            };
            expect(mutationsPayload.pageLabels).toMatchObject({
                totalPages: 3,
                ranges: [{
                    startPage: 1,
                    style: 'r',
                    prefix: 'intro-',
                    startNumber: 2,
                }],
            });
            expect(mutationsPayload.bookmarks).toMatchObject({
                totalPages: 3,
                untitledLabel: 'Untitled',
                items: [{
                    title: 'Chapter 1',
                    pageIndex: 0,
                }],
            });
            expect(mutationsPayload.shapes).toMatchObject({
                totalPages: 3,
                rewriteShapeState: true,
                shapes: [{
                    type: 'rectangle',
                    pageIndex: 0,
                    stableKey: 'evb-shape:shape-1',
                }],
                deletedAnnotationIds: ['44R'],
                deletedStableKeys: ['evb-shape:deleted'],
            });
            expect(mutationsPayload.markup).toMatchObject({
                overrides: [[
                    '44R',
                    'Squiggly',
                ]],
                hints: [expect.objectContaining({
                    subtype: 'Squiggly',
                    annotationId: '44R',
                    color: '#22c55e',
                })],
            });
            expect(args).toEqual(expect.arrayContaining([
                '--mutations-file',
                expect.stringMatching(/mutations\.json$/u),
                '--append',
            ]));
            await appendFile(tempPath, '\n% native metadata changes');
        });
        const { handleNativePdfMutationsSave } = await import('@electron/features/documents/main/handleNativeNoteTextSave');

        const result = await handleNativePdfMutationsSave(
            event,
            requestedWorkingPath,
            {
                pageLabels: {
                    totalPages: 3,
                    ranges: [{
                        startPage: 1,
                        style: 'r',
                        prefix: 'intro-',
                        startNumber: 2,
                    }],
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: [{
                        title: 'Chapter 1',
                        pageIndex: 0,
                        namedDest: null,
                        bold: true,
                        italic: false,
                        color: '#336699',
                        items: [],
                    }],
                },
                shapes: {
                    totalPages: 3,
                    rewriteShapeState: true,
                    shapes: [{
                        id: 'shape-1',
                        type: 'rectangle',
                        pageIndex: 0,
                        x: 0.1,
                        y: 0.2,
                        width: 0.3,
                        height: 0.2,
                        color: '#336699',
                        fillColor: '#abcdef',
                        opacity: 0.5,
                        strokeWidth: 3,
                        stableKey: 'evb-shape:shape-1',
                    }],
                    deletedAnnotationIds: ['44R'],
                    deletedStableKeys: ['evb-shape:deleted'],
                },
                markup: {
                    overrides: [[
                        '44R',
                        'Squiggly',
                    ]],
                    hints: [{
                        subtype: 'Squiggly',
                        pageIndex: 0,
                        markerRect: {
                            left: 0.1,
                            top: 0.2,
                            width: 0.3,
                            height: 0.2,
                        },
                        annotationId: '44R',
                        color: '#22c55e',
                        id: 'markup-1',
                        pageMarkupIndex: 0,
                        source: 'editor-live',
                    }],
                },
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
                'save-mutations',
                '--input',
                tempPath,
                '--output',
                tempPath,
            ]),
            expect.objectContaining({commandLabel: 'evb-pdf-page-ops(save-mutations)'}),
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, originalPath);
        expect(mocks.copyFileCopyOnWrite).toHaveBeenLastCalledWith(originalPath, requestedWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native metadata changes');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('refreshes only the requesting working copy when another current copy is queued', async () => {
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
        await expect(savePromise).resolves.toMatchObject({applied: true});
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, originalPath);
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(originalPath, requestedWorkingPath);
        expect(mocks.copyFileCopyOnWrite).not.toHaveBeenCalledWith(originalPath, latestWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native incremental update');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');

        blockedLatestMutation.resolve(undefined);
        await blockingMutation;
    });

    it('skips original-path native saves when the original no longer matches the working-copy base', async () => {
        const requestedWorkingPath = join(tempRoot, 'requested-working.pdf');
        const latestWorkingPath = join(tempRoot, 'latest-working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const tempPath = `${originalPath}.tmp`;
        writeFileSync(requestedWorkingPath, 'working-before');
        writeFileSync(latestWorkingPath, 'latest-before');
        writeFileSync(originalPath, 'external-change');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: 1,
            size: 1,
        });
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(latestWorkingPath);
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await appendFile(tempPath, '\n% native incremental update');
        });
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/handleNativeNoteTextSave');

        const result = await handleNativeNoteTextSave(event, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'');

        expect(result).toEqual({
            applied: false,
            validation: null,
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(requestedWorkingPath, tempPath);
        expect(mocks.copyFileCopyOnWrite).not.toHaveBeenCalledWith(originalPath, requestedWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toBe('working-before');
        expect(readFileSyncUtf8(originalPath)).toBe('external-change');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('skips working-copy native mutations when the queued base expectation changes', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        writeFileSync(workingPath, 'base-before');
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockedMutation = deferred<undefined>();
        const queuedMutation = enqueueWorkingCopyMutation(workingPath, async () => {
            await blockedMutation.promise;
            writeFileSync(workingPath, 'changed-before-native');
        });
        const { handleNativePdfMutationsApplyToWorkingCopy } = await import('@electron/features/documents/main/handleNativeNoteTextSave');

        const savePromise = handleNativePdfMutationsApplyToWorkingCopy(
            event,
            workingPath,
            {placedImages: [{
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 0,
                mimeType: 'image/jpeg',
                bytes: new Uint8Array([
                    0xFF,
                    0xD8,
                    0xFF,
                ]),
            }]},
            'D:20260609133855+03\'00\'',
            {
                byteLength: Buffer.byteLength('base-before'),
                sha256: createHash('sha256')
                    .update('base-before')
                    .digest('hex'),
            },
        );
        await waitForSettledQueueTurn();

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        blockedMutation.resolve(undefined);
        await queuedMutation;
        await expect(savePromise).resolves.toMatchObject({applied: false});
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(workingPath)).toBe('changed-before-native');
    });

    it('rejects working-copy native mutations without a base expectation', async () => {
        const { handleNativePdfMutationsApplyToWorkingCopy } = await import('@electron/features/documents/main/handleNativeNoteTextSave');

        await expect(handleNativePdfMutationsApplyToWorkingCopy(
            event,
            join(tempRoot, 'working.pdf'),
            {placedImages: [{
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 0,
                mimeType: 'image/jpeg',
                bytes: new Uint8Array([
                    0xFF,
                    0xD8,
                    0xFF,
                ]),
            }]},
            'D:20260609133855+03\'00\'',
            undefined,
        )).rejects.toThrow('Invalid native working-copy expectation');
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
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
