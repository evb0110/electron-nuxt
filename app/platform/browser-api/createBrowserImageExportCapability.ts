import UTIF from 'utif';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    range,
    sumBy,
} from 'es-toolkit/math';
import type { IImageExportCapability } from '@contracts/electronApiDocuments';
import {
    browserDocumentStore,
    getBrowserDocumentFileName,
} from '@app/platform/browserDocumentStore';
import {
    createPdfjsDocumentInitFromBrowserDocument,
    getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
import { EXPORT_RENDER_SCALE } from '@app/platform/browser-api/browserImageExportConfig';
import { ensurePdfExtension } from '@app/platform/browser-api/browserFileName';
import { toUint8Array } from '@app/platform/browser-api/browserBytes';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import {
    pickSaveTarget,
    saveBytesToPickerOrDownload,
    writeBytesToHandle,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import type { IFilePickerAcceptType } from '@app/platform/browser-api/browserFileAccepts';
import {
    buildTiffImageIfd,
    encodeTiffIfds,
} from '@pdf-core';

type TBrowserImageExportFormat = 'jpeg' | 'png' | 'tiff';

interface IRenderedPdfPage {
    pageNumber: number;
    rgba: Uint8Array;
    width: number;
    height: number;
}

interface ITiffPageDescriptor {
    pageNumber: number;
    width: number;
    height: number;
    dataLength: number;
}

const BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES = 64 * 1024 * 1024;
const BROWSER_IMAGE_EXPORT_PICKER_TYPES: IFilePickerAcceptType[] = [
    {
        description: 'JPEG Images',
        accept: { 'image/jpeg': [
            '.jpg',
            '.jpeg',
        ] },
    },
    {
        description: 'PNG Images',
        accept: { 'image/png': ['.png'] },
    },
    {
        description: 'TIFF Images',
        accept: { 'image/tiff': [
            '.tif',
            '.tiff',
        ] },
    },
];

interface IUtifBinaryWriter {
    writeUint(buffer: Uint8Array, offset: number, value: number): void;
    writeUshort(buffer: Uint8Array, offset: number, value: number): void;
}

interface IUtifEncoderModule {
    _binBE: IUtifBinaryWriter;
    _writeIFD(
        bin: IUtifBinaryWriter,
        data: Uint8Array,
        offset: number,
        ifd: Record<string, unknown>,
    ): [number, number];
    ttypes: Record<number, number | undefined>;
}

const UTIF_ENCODER = UTIF as typeof UTIF & IUtifEncoderModule;

interface IRenderedPdfPageCanvas {
    pageNumber: number;
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
}

function releaseCanvas(canvas: HTMLCanvasElement) {
    canvas.width = 0;
    canvas.height = 0;
}

function resolveBrowserImageExportExtension(format: TBrowserImageExportFormat) {
    if (format === 'jpeg') {
        return '.jpg';
    }
    if (format === 'tiff') {
        return '.tif';
    }
    return '.png';
}

function resolveBrowserImageMimeType(format: TBrowserImageExportFormat) {
    if (format === 'jpeg') {
        return 'image/jpeg';
    }
    if (format === 'tiff') {
        return 'image/tiff';
    }
    return 'image/png';
}

function resolveBrowserImageExportFormat(fileName: string): TBrowserImageExportFormat {
    if (/\.png$/iu.test(fileName)) {
        return 'png';
    }
    if (/\.(?:tif|tiff)$/iu.test(fileName)) {
        return 'tiff';
    }
    return 'jpeg';
}

function normalizeBrowserImageExportFileName(
    fileName: string,
    fallbackFormat: TBrowserImageExportFormat,
) {
    const trimmedFileName = fileName.trim();
    if (/\.(?:jpg|jpeg|png|tif|tiff)$/iu.test(trimmedFileName)) {
        return trimmedFileName;
    }
    return `${trimmedFileName}${resolveBrowserImageExportExtension(fallbackFormat)}`;
}

function buildBrowserImageExportFileName(
    pageNumber: number,
    format: TBrowserImageExportFormat = 'jpeg',
) {
    return `page-${String(pageNumber).padStart(3, '0')}${resolveBrowserImageExportExtension(format)}`;
}

async function withRenderedPdfPageCanvas<T>(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageNumber: number,
    callback: (rendered: IRenderedPdfPageCanvas) => Promise<T> | T,
): Promise<T> {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: EXPORT_RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Canvas 2D context is unavailable');
    }

    await page.render({
        canvas,
        canvasContext: context,
        viewport,
    }).promise;

    try {
        return await callback({
            pageNumber,
            canvas,
            context,
        });
    } finally {
        try {
            await Promise.resolve(page.cleanup?.());
        } catch {
            // Cleanup is best effort.
        }
        releaseCanvas(canvas);
    }
}

async function renderPdfPage(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageNumber: number,
): Promise<IRenderedPdfPage> {
    return withRenderedPdfPageCanvas(
        pdfDocument,
        pageNumber,
        ({
            canvas,
            context,
        }) => {
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            return {
                pageNumber,
                rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
                width: canvas.width,
                height: canvas.height,
            };
        },
    );
}

async function canvasToBlob(
    canvas: HTMLCanvasElement,
    mimeType: string,
    quality?: number,
) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to export rendered page'));
                return;
            }

            resolve(blob);
        }, mimeType, quality);
    });
}

