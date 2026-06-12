import {
    createWriteStream,
    type WriteStream,
} from 'fs';
import {
    readFile,
    rm,
} from 'fs/promises';
import { sumBy } from 'es-toolkit/math';
import UTIF, { type IUtifFrame } from 'utif';
import {
    buildTiffImageIfd,
    encodeTiffIfds,
} from '@pdf-core';
import type { ITiffImageDescriptor } from '@pdf-core';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { tryCombinePagesWithNativeTiffCombiner } from '@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner';

interface ITiffPageRgba {
    width: number;
    height: number;
    rgba: Uint8Array;
}

interface ILocalTiffPageDescriptor extends ITiffImageDescriptor { path: string }

const CLASSIC_TIFF_MAX_BYTE_LENGTH = 0xFFFFFFFF;

interface IIndexedArrayBufferView extends ArrayBufferView {
    readonly length: number;
    readonly [index: number]: unknown;
}

function isIndexedArrayBufferView(value: ArrayBufferView): value is IIndexedArrayBufferView {
    return 'length' in value && typeof value.length === 'number';
}

function toPositiveInteger(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === 'bigint' && value > 0n) {
        return Number(value);
    }
    return null;
}

function resolveTiffDimensionValue(value: unknown) {
    const direct = toPositiveInteger(value);
    if (direct) {
        return direct;
    }

    if (Array.isArray(value) && value.length > 0) {
        return toPositiveInteger(value[0]);
    }

    if (ArrayBuffer.isView(value) && isIndexedArrayBufferView(value) && value.length > 0) {
        return toPositiveInteger(value[0]);
    }

    return null;
}

function resolveTiffDimension(ifd: IUtifFrame, candidates: Array<string | number>) {
    const record = ifd as Record<string | number, unknown>;

    for (const key of candidates) {
        const resolved = resolveTiffDimensionValue(record[key]);
        if (resolved) {
            return resolved;
        }
    }

    return null;
}

function readTiffDimensions(ifd: IUtifFrame) {
    const width = resolveTiffDimension(ifd, [
        'width',
        't256',
        'ImageWidth',
        256,
    ]);
    const height = resolveTiffDimension(ifd, [
        'height',
        't257',
        'ImageLength',
        257,
    ]);

    if (!width || !height) {
        return null;
    }

    return {
        width,
        height,
    };
}

function decodeSinglePageTiffMetadata(tiffBytes: Uint8Array) {
    const ifds = UTIF.decode(tiffBytes);

    for (const ifd of ifds) {
        const dimensions = readTiffDimensions(ifd);
        if (!dimensions) {
            continue;
        }

        return dimensions;
    }

    throw new Error('Failed to decode TIFF page metadata');
}

function decodeSinglePageTiffRgba(
    tiffBytes: Uint8Array,
    expectedWidth: number,
    expectedHeight: number,
): ITiffPageRgba {
    const ifds = UTIF.decode(tiffBytes);

    for (const ifd of ifds) {
        const dimensions = readTiffDimensions(ifd);
        if (!dimensions) {
            continue;
        }

        if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
            continue;
        }

        UTIF.decodeImage(tiffBytes, ifd);

        const rgba = UTIF.toRGBA8(ifd);
        if (!rgba || rgba.length !== expectedWidth * expectedHeight * 4) {
            continue;
        }

        return {
            width: expectedWidth,
            height: expectedHeight,
            rgba,
        };
    }

    throw new Error('Failed to decode TIFF page data');
}

function alignOffset(offset: number, alignment: number) {
    if (alignment <= 1) {
        return offset;
    }
    const remainder = offset % alignment;
    return remainder === 0 ? offset : offset + (alignment - remainder);
}

function resolvePageDataOffsets(
    pages: Array<Pick<ITiffImageDescriptor, 'dataLength'>>,
    firstDataOffset: number,
): number[] {
    const offsets: number[] = [];
    let cursor = firstDataOffset;

    for (const page of pages) {
        offsets.push(cursor);
        cursor += page.dataLength;
    }

    return offsets;
}

function encodeMultiPageTiffHeader(pages: ITiffImageDescriptor[]) {
    let firstDataOffset = 0;
    let header = new Uint8Array();

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const pageOffsets = resolvePageDataOffsets(pages, firstDataOffset);
        const ifds = pages.map((page, index) => buildTiffImageIfd(page, pageOffsets[index]!));
        header = encodeTiffIfds(ifds, UTIF);
        const nextFirstDataOffset = alignOffset(header.length, 8);
        if (nextFirstDataOffset === firstDataOffset) {
            break;
        }
        firstDataOffset = nextFirstDataOffset;
    }

    return {
        firstPageDataOffset: alignOffset(header.length, 8),
        header,
    };
}

