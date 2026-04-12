import type { IPageOpsCapability } from '@contracts/platform-api';
import type { IPageGeometry } from '@contracts/shared';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browser-document-store';
import {
    buildPdfSaveTypes,
    ensurePdfExtension,
} from '@app/platform/browser-api/common';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/common';
import {
    BrowserPageOpsWorkerUnavailableError,
    canUseBrowserPageOpsWorker,
    runBrowserPageOpsWorkerRequest,
} from '@app/platform/browser-api/browser-page-ops-worker-client';
import type {
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    TBrowserPageOpsWorkerRequestType,
} from '@app/platform/browser-api/browser-page-ops-worker.types';
import {
    cropPdfBytes,
    deletePdfPages,
    extractPdfPages,
    getPageGeometryFromPdfBytes,
    insertPdfPages,
    removeCropPdfBytes,
    reorderPdfPages,
    rotatePdfBytes,
} from '@app/platform/browser-api/browser-page-ops-core';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';

interface IPickedBrowserFile {
    file: File;
    handle?: FileSystemFileHandle | null;
}

interface ISaveBytesResult {
    canceled: boolean;
    fileName: string;
    handle?: FileSystemFileHandle | null;
}

interface IBrowserPageOpProgressOptions {requestId?: string;}

interface ICreateBrowserPageOpsOptions {
    clearSearchCaches: () => void;
    openInputAccept: string;
    pickFiles: (options: {
        accept: string;
        multiple?: boolean;
        pickerTypes?: IFilePickerAcceptType[];
    }) => Promise<IPickedBrowserFile[]>;
    buildOpenPdfPickerTypes: () => IFilePickerAcceptType[];
    createCombinedPdfFromPaths: (
        paths: string[],
        progressOptions?: IBrowserPageOpProgressOptions,
    ) => Promise<Uint8Array>;
    pickSaveTarget: (options: {
        suggestedName: string;
        pickerTypes: IFilePickerAcceptType[];
    }) => Promise<ISaveBytesResult>;
    saveBytesToPickerOrDownload: (
        bytes: Uint8Array,
        options: {
            suggestedName: string;
            mimeType: string;
            pickerTypes: IFilePickerAcceptType[];
        },
    ) => Promise<ISaveBytesResult>;
    writeBytesToHandle: (
        handle: FileSystemFileHandle,
        data: Uint8Array,
    ) => Promise<void>;
}

const BROWSER_PAGE_OP_PDF_MAX_BYTES = 64 * 1024 * 1024;
const BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;
const BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES = 128 * 1024 * 1024;
const BROWSER_PAGE_OP_INSERT_MAX_BYTES = BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES;
const BROWSER_PAGE_OP_GEOMETRY_MAX_BYTES = 128 * 1024 * 1024;
const BROWSER_PAGE_OP_COMBINED_INPUT_MAX_BYTES = 64 * 1024 * 1024;
const BROWSER_PAGE_OP_INSERT_WORKING_SET_MAX_BYTES = 96 * 1024 * 1024;

function buildBrowserPageOpLimitError(label: string, maxBytes: number) {
    return new Error(
        `${label} is unavailable in the browser for PDFs larger than ${Math.floor(maxBytes / (1024 * 1024))}MB`,
    );
}

function buildBrowserPageOpJobLimitError(label: string, maxBytes: number) {
    return new Error(
        `${label} is unavailable in the browser for jobs larger than ${Math.floor(maxBytes / (1024 * 1024))}MB`,
    );
}

