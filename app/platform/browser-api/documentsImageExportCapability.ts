import UTIF from 'utif';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
    range,
    sumBy,
} from 'es-toolkit/math';
import type { IImageExportCapability } from '@contracts/platformApi';
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
    saveBlobToPickerOrDownload,
    saveBytesToPickerOrDownload,
} from '@app/platform/browser-api/browserFilePickerAdapter';
import {
    buildTiffImageIfd,
    encodeTiffIfds,
} from '@pdf-core/tiffEncoding';

interface IRenderedPdfPage {
    pageNumber: number;
    fileName: string;
    rgba: Uint8Array;
    width: number;
    height: number;
}

interface IRenderedPngPage {
    pageNumber: number;
    fileName: string;
    pngBlob: Blob;
}

interface ITiffPageDescriptor {
    pageNumber: number;
    width: number;
    height: number;
    dataLength: number;
}

const BROWSER_INLINE_TIFF_EXPORT_MAX_RGBA_BYTES = 64 * 1024 * 1024;

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

function mergeUint8Arrays(parts: Uint8Array[]) {
    const totalLength = sumBy(parts, part => part.byteLength);
    const output = new Uint8Array(totalLength);
    let offset = 0;

    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }

    return output;
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
            return {
                pageNumber,
                fileName: `page-${String(pageNumber).padStart(3, '0')}.png`,
                rgba: new Uint8Array(imageData.data),
                width: canvas.width,
                height: canvas.height,
            };
        },
    );
}

async function canvasToPngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error('Failed to export rendered page'));
                return;
            }

            resolve(blob);
        }, 'image/png');
    });
}

async function renderPdfPageToPng(
    pdfDocument: Pick<PDFDocumentProxy, 'getPage'>,
    pageNumber: number,
): Promise<IRenderedPngPage> {
    return withRenderedPdfPageCanvas(pdfDocument, pageNumber, async ({ canvas }) => {
        const pngBlob = await canvasToPngBlob(canvas);
        return {
            pageNumber,
            fileName: `page-${String(pageNumber).padStart(3, '0')}.png`,
            pngBlob,
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
                    const page = await renderPdfPageToPng(pdfDocument.pdfDocument, pageNumber);
                    const saveResult = await saveBlobToPickerOrDownload(
                        page.pngBlob,
                        page.fileName,
                        [{
                            description: 'PNG Images',
                            accept: { 'image/png': ['.png'] },
                        }],
                    );
                    if (saveResult.canceled) {
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

                    const pageBytes = saveResult.handle
                        ? new Uint8Array()
                        : new Uint8Array(await page.pngBlob.arrayBuffer());
                    const outputRef = await browserDocumentStore.createStoredDocument(
                        saveResult.fileName,
                        pageBytes,
                        {
                            mimeType: 'image/png',
                            saveKind: 'generic',
                            kind: 'output',
                            retention: 'transient',
                            saveHandle: saveResult.handle ?? null,
                            ...(saveResult.handle ? { storageMode: 'handle' as const } : {}),
                        },
                    );
                    if (saveResult.handle) {
                        await browserDocumentStore.replaceWithHandleBackedDocument(outputRef, {
                            fileSize: page.pngBlob.size,
                            saveHandle: saveResult.handle,
                            saveName: saveResult.fileName,
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

                const renderedPages: IRenderedPdfPage[] = [];
                try {
                    for (const pageNumber of targetPages) {
                        renderedPages.push(await renderPdfPage(pdfDocument.pdfDocument, pageNumber));
                        if (renderedPages.length % 2 === 0) {
                            await yieldToBrowser();
                        }
                    }
                } finally {
                    // Nothing to clean up here beyond the document itself.
                }

                const tiffBytes = encodeMultiPageTiff(
                    renderedPages.map((page) => ({
                        rgba: page.rgba,
                        width: page.width,
                        height: page.height,
                    })),
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
        header,
        firstDataOffset,
    } = encodeMultiPageTiffHeader(pageDescriptors);
    const parts = [
        header,
        new Uint8Array(Math.max(0, firstDataOffset - header.length)),
        ...pages.map((page) => page.rgba),
    ];

    return mergeUint8Arrays(parts);
}