async function renderPdfPageToImageBytes(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageNumber: number,
    format: TBrowserImageExportFormat,
) {
    if (format === 'tiff') {
        const rendered = await renderPdfPage(pdfDocument, pageNumber);
        return {
            bytes: encodeMultiPageTiff([{
                rgba: rendered.rgba,
                width: rendered.width,
                height: rendered.height,
            }]),
            mimeType: resolveBrowserImageMimeType(format),
        };
    }

    return withRenderedPdfPageCanvas(pdfDocument, pageNumber, async ({ canvas }) => {
        const imageBlob = await canvasToBlob(
            canvas,
            resolveBrowserImageMimeType(format),
            format === 'jpeg' ? 0.92 : undefined,
        );
        return {
            bytes: new Uint8Array(await imageBlob.arrayBuffer()),
            mimeType: resolveBrowserImageMimeType(format),
        };
    });
}

async function collectTiffPageDescriptors(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageNumbers: number[],
) {
    const descriptors: ITiffPageDescriptor[] = [];

    for (const pageNumber of pageNumbers) {
        const page = await pdfDocument.getPage(pageNumber);
        const viewport = page.getViewport({ scale: EXPORT_RENDER_SCALE });
        descriptors.push({
            pageNumber,
            width: Math.ceil(viewport.width),
            height: Math.ceil(viewport.height),
            dataLength: Math.ceil(viewport.width) * Math.ceil(viewport.height) * 4,
        });

        try {
            await Promise.resolve(page.cleanup?.());
        } catch {
            // Cleanup is best effort.
        }

        if (descriptors.length % 2 === 0) {
            await yieldToBrowser();
        }
    }

    return descriptors;
}

function alignOffset(offset: number, alignment: number) {
    if (alignment <= 1) {
        return offset;
    }

    const remainder = offset % alignment;
    return remainder === 0 ? offset : offset + (alignment - remainder);
}

function encodeMultiPageTiffHeader(pageDescriptors: ITiffPageDescriptor[]) {
    let firstDataOffset = 0;
    let header = new Uint8Array();

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const pageOffsets = pageDescriptors.map(() => 0);
        let cursor = firstDataOffset;
        for (let index = 0; index < pageDescriptors.length; index += 1) {
            const descriptor = pageDescriptors[index]!;
            pageOffsets[index] = cursor;
            cursor += descriptor.dataLength;
        }

        header = toUint8Array(encodeTiffIfds(
            pageDescriptors.map((page, index) =>
                buildTiffImageIfd(page, pageOffsets[index] ?? 0),
            ),
            UTIF_ENCODER,
        ));

        const nextFirstDataOffset = alignOffset(header.length, 8);
        if (nextFirstDataOffset === firstDataOffset) {
            break;
        }
        firstDataOffset = nextFirstDataOffset;
    }

    const finalFirstDataOffset = alignOffset(header.length, 8);
    const totalByteLength = finalFirstDataOffset + sumBy(pageDescriptors, descriptor => descriptor.dataLength);
    if (totalByteLength > 0xFFFFFFFF) {
        throw new Error('Multi-page TIFF export exceeds the Classic TIFF 4GB limit');
    }

    return {
        header,
        firstDataOffset: finalFirstDataOffset,
    };
}

function createMultiPageTiffOutput(pageDescriptors: ITiffPageDescriptor[]) {
    const {
        header,
        firstDataOffset,
    } = encodeMultiPageTiffHeader(pageDescriptors);
    const output = new Uint8Array(
        firstDataOffset + sumBy(pageDescriptors, descriptor => descriptor.dataLength),
    );
    output.set(header);
    return {
        output,
        firstDataOffset,
    };
}

async function encodeTiffToWritable(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageDescriptors: ITiffPageDescriptor[],
    handle: FileSystemFileHandle,
) {
    const writable = await handle.createWritable();
    try {
        const {
            header,
            firstDataOffset,
        } = encodeMultiPageTiffHeader(pageDescriptors);
        await writable.write(header);
        const paddingLength = firstDataOffset - header.length;
        if (paddingLength > 0) {
            await writable.write(new Uint8Array(paddingLength));
        }

        for (const descriptor of pageDescriptors) {
            const rendered = await renderPdfPage(pdfDocument, descriptor.pageNumber);
            if (rendered.rgba.byteLength !== descriptor.dataLength) {
                throw new Error('Rendered TIFF page size did not match the expected descriptor size');
            }

            await writable.write(toUint8Array(rendered.rgba));
            await yieldToBrowser();
        }

        await writable.close();
        return header.length
            + Math.max(0, firstDataOffset - header.length)
            + sumBy(pageDescriptors, descriptor => descriptor.dataLength);
    } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
    }
}

