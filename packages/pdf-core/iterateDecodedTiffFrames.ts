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
    sourceLabel?: string | undefined;
}

export const DEFAULT_TIFF_DECODE_MAX_FRAMES = 250;
export const DEFAULT_TIFF_DECODE_MAX_PIXELS = 80_000_000;
export const DEFAULT_TIFF_DECODE_LIMITS: Required<Pick<
    IIterateDecodedTiffFramesOptions,
    'maxFrames' | 'maxPixels'
>> = {
    maxFrames: DEFAULT_TIFF_DECODE_MAX_FRAMES,
    maxPixels: DEFAULT_TIFF_DECODE_MAX_PIXELS,
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

export function* iterateDecodedTiffFrames(
    bytes: Uint8Array,
    options: IIterateDecodedTiffFramesOptions = {},
): Generator<IDecodedTiffFrame> {
    const frames = decode(bytes);
    assertTiffFrameCount(frames.length, options);

    for (const frame of frames) {
        decodeImage(bytes, frame);
        const width = typeof frame.width === 'number' ? frame.width : 0;
        const height = typeof frame.height === 'number' ? frame.height : 0;
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
