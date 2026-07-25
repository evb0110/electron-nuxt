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
    statSync,
    writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import {
    appendFile,
    copyFile,
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createOriginalFileContentFingerprintSync } from '@electron/file-access/workingCopyOriginalFileExpectation';
import { PDF_NATIVE_MUTATION_LIMITS } from '@contracts/nativePdfMutations';
import {requireDocumentRevisionToken} from '@contracts';

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
    assertWorkingCopyMutationAllowed: vi.fn(),
    assertWorkingCopyResyncAllowed: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    markWorkingCopySyncRequired: vi.fn(),
    resolveManagedTempFileHandle: vi.fn(async (_context: unknown, handle: unknown) => handle),
    resolveTypedStagedArtifact: vi.fn(async (_context: unknown, artifact: unknown) => artifact),
    createTypedStagedArtifact: vi.fn(),
    releaseManagedTempFileHandle: vi.fn((_context: unknown, _leaseId: string) => true),
    transitionOriginalAndWorkingCopyRevision: vi.fn(),
    commitPdfTempFile: vi.fn(),
    fingerprintFileWithUtilityProcess: vi.fn(),
    loggerDebug: vi.fn(),
    loggerWarn: vi.fn(),
    ensureWorkingCopyMaterialized: vi.fn(),
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
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyMutationAllowed: (...args: unknown[]) => mocks.assertWorkingCopyMutationAllowed(...args),
    assertWorkingCopyResyncAllowed: (...args: unknown[]) => mocks.assertWorkingCopyResyncAllowed(...args),
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    transitionWorkingCopyContentRevision: (...args: unknown[]) => mocks.transitionWorkingCopyContentRevision(...args),
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    markWorkingCopySyncRequired: (...args: unknown[]) => mocks.markWorkingCopySyncRequired(...args),
}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: [string, string]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));
vi.mock('@electron/features/documents/main/managedTempFileHandles', () => ({
    createTypedStagedArtifact: (...args: unknown[]) => mocks.createTypedStagedArtifact(...args),
    releaseManagedTempFileHandle: (context: unknown, leaseId: string) => mocks.releaseManagedTempFileHandle(context, leaseId),
    resolveManagedTempFileHandle: (context: unknown, handle: unknown) => mocks.resolveManagedTempFileHandle(context, handle),
    resolveTypedStagedArtifact: (context: unknown, artifact: unknown) => mocks.resolveTypedStagedArtifact(context, artifact),
}));
vi.mock('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision', () => ({transitionOriginalAndWorkingCopyRevision: (...args: unknown[]) => mocks.transitionOriginalAndWorkingCopyRevision(...args)}));
vi.mock('@electron/features/documents/main/commitPdfTempFile', () => ({commitPdfTempFile: (...args: unknown[]) => mocks.commitPdfTempFile(...args)}));
vi.mock('@electron/features/documents/main/fingerprintFileWithUtilityProcess', () => ({fingerprintFileWithUtilityProcess: (...args: unknown[]) => mocks.fingerprintFileWithUtilityProcess(...args)}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: (...args: unknown[]) => mocks.ensureWorkingCopyMaterialized(...args)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: (...args: unknown[]) => mocks.loggerDebug(...args),
    info: vi.fn(),
    warn: (...args: unknown[]) => mocks.loggerWarn(...args),
    error: vi.fn(),
})}));

function createOriginalFileExpectationForTest(originalPath: string) {
    const originalStat = statSync(originalPath);
    const contentFingerprint = createOriginalFileContentFingerprintSync(originalPath, originalStat.size);
    return {
        contentFingerprint,
        mtimeMs: originalStat.mtimeMs,
        size: originalStat.size,
    };
}

interface INativeBookmarkTestItem {
    title: string;
    pageIndex: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: INativeBookmarkTestItem[];
}

function createNativeFreeTextNote() {
    return {
        pageIndex: 0,
        stableKey: 'uid:0:pdfjs_internal_editor_0',
        text: 'Editor note',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.0016,
            height: 0.0016,
        },
    };
}

