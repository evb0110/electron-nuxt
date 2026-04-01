import { PDFDocument } from 'pdf-lib';
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
    getPageGeometryFromPdfBytes,
    removeCropPdfBytes,
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

interface ICreateBrowserPageOpsOptions {
    clearSearchCaches: () => void;
    openInputAccept: string;
    pickFiles: (options: {
        accept: string;
        multiple?: boolean;
        pickerTypes?: IFilePickerAcceptType[];
    }) => Promise<IPickedBrowserFile[]>;
    buildOpenPdfPickerTypes: () => IFilePickerAcceptType[];
    createCombinedPdfFromPaths: (paths: string[]) => Promise<Uint8Array>;
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

const BROWSER_PAGE_OP_PDF_MAX_BYTES = 48 * 1024 * 1024;
const BROWSER_PAGE_OP_DIRECT_FALLBACK_MAX_BYTES = 48 * 1024 * 1024;
const BROWSER_PAGE_OP_IN_PLACE_MUTATION_MAX_BYTES = 128 * 1024 * 1024;
const BROWSER_PAGE_OP_GEOMETRY_MAX_BYTES = 128 * 1024 * 1024;
const BROWSER_PAGE_OP_COMBINED_INPUT_MAX_BYTES = 64 * 1024 * 1024;

function buildBrowserPageOpLimitError(label: string, maxBytes: number) {
    return new Error(
        `${label} is unavailable in the browser for PDFs larger than ${Math.floor(maxBytes / (1024 * 1024))}MB`,
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

    async function readWorkingCopyBytes(path: string) {
        await yieldToBrowser();
        return browserDocumentStore.read(path);
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
        const data = await readWorkingCopyBytes(options.path);
        if (canUseBrowserPageOpsWorker()) {
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

        return options.runDirect(data);
    }

    const pageOps: IPageOpsCapability['pageOps'] = {
        async delete(workingCopyPath, pages) {
            await ensurePdfWithinBudget(workingCopyPath, 'Deleting pages');
            await yieldToBrowser();
            const sourcePdf = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            const removeIndexes = new Set(pages.map((page) => page - 1));
            const nextPdf = await PDFDocument.create();
            const keptIndexes = sourcePdf
                .getPageIndices()
                .filter((index) => !removeIndexes.has(index));
            await yieldToBrowser();
            const keptPages = await nextPdf.copyPages(sourcePdf, keptIndexes);
            keptPages.forEach((page) => nextPdf.addPage(page));
            await yieldToBrowser();
            await browserDocumentStore.write(
                workingCopyPath,
                new Uint8Array(await nextPdf.save()),
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: keptPages.length,
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

            await ensurePdfWithinBudget(workingCopyPath, 'Extracting pages');
            await yieldToBrowser();
            const sourcePdf = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            const nextPdf = await PDFDocument.create();
            const selectedIndexes = pages
                .map((page) => page - 1)
                .filter((index) => index >= 0 && index < sourcePdf.getPageCount());
            await yieldToBrowser();
            const copiedPages = await nextPdf.copyPages(sourcePdf, selectedIndexes);
            copiedPages.forEach((page) => nextPdf.addPage(page));
            await yieldToBrowser();
            const outputBytes = new Uint8Array(await nextPdf.save());

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

            const destPath = await browserDocumentStore.createStoredDocument(
                ensurePdfExtension(saveTarget.fileName),
                outputBytes,
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'source',
                    saveHandle: saveTarget.handle,
                },
            );
            await browserDocumentStore.touchRecentFile(destPath);
            return {
                success: true,
                destPath,
            };
        },
        async reorder(workingCopyPath, newOrder) {
            await ensurePdfWithinBudget(workingCopyPath, 'Reordering pages');
            await yieldToBrowser();
            const sourcePdf = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            const nextPdf = await PDFDocument.create();
            await yieldToBrowser();
            const copiedPages = await nextPdf.copyPages(
                sourcePdf,
                newOrder.map((page) => page - 1),
            );
            copiedPages.forEach((page) => nextPdf.addPage(page));
            await yieldToBrowser();
            await browserDocumentStore.write(
                workingCopyPath,
                new Uint8Array(await nextPdf.save()),
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: copiedPages.length,
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
        async insertFile(workingCopyPath, _totalPages, afterPage, sourcePaths) {
            await ensurePdfWithinBudget(workingCopyPath, 'Inserting pages');
            await ensureCombinedInputsWithinBudget(sourcePaths, 'Inserting pages');
            await yieldToBrowser();
            const destinationPdf = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            const insertionPdf = await PDFDocument.load(
                await options.createCombinedPdfFromPaths(sourcePaths),
            );
            const nextPdf = await PDFDocument.create();
            const beforeIndexes = destinationPdf
                .getPageIndices()
                .filter((index) => index < afterPage);
            const afterIndexes = destinationPdf
                .getPageIndices()
                .filter((index) => index >= afterPage);
            await yieldToBrowser();
            const beforePages = await nextPdf.copyPages(
                destinationPdf,
                beforeIndexes,
            );
            const insertedPages = await nextPdf.copyPages(
                insertionPdf,
                insertionPdf.getPageIndices(),
            );
            const afterPages = await nextPdf.copyPages(destinationPdf, afterIndexes);
            beforePages.forEach((page) => nextPdf.addPage(page));
            insertedPages.forEach((page) => nextPdf.addPage(page));
            afterPages.forEach((page) => nextPdf.addPage(page));
            await yieldToBrowser();
            await browserDocumentStore.write(
                workingCopyPath,
                new Uint8Array(await nextPdf.save()),
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: nextPdf.getPageCount(),
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