export function createBrowserPageOps(
    options: ICreateBrowserPageOpsOptions,
): IPageOpsCapability['pageOps'] {
    async function ensurePdfWithinBudget(
        path: string,
        label: string,
        maxBytes = BROWSER_PAGE_OP_PDF_MAX_BYTES,
    ) {
        const { size } = await browserDocumentStore.stat(path);
        if (size > maxBytes) {
            throw buildBrowserPageOpLimitError(label, maxBytes);
        }
    }

    async function ensureCombinedInputsWithinBudget(paths: string[], label: string) {
        let totalBytes = 0;
        for (let index = 0; index < paths.length; index += 1) {
            if (index > 0) {
                await yieldToBrowser();
            }
            const { size } = await browserDocumentStore.stat(paths[index]!);
            totalBytes += size;
            if (totalBytes > BROWSER_PAGE_OP_COMBINED_INPUT_MAX_BYTES) {
                throw buildBrowserPageOpLimitError(label, BROWSER_PAGE_OP_COMBINED_INPUT_MAX_BYTES);
            }
        }
    }

    async function getCombinedInputBytes(paths: string[]) {
        let totalBytes = 0;
        for (let index = 0; index < paths.length; index += 1) {
            if (index > 0) {
                await yieldToBrowser();
            }
            const { size } = await browserDocumentStore.stat(paths[index]!);
            totalBytes += size;
        }
        return totalBytes;
    }

    async function readWorkingCopyBytes(path: string) {
        await yieldToBrowser();
        return browserDocumentStore.read(path);
    }

    async function runDirectPdfOperation<T>(
        run: () => Promise<T>,
    ) {
        await yieldToBrowser();
        const result = await run();
        await yieldToBrowser();
        return result;
    }

    async function runWorkerBackedPdfOperation<K extends TBrowserPageOpsWorkerRequestType>(options: {
        path: string;
        label: string;
        maxBytes: number;
        type: K;
        createPayload: (data: Uint8Array) => IBrowserPageOpsWorkerRequestMap[K];
        runDirect: (data: Uint8Array) => Promise<IBrowserPageOpsWorkerResultMap[K]>;
    }) {
        await ensurePdfWithinBudget(
            options.path,
            options.label,
            options.maxBytes,
        );

        const { size } = await browserDocumentStore.stat(options.path);
        const workerAvailable = canUseBrowserPageOpsWorker();
        if (
            !workerAvailable
            && size > BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES
        ) {
            throw buildBrowserPageOpLimitError(
                options.label,
                BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES,
            );
        }

        const data = await readWorkingCopyBytes(options.path);
        if (workerAvailable) {
            try {
                return await runBrowserPageOpsWorkerRequest(
                    options.type,
                    options.createPayload(data),
                );
            } catch (error) {
                if (!(error instanceof BrowserPageOpsWorkerUnavailableError)) {
                    throw error;
                }
            }
        }

        if (size > BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES) {
            throw buildBrowserPageOpLimitError(
                options.label,
                BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES,
            );
        }

        return runDirectPdfOperation(() => options.runDirect(data));
    }

    const pageOps: IPageOpsCapability['pageOps'] = {
        async delete(workingCopyPath, pages) {
            const result = await runWorkerBackedPdfOperation({
                path: workingCopyPath,
                label: 'Deleting pages',
                maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
                type: 'deletePages',
                createPayload: (data) => ({
                    data,
                    pages,
                }),
                runDirect: (data) => deletePdfPages(data, pages),
            });
            await browserDocumentStore.write(
                workingCopyPath,
                result.data,
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: result.pageCount,
            };
        },
        async extract(workingCopyPath, pages) {
            const sourceName = getBrowserDocumentFileName(workingCopyPath).replace(
                /\.pdf$/iu,
                '',
            );
            const saveTarget = await options.pickSaveTarget({
                suggestedName: ensurePdfExtension(`${sourceName}-extract`),
                pickerTypes: buildPdfSaveTypes(),
            });
            if (saveTarget.canceled) {
                return {
                    success: false,
                    canceled: true,
                };
            }

            const result = await runWorkerBackedPdfOperation({
                path: workingCopyPath,
                label: 'Extracting pages',
                maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
                type: 'extractPages',
                createPayload: (data) => ({
                    data,
                    pages,
                }),
                runDirect: (data) => extractPdfPages(data, pages),
            });
            const outputBytes = result.data;

            if (saveTarget.handle) {
                await options.writeBytesToHandle(saveTarget.handle, outputBytes);
            } else {
                const saveResult = await options.saveBytesToPickerOrDownload(outputBytes, {
                    suggestedName: ensurePdfExtension(saveTarget.fileName),
                    mimeType: 'application/pdf',
                    pickerTypes: buildPdfSaveTypes(),
                });
                if (saveResult.canceled) {
                    return {
                        success: false,
                        canceled: true,
                    };
                }
            }

            const normalizedFileName = ensurePdfExtension(saveTarget.fileName);
            const destPath = await browserDocumentStore.createStoredDocument(
                normalizedFileName,
                saveTarget.handle ? new Uint8Array() : outputBytes,
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'source',
                    saveHandle: saveTarget.handle,
                    storageMode: saveTarget.handle ? 'handle' : undefined,
                },
            );
            if (saveTarget.handle) {
                await browserDocumentStore.replaceWithHandleBackedDocument(destPath, {
                    fileSize: outputBytes.byteLength,
                    saveHandle: saveTarget.handle,
                    saveName: normalizedFileName,
                });
            }
            await browserDocumentStore.touchRecentFile(destPath);
            return {
                success: true,
                destPath,
            };
        },
        async reorder(workingCopyPath, newOrder) {
            const result = await runWorkerBackedPdfOperation({
                path: workingCopyPath,
                label: 'Reordering pages',
                maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
                type: 'reorderPages',
                createPayload: (data) => ({
                    data,
                    newOrder,
                }),
                runDirect: (data) => reorderPdfPages(data, newOrder),
            });
            await browserDocumentStore.write(
                workingCopyPath,
                result.data,
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: result.pageCount,
            };
        },
        async insert(workingCopyPath, _totalPages, afterPage) {
            const pickedFiles = await options.pickFiles({
                accept: options.openInputAccept,
                multiple: true,
                pickerTypes: options.buildOpenPdfPickerTypes(),
            });
            if (pickedFiles.length === 0) {
                return {
                    success: false,
                    canceled: true,
                };
            }

            const sourcePaths = await Promise.all(
                pickedFiles.map(async (picked) =>
                    browserDocumentStore.registerFile(picked.file, {
                        kind: 'source',
                        retention: 'transient',
                        saveKind: 'generic',
                        saveHandle: picked.handle ?? null,
                    }),
                ),
            );

            try {
                return await pageOps.insertFile(
                    workingCopyPath,
                    0,
                    afterPage,
                    sourcePaths,
                );
            } finally {
                await Promise.allSettled(
                    sourcePaths.map(async (sourcePath) => {
                        await browserDocumentStore.cleanupDetachedDocument(sourcePath);
                    }),
                );
            }
        },
        async insertFile(workingCopyPath, _totalPages, afterPage, sourcePaths, requestId) {
            await ensurePdfWithinBudget(
                workingCopyPath,
                'Inserting pages',
                BROWSER_PAGE_OP_INSERT_MAX_BYTES,
            );
            await ensureCombinedInputsWithinBudget(sourcePaths, 'Inserting pages');
            const [
                { size },
                totalInputBytes,
            ] = await Promise.all([
                browserDocumentStore.stat(workingCopyPath),
                getCombinedInputBytes(sourcePaths),
            ]);
            if (size + totalInputBytes > BROWSER_PAGE_OP_INSERT_WORKING_SET_MAX_BYTES) {
                throw buildBrowserPageOpJobLimitError(
                    'Inserting pages',
                    BROWSER_PAGE_OP_INSERT_WORKING_SET_MAX_BYTES,
                );
            }
            const workerAvailable = canUseBrowserPageOpsWorker();
            if (
                !workerAvailable
                && size > BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES
            ) {
                throw buildBrowserPageOpLimitError(
                    'Inserting pages',
                    BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES,
                );
            }
            const destinationData = await readWorkingCopyBytes(workingCopyPath);
            const insertionData = sourcePaths.length === 1
                && /\.pdf$/iu.test(getBrowserDocumentFileName(sourcePaths[0]!))
                ? await browserDocumentStore.read(sourcePaths[0]!)
                : await options.createCombinedPdfFromPaths(sourcePaths, {requestId: requestId ?? `browser-page-op-insert-${crypto.randomUUID()}`});

            let result: IBrowserPageOpsWorkerResultMap['insertPages'];
            if (workerAvailable) {
                try {
                    result = await runBrowserPageOpsWorkerRequest('insertPages', {
                        data: destinationData,
                        insertionData,
                        afterPage,
                    });
                } catch (error) {
                    if (!(error instanceof BrowserPageOpsWorkerUnavailableError)) {
                        throw error;
                    }
                    if (size > BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES) {
                        throw buildBrowserPageOpLimitError(
                            'Inserting pages',
                            BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES,
                        );
                    }
                    result = await runDirectPdfOperation(() => insertPdfPages(
                        destinationData,
                        insertionData,
                        afterPage,
                    ));
                }
            } else {
                result = await runDirectPdfOperation(() => insertPdfPages(
                    destinationData,
                    insertionData,
                    afterPage,
                ));
            }
            await browserDocumentStore.write(
                workingCopyPath,
                result.data,
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: result.pageCount,
            };
        },
        async rotate(workingCopyPath, pages, angle) {
            const result = await runWorkerBackedPdfOperation({
                path: workingCopyPath,
                label: 'Rotating pages',
                maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
                type: 'rotate',
                createPayload: (data) => ({
                    data,
                    pages,
                    angle,
                }),
                runDirect: (data) => rotatePdfBytes(data, pages, angle),
            });
            await browserDocumentStore.write(
                workingCopyPath,
                result.data,
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: result.pageCount,
            };
        },
        async crop(workingCopyPath, pages, margins) {
            const result = await runWorkerBackedPdfOperation({
                path: workingCopyPath,
                label: 'Cropping pages',
                maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
                type: 'crop',
                createPayload: (data) => ({
                    data,
                    pages,
                    margins,
                }),
                runDirect: (data) => cropPdfBytes(data, pages, margins),
            });
            await browserDocumentStore.write(
                workingCopyPath,
                result.data,
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: result.pageCount,
            };
        },
        async removeCrop(workingCopyPath, pages) {
            const result = await runWorkerBackedPdfOperation({
                path: workingCopyPath,
                label: 'Removing crop',
                maxBytes: BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES,
                type: 'removeCrop',
                createPayload: (data) => ({
                    data,
                    pages,
                }),
                runDirect: (data) => removeCropPdfBytes(data, pages),
            });
            await browserDocumentStore.write(
                workingCopyPath,
                result.data,
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: result.pageCount,
            };
        },
        async getPageGeometry(workingCopyPath, pageNumber): Promise<IPageGeometry> {
            return runWorkerBackedPdfOperation({
                path: workingCopyPath,
                label: 'Inspecting page geometry',
                maxBytes: BROWSER_PAGE_OP_GEOMETRY_MAX_BYTES,
                type: 'getPageGeometry',
                createPayload: (data) => ({
                    data,
                    pageNumber,
                }),
                runDirect: (data) => getPageGeometryFromPdfBytes(data, pageNumber),
            });
        },
    };

    return pageOps;
}
