declare module 'utif' {
    export interface IUtifFrame {
        width?: number;
        height?: number;
        t273?: number[];
        [key: string]: unknown;
    }

    export interface IUtifBinaryWriter {
        writeUint(buffer: Uint8Array, offset: number, value: number): void;
        writeUshort(buffer: Uint8Array, offset: number, value: number): void;
    }

    export interface IUtifEncoderModule {
        _binBE: IUtifBinaryWriter;
        _writeIFD(
            bin: IUtifBinaryWriter,
            data: Uint8Array,
            offset: number,
            ifd: Record<string, unknown>,
        ): [number, number];
        ttypes: Record<number, number | undefined>;
    }

    export function encode(ifds: Array<Record<string, unknown>>): Uint8Array | ArrayBufferLike;
    export function decode(input: Uint8Array | ArrayBuffer): IUtifFrame[];
    export function decodeImage(input: Uint8Array | ArrayBuffer, frame: IUtifFrame): void;
    export function toRGBA8(frame: IUtifFrame): Uint8Array;
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
    } & IUtifEncoderModule;

    export default UTIF;
}