function createNativeBookmark(title = 'Chapter'): INativeBookmarkTestItem {
    return {
        title,
        pageIndex: 0,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

function createDeepNativeBookmarkItems(depth: number) {
    const root = createNativeBookmark('Root');
    let current = root;
    for (let index = 0; index < depth; index += 1) {
        const child = createNativeBookmark(`Child ${index}`);
        current.items = [child];
        current = child;
    }
    return [root];
}

function createNativeShape() {
    return {
        type: 'rectangle' as const,
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.2,
        color: '#336699',
        opacity: 0.5,
        strokeWidth: 3,
    };
}

function createNativePlacedImage() {
    return {
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.2,
        rotationDegrees: 0,
        mimeType: 'image/jpeg' as const,
        source: {
            path: '/tmp/image.jpg',
            size: 3,
            sha256: 'a'.repeat(64),
            leaseId: 'image-lease',
            revision: null,
        },
    };
}

describe('handleNativeNoteTextSave', () => {
    let tempRoot = '';
    const context = {senderId: 42};
    const revisionOptions = {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-native-mutation')};

    function createOriginalMutationFixture(originalContents = 'original-before') {
        const requestedWorkingPath = join(tempRoot, 'requested-working.pdf');
        const latestWorkingPath = join(tempRoot, 'latest-working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const tempPath = `${originalPath}.tmp`;
        writeFileSync(requestedWorkingPath, 'working-before');
        writeFileSync(latestWorkingPath, 'latest-before');
        writeFileSync(originalPath, originalContents);
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(latestWorkingPath);
        return {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-native-note-save-test-'));
        mocks.isNativePageOpsDisabled.mockReturnValue(false);
        mocks.resolveNativePageOpsPath.mockReturnValue('/native/evb-pdf-page-ops');
        mocks.isAllowedOriginalSavePath.mockReturnValue(true);
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.ensureWorkingCopyMaterialized.mockImplementation(async (path: string) => ({
            logicalRef: path,
            physicalWorkingCopyPath: path,
            sourceFingerprint: '',
        }));
        mocks.assertWorkingCopyMutationAllowed.mockReturnValue(undefined);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            workingCopyPath: string,
            reason: string,
            commit: (revision: unknown) => Promise<void>,
        ) => {
            const previousBytes = await readFile(workingCopyPath);
            const revision = {
                token: requireDocumentRevisionToken('revision-after-native-mutation'),
                version: 1,
                documentRef: workingCopyPath,
                authority: 'electron-working-copy',
                contentRevision: 2,
                mintedAt: Date.now(),
                reason,
            };
            try {
                await commit(revision);
            } catch (error) {
                await writeFile(workingCopyPath, previousBytes);
                throw error;
            }
            return revision;
        });
        mocks.markWorkingCopyContentChanged.mockResolvedValue(undefined);
        mocks.markWorkingCopySyncRequired.mockReturnValue(undefined);
        mocks.commitPdfTempFile.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await copyFile(sourcePath, targetPath);
            await unlink(sourcePath).catch(() => undefined);
        });
        mocks.createTypedStagedArtifact.mockImplementation(async (_context: unknown, path: string) => {
            const bytes = await readFile(path);
            return {
                receiptVersion: 1,
                artifactKind: 'pdf',
                path,
                size: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                fileIdentity: {
                    platform: 'posix',
                    deviceId: '1',
                    inode: '2',
                },
                validations: {
                    qpdfCheck: false,
                    tailCheck: false,
                    semanticCheck: false,
                    fsynced: false,
                },
                leaseId: 'staged-native-output',
                revision: null,
            };
        });
        mocks.fingerprintFileWithUtilityProcess.mockImplementation(async (path: string) => {
            const bytes = await readFile(path);
            return {
                bytes: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            };
        });
        mocks.transitionOriginalAndWorkingCopyRevision.mockImplementation(async (input: {
            workingCopyPath: string;
            originalPath: string;
            assertOriginalCurrent?: () => Promise<boolean>;
            publishOriginal: () => Promise<void>;
            afterWorkingCopySync?: () => Promise<void>;
        }) => {
            if (input.assertOriginalCurrent && !await input.assertOriginalCurrent()) {
                return null;
            }
            const originalBefore = await readFile(input.originalPath);
            const workingBefore = await readFile(input.workingCopyPath);
            try {
                await input.publishOriginal();
                await copyFile(input.originalPath, input.workingCopyPath);
                await input.afterWorkingCopySync?.();
            } catch (error) {
                await Promise.all([
                    writeFile(input.originalPath, originalBefore),
                    writeFile(input.workingCopyPath, workingBefore),
                ]);
                throw error;
            }
            return {token: requireDocumentRevisionToken('revision-after-native-mutation')};
        });
        mocks.getWorkingCopyOriginalFileExpectation.mockImplementation((workingPath: string, senderWebContentsId?: number) => {
            const original = mocks.getWorkingCopyOriginalPath(workingPath, senderWebContentsId);
            return original?.originalPath
                ? createOriginalFileExpectationForTest(original.originalPath)
                : null;
        });
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
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
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
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativeNoteTextSave(context, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'', revisionOptions);

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
            expect.objectContaining({
                cancelGroup: expect.stringMatching(/^working-copy-mutation:/u),
                commandLabel: 'evb-pdf-page-ops(update-note-text)',
                signal: expect.any(AbortSignal),
            }),
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, originalPath);
        expect(mocks.copyFileCopyOnWrite).toHaveBeenLastCalledWith(originalPath, requestedWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native incremental update');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('propagates materialization failure before fingerprinting or native staging', async () => {
        const requestedWorkingPath = join(tempRoot, 'lazy-working.pdf');
        const originalPath = join(tempRoot, 'lazy-original.pdf');
        writeFileSync(originalPath, 'original-before');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const failure = Object.assign(new Error('The original document is unavailable'), {
            code: 'SOURCE_BACKING_UNAVAILABLE',
            retryable: false,
        });
        mocks.ensureWorkingCopyMaterialized.mockRejectedValue(failure);
        const {handleNativeNoteTextSave} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        await expect(handleNativeNoteTextSave(
            context,
            requestedWorkingPath,
            [{
                objectNumber: 42,
                generationNumber: 0,
                text: 'Updated note',
            }],
            'D:20260609133855+03\'00\'',
            revisionOptions,
        )).rejects.toBe(failure);

        expect(mocks.fingerprintFileWithUtilityProcess).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(mocks.makeSiblingTempPath).not.toHaveBeenCalled();
        expect(readFileSync(originalPath, 'utf8')).toBe('original-before');
    });

    it('rolls back both targets when post-commit working-copy sync fails', async () => {
        const {
            requestedWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(requestedWorkingPath);
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await appendFile(tempPath, '\n% native incremental update');
        });
        mocks.copyFileCopyOnWrite.mockImplementation(async (sourcePath: string, targetPath: string) => {
            if (sourcePath === originalPath && targetPath === requestedWorkingPath) {
                throw new Error('sync failed');
            }
            await copyFile(sourcePath, targetPath);
        });
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativeNoteTextSave(context, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'', revisionOptions);

        expect(result).toEqual({
            applied: false,
            validation: null,
        });
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, originalPath);
        expect(readFileSyncUtf8(originalPath)).toBe('original-before');
        expect(readFileSyncUtf8(requestedWorkingPath)).toBe('working-before');
    });

    it('runs the native note changes append command for FreeText note upserts', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
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
        const { handleNativeNoteChangesSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

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
            context,
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
            revisionOptions,
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

    it('commits a metadata-only mutation save to the original document', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args[0]).toBe('save-mutations');
            await appendFile(tempPath, '\n% native metadata-only changes');
        });
        const { handleNativePdfMutationsSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativePdfMutationsSave(
            context,
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
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(result).toMatchObject({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
            },
        });
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native metadata-only changes');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('runs the generic native mutation append command for mixed native changes', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
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
        const { handleNativePdfMutationsSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativePdfMutationsSave(
            context,
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
            revisionOptions,
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
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await appendFile(tempPath, '\n% native incremental update');
        });
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockedLatestMutation = deferred<undefined>();
        const blockingMutation = enqueueWorkingCopyMutation(latestWorkingPath, () => blockedLatestMutation.promise);
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const savePromise = handleNativeNoteTextSave(context, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'', revisionOptions);
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
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture('external-change');
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: 1,
            size: 1,
        });
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await appendFile(tempPath, '\n% native incremental update');
        });
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativeNoteTextSave(context, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'', revisionOptions);

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
        const { handleNativePdfMutationsApplyToWorkingCopy } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const savePromise = handleNativePdfMutationsApplyToWorkingCopy(
            context,
            workingPath,
            {placedImages: [{
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 0,
                mimeType: 'image/jpeg',
                source: createNativePlacedImage().source,
            }]},
            'D:20260609133855+03\'00\'',
            {
                byteLength: Buffer.byteLength('base-before'),
                sha256: createHash('sha256')
                    .update('base-before')
                    .digest('hex'),
            },
            revisionOptions,
        );
        await waitForSettledQueueTurn();

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        blockedMutation.resolve(undefined);
        await queuedMutation;
        await expect(savePromise).resolves.toMatchObject({applied: false});
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(workingPath)).toBe('changed-before-native');
        expect(mocks.fingerprintFileWithUtilityProcess).toHaveBeenCalledWith(workingPath);
        expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining(
            'Native working-copy mutation skipped because base expectation no longer matches',
        ));
    });

    it('stages native output without exposing it and commits the verified artifact once', async () => {
        const workingPath = join(tempRoot, 'staged-working.pdf');
        const originalPath = join(tempRoot, 'staged-original.pdf');
        writeFileSync(workingPath, 'base-before');
        writeFileSync(originalPath, 'base-before');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(workingPath);
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            const outputIndex = args.indexOf('--output') + 1;
            const outputPath = args[outputIndex];
            if (!outputPath) throw new Error('missing output path');
            await appendFile(outputPath, '\n% staged mutation');
        });
        const {
            handleCommitStagedPdfNativeMutations,
            handleNativePdfMutationsApplyToWorkingCopy,
        } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const staged = await handleNativePdfMutationsApplyToWorkingCopy(
            context,
            workingPath,
            {placedImages: [createNativePlacedImage()]},
            'D:20260609133855+03\'00\'',
            {
                byteLength: Buffer.byteLength('base-before'),
                sha256: createHash('sha256').update('base-before').digest('hex'),
            },
            revisionOptions,
        );

        expect(staged).toMatchObject({
            applied: true,
            validation: {isValid: true},
            stagedOutput: {leaseId: 'staged-native-output'},
        });
        expect(staged.stagedOutput?.path).toBe(`${workingPath}.tmp.pdf`);
        expect(readFileSyncUtf8(workingPath)).toBe('base-before');
        expect(readFileSyncUtf8(originalPath)).toBe('base-before');
        expect(staged.stagedOutput && readFileSyncUtf8(staged.stagedOutput.path)).toContain('% staged mutation');
        expect(mocks.fingerprintFileWithUtilityProcess).toHaveBeenCalledWith(workingPath);
        if (!staged.stagedOutput) {
            throw new Error('Expected a staged artifact');
        }

        const committed = await handleCommitStagedPdfNativeMutations(
            context,
            workingPath,
            staged.stagedOutput,
            {
                ...revisionOptions,
                changedObjectRefs: ['44 0 R'],
            },
        );

        expect(committed).toMatchObject({
            applied: true,
            validation: {isValid: true},
        });
        expect(readFileSyncUtf8(workingPath)).toContain('% staged mutation');
        expect(readFileSyncUtf8(originalPath)).toContain('% staged mutation');
        expect(mocks.transitionOriginalAndWorkingCopyRevision).toHaveBeenCalledOnce();
        expect(mocks.commitPdfTempFile).toHaveBeenCalledWith(
            expect.stringContaining('staged-original.pdf.tmp'),
            originalPath,
            {changedObjectRefs: ['44 0 R']},
        );
        expect(mocks.releaseManagedTempFileHandle).toHaveBeenCalledWith(context, 'staged-native-output');
    });

    it('rejects shared native mutation limit violations before native execution', async () => {
        const {
            handleNativeNoteChangesSave,
            handleNativePdfMutationsApplyToWorkingCopy,
            handleNativePdfMutationsSave,
        } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');
        const workingPath = join(tempRoot, 'working.pdf');
        const modifiedAt = 'D:20260609133855+03\'00\'';

        await expect(handleNativeNoteChangesSave(
            context,
            workingPath,
            {freeTextNotes: Array.from(
                {length: PDF_NATIVE_MUTATION_LIMITS.noteChanges + 1},
                createNativeFreeTextNote,
            )},
            modifiedAt,
        )).rejects.toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.noteChanges} notes`);

        await expect(handleNativePdfMutationsSave(
            context,
            workingPath,
            {pageLabels: {
                totalPages: 3,
                ranges: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges + 1}, () => ({
                    startPage: 1,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                })),
            }},
            modifiedAt,
        )).rejects.toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges} ranges`);

        await expect(handleNativePdfMutationsSave(
            context,
            workingPath,
            {bookmarks: {
                totalPages: 3,
                untitledLabel: 'Untitled',
                items: createDeepNativeBookmarkItems(PDF_NATIVE_MUTATION_LIMITS.bookmarkDepth + 1),
            }},
            modifiedAt,
        )).rejects.toThrow('maximum bookmark depth');

        await expect(handleNativePdfMutationsSave(
            context,
            workingPath,
            {shapes: {
                totalPages: 3,
                rewriteShapeState: true,
                shapes: [{
                    ...createNativeShape(),
                    points: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.shapePoints + 1}, () => ({
                        x: 0.1,
                        y: 0.2,
                    })),
                }],
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            }},
            modifiedAt,
        )).rejects.toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.shapePoints} points`);

        await expect(handleNativePdfMutationsSave(
            context,
            workingPath,
            {markup: {
                overrides: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.markupItems + 1}, (_, index) => [
                    `${index}R`,
                    'Highlight',
                ]),
                hints: [],
            }},
            modifiedAt,
        )).rejects.toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.markupItems} items`);

        await expect(handleNativePdfMutationsApplyToWorkingCopy(
            context,
            workingPath,
            {placedImages: Array.from(
                {length: PDF_NATIVE_MUTATION_LIMITS.placedImages + 1},
                createNativePlacedImage,
            )},
            modifiedAt,
            {
                byteLength: 3,
                sha256: 'a'.repeat(64),
            },
        )).rejects.toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.placedImages} images`);

        await expect(handleNativePdfMutationsApplyToWorkingCopy(
            context,
            workingPath,
            {placedImages: [createNativePlacedImage()]},
            modifiedAt,
            {
                byteLength: 3,
                sha256: 'not-a-digest',
            },
        )).rejects.toThrow('Invalid native working-copy expectation');

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('rejects working-copy native mutations without a base expectation', async () => {
        const { handleNativePdfMutationsApplyToWorkingCopy } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        await expect(handleNativePdfMutationsApplyToWorkingCopy(
            context,
            join(tempRoot, 'working.pdf'),
            {placedImages: [{
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 0,
                mimeType: 'image/jpeg',
                source: createNativePlacedImage().source,
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
