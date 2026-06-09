import {
    createWriteStream,
    type WriteStream,
} from 'fs';
import {
    readFile,
    rm,
} from 'fs/promises';
import { sumBy } from 'es-toolkit/math';
import * as utifModule from 'utif';
import {
    buildTiffImageIfd,
    encodeTiffIfds,
} from '@pdf-core';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { tryCombinePagesWithNativeTiffCombiner } from '@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner';

interface IUtifFrame {
    width?: number;
    height?: number;
    [key: string]: unknown;
}

interface IUtifModule {
    decode(input: Uint8Array | ArrayBuffer): IUtifFrame[];
    decodeImage(input: Uint8Array | ArrayBuffer, frame: IUtifFrame): void;
    toRGBA8(frame: IUtifFrame): Uint8Array;
    encode(ifds: Array<Record<string, unknown>>): ArrayBuffer;
}

interface IUtifBinaryWriter {
    writeUint(buffer: Uint8Array, offset: number, value: number): void;
    writeUshort(buffer: Uint8Array, offset: number, value: number): void;
}

interface IUtifEncoderModule extends IUtifModule {
    _binBE: IUtifBinaryWriter;
    _writeIFD(
        bin: IUtifBinaryWriter,
        data: Uint8Array,
        offset: number,
        ifd: Record<string, unknown>,
    ): [number, number];
    ttypes: Record<number, number | undefined>;
}

interface ITiffPageRgba {
    width: number;
    height: number;
    rgba: Uint8Array;
}

interface ITiffPageDescriptor {
    path: string;
    width: number;
    height: number;
    dataLength: number;
}

const UTIF = utifModule as IUtifModule as IUtifEncoderModule;

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

    if (ArrayBuffer.isView(value)) {
        const length = Reflect.get(value, 'length');
        if (typeof length === 'number' && length > 0) {
            return toPositiveInteger(Reflect.get(value, 0));
        }
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
    pages: Array<Pick<ITiffPageDescriptor, 'dataLength'>>,
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

    const pages: ITiffPageDescriptor[] = [];

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

    const firstPageDataOffset = alignOffset(header.length, 8);
    const totalByteLength = firstPageDataOffset + sumBy(pages, page => page.dataLength);
    if (totalByteLength > 0xFFFFFFFF) {
        throw new Error('Multi-page TIFF export exceeds the Classic TIFF 4GB limit');
    }

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