async function encodeTiffToBytes(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageDescriptors: ITiffPageDescriptor[],
) {
    const {
        output,
        firstDataOffset,
    } = createMultiPageTiffOutput(pageDescriptors);
    let offset = firstDataOffset;

    for (const descriptor of pageDescriptors) {
        const rendered = await renderPdfPage(pdfDocument, descriptor.pageNumber);
        if (rendered.rgba.byteLength !== descriptor.dataLength) {
            throw new Error('Rendered TIFF page size did not match the expected descriptor size');
        }

        output.set(rendered.rgba, offset);
        offset += descriptor.dataLength;
        await yieldToBrowser();
    }

    return output;
}

async function loadPdfDocument(path: string) {
    const pdfjsLib = await getPdfjsLib();
    const loadingTask = pdfjsLib.getDocument(
        await createPdfjsDocumentInitFromBrowserDocument(pdfjsLib, path),
    );
    const pdfDocument = await loadingTask.promise;
    return {
        pdfDocument,
        destroy: async () => {
            await pdfDocument.destroy();
        },
    };
}

function getTargetPages(pdfDocument: { numPages: number }, pageNumbers?: number[]) {
    const targetPages = (
        pageNumbers?.length
            ? pageNumbers
            : range(1, pdfDocument.numPages + 1)
    ).filter((pageNumber) => pageNumber >= 1 && pageNumber <= pdfDocument.numPages);

    return targetPages;
}

