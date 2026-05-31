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

export function* iterateDecodedTiffFrames(
    bytes: Uint8Array,
): Generator<IDecodedTiffFrame> {
    const frames = decode(bytes);
    for (const frame of frames) {
        decodeImage(bytes, frame);
        const width = typeof frame.width === 'number' ? frame.width : 0;
        const height = typeof frame.height === 'number' ? frame.height : 0;
        if (width <= 0 || height <= 0) {
            continue;
        }

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