export function estimateMultiPageTiffByteLength(pages: ITiffImageDescriptor[]) {
    const { firstPageDataOffset } = encodeMultiPageTiffHeader(pages);

    return firstPageDataOffset + sumBy(pages, page => page.dataLength);
}

export function splitTiffPageDescriptorsForClassicLimit<TPage extends ITiffImageDescriptor>(
    pages: TPage[],
    maxByteLength = CLASSIC_TIFF_MAX_BYTE_LENGTH,
) {
    if (pages.length === 0) {
        return [];
    }

    const groups: TPage[][] = [];
    let currentGroup: TPage[] = [];

    for (const page of pages) {
        if (estimateMultiPageTiffByteLength([page]) > maxByteLength) {
            throw new Error('A single TIFF page exceeds the Classic TIFF 4GB limit');
        }

        const nextGroup = [
            ...currentGroup,
            page,
        ];
        if (currentGroup.length > 0 && estimateMultiPageTiffByteLength(nextGroup) > maxByteLength) {
            groups.push(currentGroup);
            currentGroup = [page];
        } else {
            currentGroup = nextGroup;
        }
    }

    if (currentGroup.length > 0) {
        groups.push(currentGroup);
    }

    return groups;
}

export async function readTiffPageDescriptors(pagePaths: string[]) {
    const pages: ILocalTiffPageDescriptor[] = [];

    for (const pagePath of pagePaths) {
        const tiffBytes = await readFile(pagePath);
        const metadata = decodeSinglePageTiffMetadata(tiffBytes);
        pages.push({
            path: pagePath,
            width: metadata.width,
            height: metadata.height,
            dataLength: metadata.width * metadata.height * 4,
        });
    }

    return pages;
}

async function writeChunkToStream(stream: WriteStream, chunk: Uint8Array) {
    if (chunk.length === 0) {
        return;
    }

    if (stream.write(chunk)) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const handleDrain = () => {
            stream.off('error', handleError);
            resolve();
        };
        const handleError = (error: Error) => {
            stream.off('drain', handleDrain);
            reject(error);
        };

        stream.once('drain', handleDrain);
        stream.once('error', handleError);
    });
}

async function closeWriteStream(stream: WriteStream) {
    await new Promise<void>((resolve, reject) => {
        const handleFinish = () => {
            stream.off('error', handleError);
            resolve();
        };
        const handleError = (error: Error) => {
            stream.off('finish', handleFinish);
            reject(error);
        };

        stream.once('finish', handleFinish);
        stream.once('error', handleError);
        stream.end();
    });
}

export async function combinePagesIntoMultiPageTiffLocal(pagePaths: string[], outputPath: string) {
    if (pagePaths.length === 0) {
        throw new Error('No pages available for TIFF export');
    }
    if (await tryCombinePagesWithNativeTiffCombiner(pagePaths, outputPath)) {
        return;
    }

    const pages = await readTiffPageDescriptors(pagePaths);
    const totalByteLength = estimateMultiPageTiffByteLength(pages);
    if (totalByteLength > CLASSIC_TIFF_MAX_BYTE_LENGTH) {
        throw new Error('Multi-page TIFF export exceeds the Classic TIFF 4GB limit');
    }

    const {
        firstPageDataOffset,
        header,
    } = encodeMultiPageTiffHeader(pages);
    const tempOutputPath = makeSiblingTempPath(outputPath);
    const stream = createWriteStream(tempOutputPath, { flags: 'w' });
    let replacedOutput = false;

    try {
        await writeChunkToStream(stream, header);

        const paddingLength = firstPageDataOffset - header.length;
        if (paddingLength > 0) {
            await writeChunkToStream(stream, new Uint8Array(paddingLength));
        }

        for (const page of pages) {
            const tiffBytes = await readFile(page.path);
            const decoded = decodeSinglePageTiffRgba(
                tiffBytes,
                page.width,
                page.height,
            );

            if (decoded.rgba.length !== page.dataLength) {
                throw new Error('Decoded TIFF page size did not match computed descriptor size');
            }

            await writeChunkToStream(stream, decoded.rgba);
        }

        await closeWriteStream(stream);
        await atomicReplace(tempOutputPath, outputPath);
        replacedOutput = true;
    } catch (error) {
        stream.destroy();
        throw error;
    } finally {
        if (!replacedOutput) {
            await rm(tempOutputPath, { force: true }).catch(() => undefined);
        }
    }
}
