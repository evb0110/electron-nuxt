declare module 'utif' {
    export function encode(ifds: Record<string, unknown>[]): Uint8Array | ArrayBufferLike;
    export function decode(data: Uint8Array): unknown[];
    export function decodeImage(data: Uint8Array, ifd: unknown): void;
    export function toRGBA8(ifd: unknown): Uint8Array;
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
