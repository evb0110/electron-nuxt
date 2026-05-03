declare module 'utif' {
    export interface IUtifFrame {
        width?: number;
        height?: number;
        [key: string]: unknown;
    }

    export function decode(data: Uint8Array): IUtifFrame[];
    export function decodeImage(data: Uint8Array, ifd: IUtifFrame): void;
    export function toRGBA8(ifd: IUtifFrame): Uint8Array;

    const UTIF: {
        decode: typeof decode;
        decodeImage: typeof decodeImage;
        toRGBA8: typeof toRGBA8;
    };

    export default UTIF;
}
