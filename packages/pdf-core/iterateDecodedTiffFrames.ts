import UTIF, { type IUtifFrame } from 'utif';

export type { IUtifFrame };

const {
    decode,
    decodeImage,
    toRGBA8,
} = UTIF;

export interface IDecodedTiffFrame {
    frame: IUtifFrame;
    width: number;
    height: number;
    rgba: Uint8Array;
}

export interface IIterateDecodedTiffFramesOptions {
    maxFrames?: number | undefined;
    maxPixels?: number | undefined;
    maxTotalPixels?: number | undefined;
    sourceLabel?: string | undefined;
}

export const DEFAULT_TIFF_DECODE_MAX_FRAMES = 250;
export const DEFAULT_TIFF_DECODE_MAX_PIXELS = 80_000_000;
export const DEFAULT_TIFF_DECODE_MAX_TOTAL_PIXELS = 256_000_000;
export const DEFAULT_TIFF_DECODE_LIMITS: Required<Pick<
    IIterateDecodedTiffFramesOptions,
    'maxFrames' | 'maxPixels' | 'maxTotalPixels'
>> = {
    maxFrames: DEFAULT_TIFF_DECODE_MAX_FRAMES,
    maxPixels: DEFAULT_TIFF_DECODE_MAX_PIXELS,
    maxTotalPixels: DEFAULT_TIFF_DECODE_MAX_TOTAL_PIXELS,
};

function getSourceSuffix(sourceLabel: string | undefined) {
    return sourceLabel ? `: ${sourceLabel}` : '';
}

function normalizePositiveInteger(value: number | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function assertTiffFrameCount(
    frameCount: number,
    options: IIterateDecodedTiffFramesOptions,
) {
    const maxFrames = normalizePositiveInteger(options.maxFrames);
    if (maxFrames !== null && frameCount > maxFrames) {
        throw new Error(`TIFF frame count is capped at ${maxFrames}${getSourceSuffix(options.sourceLabel)}`);
    }
}

function assertTiffPixelCount(
    width: number,
    height: number,
    options: IIterateDecodedTiffFramesOptions,
) {
    const maxPixels = normalizePositiveInteger(options.maxPixels);
    if (maxPixels !== null && width > maxPixels / height) {
        throw new Error(`TIFF frame dimensions are too large to decode safely${getSourceSuffix(options.sourceLabel)}`);
    }
}

function assertTiffTotalPixelCount(
    totalPixels: number,
    options: IIterateDecodedTiffFramesOptions,
) {
    const maxTotalPixels = normalizePositiveInteger(options.maxTotalPixels);
    if (maxTotalPixels !== null && totalPixels > maxTotalPixels) {
        throw new Error(`TIFF aggregate decoded pixels are capped at ${maxTotalPixels}${getSourceSuffix(options.sourceLabel)}`);
    }
}

function readTiffUint16(bytes: Uint8Array, offset: number, littleEndian: boolean) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, littleEndian);
}

function readTiffUint32(bytes: Uint8Array, offset: number, littleEndian: boolean) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

function readTiffUint64(bytes: Uint8Array, offset: number, littleEndian: boolean) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, littleEndian);
}

function preflightTiffIfdCount(bytes: Uint8Array, options: IIterateDecodedTiffFramesOptions) {
    if (bytes.byteLength < 8) {
        return;
    }
    const byteOrder = String.fromCharCode(bytes[0]!, bytes[1]!);
    if (byteOrder !== 'II' && byteOrder !== 'MM') {
        return;
    }
    const littleEndian = byteOrder === 'II';
    const magic = readTiffUint16(bytes, 2, littleEndian);
    const bigTiff = magic === 43;
    if (magic !== 42 && !bigTiff) {
        return;
    }
    if (bigTiff && (
        bytes.byteLength < 16
        || readTiffUint16(bytes, 4, littleEndian) !== 8
        || readTiffUint16(bytes, 6, littleEndian) !== 0
    )) {
        return;
    }
    let ifdOffset = bigTiff
        ? readTiffUint64(bytes, 8, littleEndian)
        : BigInt(readTiffUint32(bytes, 4, littleEndian));
    const visitedOffsets = new Set<bigint>();
    let frameCount = 0;
    while (ifdOffset > 0n && ifdOffset <= BigInt(Number.MAX_SAFE_INTEGER)) {
        if (visitedOffsets.has(ifdOffset)) {
            return;
        }
        visitedOffsets.add(ifdOffset);
        const offset = Number(ifdOffset);
        const countBytes = bigTiff ? 8 : 2;
        if (offset < 0 || offset + countBytes > bytes.byteLength) {
            return;
        }
        frameCount += 1;
        assertTiffFrameCount(frameCount, options);
        const entryCount = bigTiff
            ? readTiffUint64(bytes, offset, littleEndian)
            : BigInt(readTiffUint16(bytes, offset, littleEndian));
        const entryBytes = bigTiff ? 20n : 12n;
        const nextOffsetPosition = BigInt(offset + countBytes) + (entryCount * entryBytes);
        const nextOffsetBytes = bigTiff ? 8 : 4;
        if (
            nextOffsetPosition > BigInt(Number.MAX_SAFE_INTEGER)
            || nextOffsetPosition + BigInt(nextOffsetBytes) > BigInt(bytes.byteLength)
        ) {
            return;
        }
        const nextOffset = Number(nextOffsetPosition);
        ifdOffset = bigTiff
            ? readTiffUint64(bytes, nextOffset, littleEndian)
            : BigInt(readTiffUint32(bytes, nextOffset, littleEndian));
    }
}

export function* iterateDecodedTiffFrames(
    bytes: Uint8Array,
    options: IIterateDecodedTiffFramesOptions = {},
): Generator<IDecodedTiffFrame> {
    preflightTiffIfdCount(bytes, options);
    const frames = decode(bytes);
    assertTiffFrameCount(frames.length, options);

    let totalPixels = 0;
    for (const frame of frames) {
        const width = typeof frame.width === 'number' ? frame.width : 0;
        const height = typeof frame.height === 'number' ? frame.height : 0;
        if (width <= 0 || height <= 0) {
            continue;
        }
        assertTiffPixelCount(width, height, options);
        totalPixels += width * height;
        assertTiffTotalPixelCount(totalPixels, options);
    }

    for (const frame of frames) {
        let width = typeof frame.width === 'number' ? frame.width : 0;
        let height = typeof frame.height === 'number' ? frame.height : 0;
        if (width > 0 && height > 0) {
            assertTiffPixelCount(width, height, options);
        }
        decodeImage(bytes, frame);
        width = typeof frame.width === 'number' ? frame.width : 0;
        height = typeof frame.height === 'number' ? frame.height : 0;
        if (width <= 0 || height <= 0) {
            continue;
        }
        assertTiffPixelCount(width, height, options);

        const rgba = toRGBA8(frame);
        if (!rgba || rgba.byteLength === 0) {
            continue;
        }

        yield {
            frame,
            width,
            height,
            rgba,
        };
    }
}
