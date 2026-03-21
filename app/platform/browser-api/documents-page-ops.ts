import {
    degrees,
    PDFDocument,
    PDFName,
} from 'pdf-lib';
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
    saveBytesToPickerOrDownload: (
        bytes: Uint8Array,
        options: {
            suggestedName: string;
            mimeType: string;
            pickerTypes: IFilePickerAcceptType[];
        },
    ) => Promise<ISaveBytesResult>;
}

export function createBrowserPageOps(
    options: ICreateBrowserPageOpsOptions,
): IPageOpsCapability['pageOps'] {
    const pageOps: IPageOpsCapability['pageOps'] = {
        async delete(workingCopyPath, pages) {
            const sourcePdf = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            const removeIndexes = new Set(pages.map((page) => page - 1));
            const nextPdf = await PDFDocument.create();
            const keptIndexes = sourcePdf
                .getPageIndices()
                .filter((index) => !removeIndexes.has(index));
            const keptPages = await nextPdf.copyPages(sourcePdf, keptIndexes);
            keptPages.forEach((page) => nextPdf.addPage(page));
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
            const sourcePdf = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            const nextPdf = await PDFDocument.create();
            const selectedIndexes = pages
                .map((page) => page - 1)
                .filter((index) => index >= 0 && index < sourcePdf.getPageCount());
            const copiedPages = await nextPdf.copyPages(sourcePdf, selectedIndexes);
            copiedPages.forEach((page) => nextPdf.addPage(page));
            const outputBytes = new Uint8Array(await nextPdf.save());
            const sourceName = getBrowserDocumentFileName(workingCopyPath).replace(
                /\.pdf$/iu,
                '',
            );
            const saveResult = await options.saveBytesToPickerOrDownload(outputBytes, {
                suggestedName: ensurePdfExtension(`${sourceName}-extract`),
                mimeType: 'application/pdf',
                pickerTypes: buildPdfSaveTypes(),
            });
            if (saveResult.canceled) {
                return {
                    success: false,
                    canceled: true,
                };
            }

            const destPath = await browserDocumentStore.createStoredDocument(
                saveResult.fileName,
                outputBytes,
                {
                    mimeType: 'application/pdf',
                    saveKind: 'pdf',
                    kind: 'source',
                    saveHandle: saveResult.handle,
                },
            );
            await browserDocumentStore.touchRecentFile(destPath);
            return {
                success: true,
                destPath,
            };
        },
        async reorder(workingCopyPath, newOrder) {
            const sourcePdf = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            const nextPdf = await PDFDocument.create();
            const copiedPages = await nextPdf.copyPages(
                sourcePdf,
                newOrder.map((page) => page - 1),
            );
            copiedPages.forEach((page) => nextPdf.addPage(page));
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
            const pdfDocument = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            for (const pageNumber of pages) {
                const page = pdfDocument.getPage(pageNumber - 1);
                if (!page) {
                    continue;
                }

                const currentRotation = page.getRotation().angle;
                page.setRotation(
                    degrees(((currentRotation + angle) % 360) as 0 | 90 | 180 | 270),
                );
            }
            await browserDocumentStore.write(
                workingCopyPath,
                new Uint8Array(await pdfDocument.save()),
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: pdfDocument.getPageCount(),
            };
        },
        async crop(workingCopyPath, pages, margins) {
            const pdfDocument = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            for (const pageNumber of pages) {
                const page = pdfDocument.getPage(pageNumber - 1);
                if (!page) {
                    continue;
                }

                const mediaBox = page.getMediaBox();
                const cropX = mediaBox.x + margins.left;
                const cropY = mediaBox.y + margins.bottom;
                const cropWidth = mediaBox.width - margins.left - margins.right;
                const cropHeight = mediaBox.height - margins.top - margins.bottom;
                if (cropWidth <= 0 || cropHeight <= 0) {
                    continue;
                }

                page.setCropBox(cropX, cropY, cropWidth, cropHeight);
            }
            await browserDocumentStore.write(
                workingCopyPath,
                new Uint8Array(await pdfDocument.save()),
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: pdfDocument.getPageCount(),
            };
        },
        async removeCrop(workingCopyPath, pages) {
            const pdfDocument = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            for (const pageNumber of pages) {
                const page = pdfDocument.getPage(pageNumber - 1);
                if (!page) {
                    continue;
                }

                const mediaBox = page.getMediaBox();
                const cropBox = page.getCropBox();
                if (
                    cropBox.x === mediaBox.x &&
                    cropBox.y === mediaBox.y &&
                    cropBox.width === mediaBox.width &&
                    cropBox.height === mediaBox.height
                ) {
                    page.node.delete(PDFName.of('CropBox'));
                    continue;
                }

                page.setCropBox(
                    mediaBox.x,
                    mediaBox.y,
                    mediaBox.width,
                    mediaBox.height,
                );
            }
            await browserDocumentStore.write(
                workingCopyPath,
                new Uint8Array(await pdfDocument.save()),
            );
            options.clearSearchCaches();
            return {
                success: true,
                pageCount: pdfDocument.getPageCount(),
            };
        },
        async getPageGeometry(workingCopyPath, pageNumber): Promise<IPageGeometry> {
            const pdfDocument = await PDFDocument.load(
                await browserDocumentStore.read(workingCopyPath),
            );
            const page = pdfDocument.getPage(pageNumber - 1);
            if (!page) {
                throw new Error(`Page ${pageNumber} not found`);
            }

            const mediaBox = page.getMediaBox();
            const resolvedCropBox = page.getCropBox();
            const cropBox =
                resolvedCropBox.x === mediaBox.x &&
                resolvedCropBox.y === mediaBox.y &&
                resolvedCropBox.width === mediaBox.width &&
                resolvedCropBox.height === mediaBox.height
                    ? null
                    : resolvedCropBox;

            return {
                mediaBox: {
                    x: mediaBox.x,
                    y: mediaBox.y,
                    width: mediaBox.width,
                    height: mediaBox.height,
                },
                cropBox: cropBox
                    ? {
                        x: cropBox.x,
                        y: cropBox.y,
                        width: cropBox.width,
                        height: cropBox.height,
                    }
                    : null,
                rotation: page.getRotation().angle,
            };
        },
    };

    return pageOps;
}
