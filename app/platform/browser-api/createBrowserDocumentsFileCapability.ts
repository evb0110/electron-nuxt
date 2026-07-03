import type { IDocumentsFileCapability } from '@contracts/electronApiDocuments';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { IRecentFile } from '@contracts/shared';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
    getBrowserDocumentFileName,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import { syncBrowserWindowTitle } from '@app/platform/browserWindowTabs';
import {
    OPEN_IMAGE_ACCEPT,
    OPEN_INPUT_ACCEPT,
    buildDocxSaveTypes,
    buildImagePickerTypes,
    buildOpenPdfPickerTypes,
    buildPdfSaveTypes,
} from '@app/platform/browser-api/browserFileAccepts';
import {
    ensureDocxExtension,
    ensurePdfExtension,
    isPdfFileName,
} from '@app/platform/browser-api/browserFileName';
import type { IBrowserBatchOpenProgressOptions } from '@app/platform/browser-api/createCombinedPdfFromPaths';
import {
    analyzeBrowserPdfConformance,
    validateBrowserPdfData,
} from '@app/platform/browser-api/browserPdfValidation';
import {
    isFileSystemAccessDeniedError,
    pickFiles,
    pickSaveTarget,
    pickSingleFile,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
    writeDocumentRefToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {
    createBrowserWorkingCopyFromBytes,
    decryptBrowserWorkingCopy,
    openDocumentPaths,
} from '@app/platform/browser-api/browserWorkingCopyService';
import {
    assertBrowserPathWithinFullReadBudget,
    saveWorkingBytesToSource,
    saveWorkingBytesToSourceStructured,
} from '@app/platform/browser-api/browserSaveTargets';
import { createPlatformUnsupportedResult } from '@contracts/platformUnsupported';
import { writeRecentFilesToStorage } from '@app/platform/browser/browserRecentFilesStore';
import { stripBrowserPdfEncryption } from '@app/platform/browser-api/stripBrowserPdfEncryption';

const BROWSER_DEFAULT_PDF_APP_UNSUPPORTED = 'Opening via the default desktop PDF app is unavailable in the browser capability';
const BROWSER_NATIVE_PRINT_UNSUPPORTED = 'Printing via the native desktop dialog is unavailable in the browser capability';

export async function createBrowserCombinedPdfFromPaths(
    paths: string[],
    progressOptions?: IBrowserBatchOpenProgressOptions,
) {
    const module = await import('@app/platform/browser-api/createCombinedPdfFromPaths');
    return module.createCombinedPdfFromPaths(paths, progressOptions);
}

interface ICreateBrowserDocumentsFileCapabilityOptions {
    clearSearchCaches: (pdfPath?: string) => void;
    errorMessageProvider?: { largeSaveHandleHint: () => string; };
}
const defaultBrowserLargeSaveHandleHintProvider = () => (
    'Use a browser with local file system access enabled to save large documents.'
);

type TCanonicalDocumentsFileCapability = Omit<
    IDocumentsFileCapability,
    'openPdfDialog' | 'openPdfDirect' | 'openPdfDirectBatch'
>;

function createCanceledSaveValidationResult(validation: IPdfValidationResult): IPdfValidationResult {
    return {
        ...validation,
        isValid: false,
        errors: [],
    };
}

export function createBrowserDocumentsFileCapability(
    options: ICreateBrowserDocumentsFileCapabilityOptions,
): IDocumentsFileCapability {
    const { clearSearchCaches } = options;
    const browserLargeSaveHandleHintProvider = options.errorMessageProvider?.largeSaveHandleHint
        ?? defaultBrowserLargeSaveHandleHintProvider;

    async function cleanupTransientOpenRefs(paths: string[]) {
        await Promise.all(paths.map(async (path) => {
            try {
                await browserDocumentStore.remove(path);
            } catch {
                // Cleanup is best effort for failed transient opens.
            }
        }));
    }

    async function savePdfAsWithOptionalData(
        workingCopyPath: string,
        data?: Uint8Array,
    ) {
        const saveTarget =
            await browserDocumentStore.getSaveTarget(workingCopyPath);
        const previousSourceRef =
            await browserDocumentStore.getSourceRef(workingCopyPath);
        const suggestedName = ensurePdfExtension(saveTarget.saveName);
        const saveResult = await pickSaveTarget({
            suggestedName,
            pickerTypes: buildPdfSaveTypes(),
        });

        if (saveResult.canceled) {
            return null;
        }

        let normalizedFileName = ensurePdfExtension(saveResult.fileName);
        let savedHandle = saveResult.handle;
        let sourceRef = previousSourceRef;

        if (saveResult.handle) {
            if (data) {
                await writeBytesToHandle(saveResult.handle, data);
            } else {
                await writeDocumentRefToHandle(saveResult.handle, workingCopyPath);
            }
            const size = data?.byteLength
                ?? (await browserDocumentStore.stat(workingCopyPath)).size;
            if (sourceRef === workingCopyPath) {
                sourceRef = await browserDocumentStore.createStoredDocument(
                    normalizedFileName,
                    new Uint8Array(),
                    {
                        mimeType: 'application/pdf',
                        saveKind: 'pdf',
                        kind: 'source',
                        saveHandle: saveResult.handle,
                        storageMode: 'handle',
                    },
                );
            }
            await browserDocumentStore.replaceWithHandleBackedDocument(sourceRef, {
                fileSize: size,
                saveHandle: saveResult.handle,
                saveName: normalizedFileName,
            });
            await browserDocumentStore.assignSaveTarget(
                sourceRef,
                normalizedFileName,
                'pdf',
                saveResult.handle,
            );
        } else {
            let bytes: Uint8Array;
            if (data) {
                bytes = data;
                if (bytes.byteLength > BROWSER_MAX_FULL_READ_BYTES) {
                    throw new Error(
                        'Saving documents is unavailable in the browser for inputs larger than 64MB '
                        + browserLargeSaveHandleHintProvider(),
                    );
                }
            } else {
                await assertBrowserPathWithinFullReadBudget(
                    workingCopyPath,
                    'Saving documents',
                    browserLargeSaveHandleHintProvider(),
                );
                bytes = await browserDocumentStore.read(workingCopyPath);
            }
            const downloadResult = await saveBytesToPickerOrDownload(bytes, {
                suggestedName,
                mimeType: 'application/pdf',
                pickerTypes: buildPdfSaveTypes(),
                downloadFallbackLabel: 'Saving documents',
            });

            if (downloadResult.canceled) {
                return null;
            }

            normalizedFileName = ensurePdfExtension(downloadResult.fileName);
            savedHandle = downloadResult.handle;
            sourceRef = await browserDocumentStore.createStoredDocument(
                normalizedFileName,
                bytes,
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'source',
                    saveHandle: downloadResult.handle,
                },
            );
        }
        if (data) {
            await browserDocumentStore.write(workingCopyPath, data);
        }
        await browserDocumentStore.replaceWorkingCopySource(
            workingCopyPath,
            sourceRef,
            normalizedFileName,
            savedHandle,
        );
        if (sourceRef !== previousSourceRef && previousSourceRef !== workingCopyPath) {
            await browserDocumentStore.cleanupDetachedDocument(previousSourceRef);
        }
        await browserDocumentStore.touchRecentFile(sourceRef);
        browserDocumentStore.unload(sourceRef);
        return sourceRef;
    }

    const capability: TCanonicalDocumentsFileCapability = {
        async openDocumentDialog() {
            const pickedFiles = await pickFiles({
                accept: OPEN_INPUT_ACCEPT,
                multiple: false,
                pickerTypes: buildOpenPdfPickerTypes(),
            });
            const picked = pickedFiles[0];
            if (!picked) {
                return null;
            }

            const sourceRef = await browserDocumentStore.registerFile(picked.file, {
                kind: 'source',
                saveKind: 'pdf',
                saveHandle: picked.handle ?? null,
            });

            try {
                return await openDocumentPaths([sourceRef]);
            } catch (error) {
                await cleanupTransientOpenRefs([sourceRef]);
                throw error;
            }
        },
        openFolderDialog() {
            return Promise.resolve(null);
        },
        openFolderDialogStructured() {
            return Promise.resolve(createPlatformUnsupportedResult(
                'requires-native-backend',
                'Folder dialogs require the desktop app.',
            ));
        },
        async openCombineDialog() {
            const pickedFiles = await pickFiles({
                accept: OPEN_INPUT_ACCEPT,
                multiple: true,
                pickerTypes: buildOpenPdfPickerTypes(),
            });
            if (pickedFiles.length === 0) {
                return null;
            }

            const refs: string[] = [];
            for (const picked of pickedFiles) {
                const ref = await browserDocumentStore.registerFile(picked.file, {
                    kind: 'source',
                    retention: 'transient',
                    saveKind: 'generic',
                    saveHandle: null,
                });
                refs.push(ref);
            }

            try {
                return await openDocumentPaths(refs);
            } catch (error) {
                await cleanupTransientOpenRefs(refs);
                throw error;
            }
        },
        async openImageDialog() {
            const picked = await pickSingleFile({
                accept: OPEN_IMAGE_ACCEPT,
                pickerTypes: buildImagePickerTypes(),
            });
            if (!picked) {
                return null;
            }

            return browserDocumentStore.registerFile(picked.file, {
                kind: 'source',
                retention: 'transient',
                saveKind: 'generic',
                saveHandle: picked.handle ?? null,
            });
        },
        async openDocumentDirect(path) {
            if (!isBrowserDocumentRef(path)) {
                return null;
            }

            try {
                return await openDocumentPaths([path]);
            } catch (error) {
                if (isFileSystemAccessDeniedError(error)) {
                    return null;
                }

                throw error;
            }
        },
        async openDocumentDirectBatch(paths, requestId) {
            if (paths.some((path) => !isBrowserDocumentRef(path))) {
                return null;
            }

            try {
                return await openDocumentPaths(
                    paths,
                    requestId ? { requestId } : undefined,
                );
            } catch (error) {
                if (isFileSystemAccessDeniedError(error)) {
                    return null;
                }

                throw error;
            }
        },
        async savePdfAs(workingCopyPath) {
            return savePdfAsWithOptionalData(workingCopyPath);
        },
        async savePdfDataAs(workingCopyPath, data) {
            const validation = await validateBrowserPdfData(data);
            if (!validation.isValid) {
                return {
                    path: null,
                    validation,
                };
            }

            const path = await savePdfAsWithOptionalData(workingCopyPath, data);
            return {
                path,
                validation,
            };
        },
        async savePdfDialog(suggestedName) {
            const nextName = ensurePdfExtension(suggestedName);
            const saveResult = await pickSaveTarget({
                suggestedName: nextName,
                pickerTypes: buildPdfSaveTypes(),
            });
            if (saveResult.canceled) {
                return null;
            }

            return browserDocumentStore.createStoredDocument(
                ensurePdfExtension(saveResult.fileName),
                new Uint8Array(),
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'output',
                    retention: 'transient',
                    saveHandle: saveResult.handle,
                },
            );
        },
        async saveDocxAs(workingCopyPath) {
            const fallbackName = ensureDocxExtension(
                getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
            );
            const saveResult = await pickSaveTarget({
                suggestedName: fallbackName,
                pickerTypes: buildDocxSaveTypes(),
            });
            if (saveResult.canceled) {
                return null;
            }

            return browserDocumentStore.createStoredDocument(
                ensureDocxExtension(saveResult.fileName),
                new Uint8Array(),
                {
                    mimeType:
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    saveKind: 'docx',
                    kind: 'output',
                    retention: 'transient',
                    saveHandle: saveResult.handle,
                },
            );
        },
        async readFile(path) {
            return browserDocumentStore.read(path);
        },
        statFile(path) {
            return browserDocumentStore.stat(path);
        },
        readFileRange(path, offset, length) {
            return browserDocumentStore.readRange(path, offset, length);
        },
        async readFileChunks(path, options, onChunk) {
            const chunkBytes = options.chunkBytes ?? 8 * 1024 * 1024;
            if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
                throw new Error('readFileChunks.options.chunkBytes must be a positive integer');
            }
            const { size } = await browserDocumentStore.stat(path);
            let bytesRead = 0;
            let chunks = 0;
            while (bytesRead < size) {
                if (options.signal?.aborted) {
                    throw options.signal.reason instanceof Error
                        ? options.signal.reason
                        : new Error('The operation was aborted.');
                }
                const length = Math.min(chunkBytes, size - bytesRead);
                const chunk = await browserDocumentStore.readRange(path, bytesRead, length);
                await onChunk(chunk, bytesRead);
                bytesRead += chunk.byteLength;
                chunks += 1;
            }
            return {
                size,
                bytesRead,
                chunks,
            };
        },
        async readTextFile(path) {
            return browserDocumentStore.readText(path);
        },
        async fileExists(path) {
            return browserDocumentStore.exists(path);
        },
        getDocumentRevision(path) {
            return browserDocumentStore.getDocumentRevision(path);
        },
        onDocumentRevisionChanged(callback) {
            return browserDocumentStore.onDocumentRevisionChanged(callback);
        },
        async analyzePdfConformance(path) {
            return analyzeBrowserPdfConformance(path);
        },
        async validatePdfData(data) {
            return validateBrowserPdfData(data);
        },
        async validatePdfPath(path) {
            const data = await browserDocumentStore.read(path);
            return validateBrowserPdfData(data);
        },
        openPdfInDefaultAppData() {
            return Promise.resolve({
                success: false,
                error: BROWSER_DEFAULT_PDF_APP_UNSUPPORTED,
                unsupportedReason: 'requires-native-backend',
            });
        },
        openPdfInDefaultAppPath() {
            return Promise.resolve({
                success: false,
                error: BROWSER_DEFAULT_PDF_APP_UNSUPPORTED,
                unsupportedReason: 'requires-native-backend',
            });
        },
        printPdfData() {
            return Promise.resolve({
                success: false,
                error: BROWSER_NATIVE_PRINT_UNSUPPORTED,
                unsupportedReason: 'requires-native-backend',
            });
        },
        printPdfPath() {
            return Promise.resolve({
                success: false,
                error: BROWSER_NATIVE_PRINT_UNSUPPORTED,
                unsupportedReason: 'requires-native-backend',
            });
        },
        async writeFile(path, data) {
            clearSearchCaches();
            return browserDocumentStore.write(path, data);
        },
        async replaceWorkingCopyFromPath(workingCopyPath, sourcePath) {
            const bytes = await browserDocumentStore.read(sourcePath);
            clearSearchCaches(workingCopyPath);
            return browserDocumentStore.write(workingCopyPath, bytes);
        },
        async savePdfData(path, data) {
            const validation = await validateBrowserPdfData(data);
            if (!validation.isValid) {
                return validation;
            }

            await browserDocumentStore.write(path, data);
            const saved = await saveWorkingBytesToSource(path, browserLargeSaveHandleHintProvider);
            if (!saved) {
                return createCanceledSaveValidationResult(validation);
            }
            clearSearchCaches();
            return validation;
        },
        async savePdfDataChunks(path, totalBytes, chunks) {
            if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) {
                throw new Error('savePdfDataChunks.totalBytes must be a positive safe integer');
            }
            const collected: Uint8Array[] = [];
            let bytesRead = 0;
            for await (const chunk of chunks) {
                if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
                    throw new Error('savePdfDataChunks.chunks must yield non-empty Uint8Array chunks');
                }
                bytesRead += chunk.byteLength;
                if (bytesRead > totalBytes) {
                    throw new Error('savePdfDataChunks chunks exceed the declared total size');
                }
                collected.push(chunk);
            }
            if (bytesRead !== totalBytes) {
                throw new Error('savePdfDataChunks chunks did not match the declared total size');
            }
            const data = new Uint8Array(totalBytes);
            let offset = 0;
            for (const chunk of collected) {
                data.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return capability.savePdfData(path, data);
        },
        async writeDocxFile(path, data) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            await browserDocumentStore.write(path, bytes);
            const saveTarget = await browserDocumentStore.getSaveTarget(path);

            if (saveTarget.saveHandle) {
                await writeBytesToHandle(saveTarget.saveHandle, bytes);
            } else {
                await saveBytesToPickerOrDownload(bytes, {
                    suggestedName: ensureDocxExtension(saveTarget.saveName),
                    mimeType:
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    pickerTypes: buildDocxSaveTypes(),
                    downloadFallbackLabel: 'Saving documents',
                });
            }

            return true;
        },
        async createWorkingCopyFromData(fileName, data, originalPath) {
            const decryptedData = isPdfFileName(fileName)
                ? new Uint8Array(await stripBrowserPdfEncryption(data))
                : data;

            return createBrowserWorkingCopyFromBytes({
                fileName,
                data: decryptedData,
                mimeType: 'application/pdf',
                ...(originalPath && isBrowserDocumentRef(originalPath)
                    ? { sourceRef: originalPath }
                    : {}),
            });
        },
        async createWorkingCopyFromPath(sourcePath, originalPath) {
            const sourceEntry = await browserDocumentStore.requireEntry(sourcePath);
            const sourceRef =
                originalPath && isBrowserDocumentRef(originalPath)
                    ? originalPath
                    : (
                        sourceEntry.kind === 'working'
                            ? sourceEntry.sourceRef
                            : sourceEntry.ref
                    );
            if (sourceEntry.kind !== 'working') {
                const workingPath = await browserDocumentStore.cloneAsWorkingCopy(
                    sourceEntry.ref,
                    sourceEntry.fileName,
                );
                await decryptBrowserWorkingCopy(workingPath);
                browserDocumentStore.unload(sourcePath);
                return workingPath;
            }

            const workingPath = await browserDocumentStore.cloneStoredDocument(
                sourceEntry.ref,
                {
                    fileName: sourceEntry.fileName,
                    kind: 'working',
                    retention: 'transient',
                    ...(sourceRef && isBrowserDocumentRef(sourceRef)
                        ? { sourceRef }
                        : {}),
                    saveKind: 'pdf',
                    saveHandle: null,
                },
            );
            await decryptBrowserWorkingCopy(workingPath);
            return workingPath;
        },
        async saveFile(path) {
            const result = await saveWorkingBytesToSourceStructured(path, browserLargeSaveHandleHintProvider);
            if (result.ok) {
                clearSearchCaches();
            }
            return result.ok;
        },
        async saveFileStructured(path) {
            const result = await saveWorkingBytesToSourceStructured(path, browserLargeSaveHandleHintProvider);
            if (result.ok) {
                clearSearchCaches();
            }
            return result;
        },
        async cleanupFile(path) {
            const entry = await browserDocumentStore.ensureEntry(path);
            if (!entry) {
                return;
            }

            const sourceRef = entry.sourceRef ?? path;
            if (sourceRef !== path) {
                await browserDocumentStore.remove(path);
                await browserDocumentStore.cleanupDetachedDocument(sourceRef);
                clearSearchCaches(path);
                clearSearchCaches(sourceRef);
                return;
            }

            await browserDocumentStore.cleanupDetachedDocument(path);
            clearSearchCaches(path);
        },
        async cleanupOcrTemp(_path) {},
        setWindowTitle(title) {
            if (typeof document !== 'undefined') {
                document.title = title;
            }
            syncBrowserWindowTitle();
            return Promise.resolve();
        },
        showItemInFolder(_path) {
            return Promise.resolve(false);
        },
        showItemInFolderStructured(_path) {
            return Promise.resolve(createPlatformUnsupportedResult(
                'requires-native-backend',
                'Showing files in a folder requires the desktop app.',
            ));
        },
        recentFiles: {
            async get() {
                const recentFiles = await browserDocumentStore.recoverRecentFilesIfStorageMissing();
                const validatedFiles: IRecentFile[] = [];
                let shouldBackfillStorage = false;

                for (const file of recentFiles) {
                    const entry = await browserDocumentStore.ensureEntry(file.originalPath);
                    if (entry && entry.retention !== 'transient') {
                        const fileSize = typeof file.fileSize === 'number'
                            ? file.fileSize
                            : entry.fileSize;
                        shouldBackfillStorage ||= fileSize !== file.fileSize;
                        validatedFiles.push({
                            ...file,
                            fileSize,
                        });
                        continue;
                    }

                    await browserDocumentStore.removeRecentFile(file.originalPath);
                }

                if (shouldBackfillStorage) {
                    writeRecentFilesToStorage(validatedFiles);
                }

                return validatedFiles;
            },
            async remove(path) {
                await browserDocumentStore.removeRecentFile(path);
                clearSearchCaches(path);
            },
            async clear() {
                await browserDocumentStore.clearRecentFiles();
                clearSearchCaches();
            },
        },
        getPathForFile(file) {
            return browserDocumentStore.getRefForFile(file);
        },
        getPathsForFiles(files) {
            return files.map(file => browserDocumentStore.getRefForFile(file));
        },
        async createCombinedPdfFromFiles(files, options) {
            const refs: string[] = [];
            for (const file of files) {
                const ref = await browserDocumentStore.registerFile(file, {
                    kind: 'source',
                    retention: 'transient',
                    saveKind: 'generic',
                    saveHandle: null,
                });
                refs.push(ref);
            }

            try {
                return await createBrowserCombinedPdfFromPaths(refs, options);
            } finally {
                await cleanupTransientOpenRefs(refs);
            }
        },
    };

    return {
        ...capability,
        openPdfDialog: capability.openDocumentDialog,
        openPdfDirect: capability.openDocumentDirect,
        openPdfDirectBatch: capability.openDocumentDirectBatch,
    };
}