export function createBrowserImageExportCapability(): IImageExportCapability {
    return {
        async exportPdfToImages(workingCopyPath, pageNumbers) {
            const pdfDocument = await loadPdfDocument(workingCopyPath);
            const targetPages = getTargetPages(pdfDocument.pdfDocument, pageNumbers);
            const outputRefs: string[] = [];

            if (targetPages.length === 0) {
                await pdfDocument.destroy();
                return {
                    success: false,
                    canceled: true,
                };
            }

            try {
                for (let index = 0; index < targetPages.length; index += 1) {
                    const pageNumber = targetPages[index]!;
                    const saveTarget = await pickSaveTarget({
                        suggestedName: buildBrowserImageExportFileName(pageNumber),
                        pickerTypes: BROWSER_IMAGE_EXPORT_PICKER_TYPES,
                    });
                    if (saveTarget.canceled) {
                        await Promise.allSettled(
                            outputRefs.map(async (outputRef) => {
                                await browserDocumentStore.cleanupDetachedDocument(outputRef);
                            }),
                        );
                        return {
                            success: false,
                            canceled: true,
                        };
                    }

                    const format = resolveBrowserImageExportFormat(saveTarget.fileName);
                    const renderedPage = await renderPdfPageToImageBytes(
                        pdfDocument.pdfDocument,
                        pageNumber,
                        format,
                    );
                    let saveName = normalizeBrowserImageExportFileName(saveTarget.fileName, format);
                    let saveHandle = saveTarget.handle ?? null;

                    if (saveTarget.handle) {
                        await writeBytesToHandle(saveTarget.handle, renderedPage.bytes);
                    } else {
                        const downloadResult = await saveBytesToPickerOrDownload(renderedPage.bytes, {
                            suggestedName: saveName,
                            mimeType: renderedPage.mimeType,
                            pickerTypes: BROWSER_IMAGE_EXPORT_PICKER_TYPES,
                        });
                        if (downloadResult.canceled) {
                            await Promise.allSettled(
                                outputRefs.map(async (outputRef) => {
                                    await browserDocumentStore.cleanupDetachedDocument(outputRef);
                                }),
                            );
                            return {
                                success: false,
                                canceled: true,
                            };
                        }
                        saveName = normalizeBrowserImageExportFileName(downloadResult.fileName, format);
                        saveHandle = downloadResult.handle ?? null;
                    }

                    const outputRef = await browserDocumentStore.createStoredDocument(
                        saveName,
                        saveHandle ? new Uint8Array() : renderedPage.bytes,
                        {
                            mimeType: renderedPage.mimeType,
                            saveKind: 'generic',
                            kind: 'output',
                            retention: 'transient',
                            saveHandle,
                            ...(saveHandle ? { storageMode: 'handle' as const } : {}),
                        },
                    );
                    if (saveHandle) {
                        await browserDocumentStore.replaceWithHandleBackedDocument(outputRef, {
                            fileSize: renderedPage.bytes.byteLength,
                            saveHandle,
                            saveName,
                        });
                    }
                    await browserDocumentStore.touchRecentFile(outputRef);
                    outputRefs.push(outputRef);

                    if (index % 2 === 1) {
                        await yieldToBrowser();
                    }
                }
            } catch (error) {
                await Promise.allSettled(
                    outputRefs.map(async (outputRef) => {
                        await browserDocumentStore.cleanupDetachedDocument(outputRef);
                    }),
                );
                throw error;
            } finally {
                await pdfDocument.destroy();
            }

            return {
                success: true,
                outputPaths: outputRefs,
            };
        },
        async exportPdfToMultiPageTiff(workingCopyPath, pageNumbers) {
            const pdfDocument = await loadPdfDocument(workingCopyPath);
            const targetPages = getTargetPages(pdfDocument.pdfDocument, pageNumbers);
            const outputFileName = ensurePdfExtension(
                getBrowserDocumentFileName(workingCopyPath).replace(/\.pdf$/iu, ''),
            ).replace(/\.pdf$/iu, '.tiff');

            if (targetPages.length === 0) {
                await pdfDocument.destroy();
                return {
                    success: false,
                    canceled: true,
                };
            }

            const descriptors = await collectTiffPageDescriptors(pdfDocument.pdfDocument, targetPages);
            const saveTarget = await pickSaveTarget({
                suggestedName: outputFileName,
                pickerTypes: [{
                    description: 'TIFF Images',
                    accept: { 'image/tiff': [
                        '.tif',
                        '.tiff',
                    ] },
                }],
            });

            if (saveTarget.canceled) {
                await pdfDocument.destroy();
                return {
                    success: false,
                    canceled: true,
                };
            }

            try {
                if (saveTarget.handle) {
                    const fileSize = await encodeTiffToWritable(
                        pdfDocument.pdfDocument,
                        descriptors,
                        saveTarget.handle,
                    );
                    const outputRef = await browserDocumentStore.createStoredDocument(
                        saveTarget.fileName,
                        new Uint8Array(),
                        {
                            mimeType: 'image/tiff',
                            saveKind: 'generic',
                            kind: 'output',
                            retention: 'transient',
                            saveHandle: saveTarget.handle,
                            storageMode: 'handle',
                        },
                    );
                    await browserDocumentStore.replaceWithHandleBackedDocument(outputRef, {
                        fileSize,
                        saveHandle: saveTarget.handle,
                        saveName: saveTarget.fileName,
                    });
                    await browserDocumentStore.touchRecentFile(outputRef);
                    return {
                        success: true,
                        outputPath: outputRef,
                    };
                }

                const estimatedRgbaBytes = sumBy(descriptors, descriptor => descriptor.dataLength);
                if (estimatedRgbaBytes > BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES) {
                    throw new Error(
                        `Multi-page TIFF export without a file handle is disabled for exports larger than ${Math.floor(BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES / (1024 * 1024))}MB`,
                    );
                }

                const tiffBytes = await encodeTiffToBytes(
                    pdfDocument.pdfDocument,
                    descriptors,
                );

                const saveResult = await saveBytesToPickerOrDownload(tiffBytes, {
                    suggestedName: saveTarget.fileName,
                    mimeType: 'image/tiff',
                    pickerTypes: [{
                        description: 'TIFF Images',
                        accept: { 'image/tiff': [
                            '.tif',
                            '.tiff',
                        ] },
                    }],
                });

                if (saveResult.canceled) {
                    return {
                        success: false,
                        canceled: true,
                    };
                }

                const outputRef = await browserDocumentStore.createStoredDocument(
                    saveResult.fileName,
                    tiffBytes,
                    {
                        mimeType: 'image/tiff',
                        saveKind: 'generic',
                        kind: 'output',
                        retention: 'transient',
                        saveHandle: saveResult.handle ?? null,
                        storageMode: saveResult.handle ? 'handle' : 'inline',
                    },
                );
                await browserDocumentStore.touchRecentFile(outputRef);
                return {
                    success: true,
                    outputPath: outputRef,
                };
            } finally {
                await pdfDocument.destroy();
            }
        },
    };
}

function encodeMultiPageTiff(
    pages: Array<{
        rgba: Uint8Array;
        width: number;
        height: number;
    }>,
) {
    if (pages.length === 0) {
        throw new Error('No pages available for TIFF export');
    }

    const pageDescriptors = pages.map((page, index) => ({
        pageNumber: index + 1,
        width: page.width,
        height: page.height,
        dataLength: page.rgba.byteLength,
    }));
    const {
        firstDataOffset,
        output,
    } = createMultiPageTiffOutput(pageDescriptors);
    let offset = firstDataOffset;
    for (const page of pages) {
        output.set(page.rgba, offset);
        offset += page.rgba.byteLength;
    }

    return output;
}
