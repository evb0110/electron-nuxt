declare module 'utif' {
    export interface IUtifFrame {
        width?: number;
        height?: number;
        [key: string]: unknown;
    }

    export function encode(ifds: Record<string, unknown>[]): Uint8Array | ArrayBufferLike;
    export function decode(data: Uint8Array): IUtifFrame[];
    export function decodeImage(data: Uint8Array, ifd: IUtifFrame): void;
    export function toRGBA8(ifd: IUtifFrame): Uint8Array;
    export function encodeImage(
        rgba: Uint8Array | ArrayBuffer,
        width: number,
        height: number,
        metadata?: Record<string, unknown>,
    ): ArrayBuffer;

    const UTIF: {
        encode: typeof encode;
        decode: typeof decode;
        decodeImage: typeof decodeImage;
        toRGBA8: typeof toRGBA8;
        encodeImage: typeof encodeImage;
    };

    export default UTIF;
}
