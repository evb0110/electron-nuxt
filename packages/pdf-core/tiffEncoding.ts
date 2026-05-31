import { sumBy } from 'es-toolkit/math';

export interface ITiffEncoderBinaryWriter {
    writeUint(buffer: Uint8Array, offset: number, value: number): void;
    writeUshort(buffer: Uint8Array, offset: number, value: number): void;
}

export interface ITiffEncoderModule {
    _binBE: ITiffEncoderBinaryWriter;
    _writeIFD(
        bin: ITiffEncoderBinaryWriter,
        data: Uint8Array,
        offset: number,
        ifd: Record<string, unknown>,
    ): [number, number];
    ttypes: Record<number, number | undefined>;
}

export interface ITiffImageDescriptor {
    width: number;
    height: number;
    dataLength: number;
}

export const TIFF_TYPE_BYTES: Record<number, number> = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    12: 8,
};

export function buildTiffImageIfd(page: ITiffImageDescriptor, dataOffset: number) {
    return {
        t256: [page.width],
        t257: [page.height],
        t258: [
            8,
            8,
            8,
            8,
        ],
        t259: [1],
        t262: [2],
        t273: [dataOffset],
        t277: [4],
        t278: [page.height],
        t279: [page.dataLength],
        t282: [1],
        t283: [1],
        t284: [1],
        t286: [0],
        t287: [0],
        t296: [1],
        t305: ['EVB Viewer'],
        t338: [1],
    };
}

export function getTiffValueCount(value: unknown): number {
    if (Array.isArray(value)) {
        return value.length;
    }

    if (
        ArrayBuffer.isView(value)
        && 'BYTES_PER_ELEMENT' in value
        && typeof value.BYTES_PER_ELEMENT === 'number'
        && value.BYTES_PER_ELEMENT > 0
    ) {
        return Math.floor(value.byteLength / value.BYTES_PER_ELEMENT);
    }

    return 1;
}

export function measureTiffIfdSize(
    ifd: Record<string, unknown>,
    ttypes: Record<number, number | undefined>,
) {
    const keys = Object.keys(ifd);
    let extraDataLength = 0;

    for (const key of keys) {
        const tag = Number.parseInt(key.slice(1), 10);
        const type = ttypes[tag];
        if (!type) {
            throw new Error(`Unsupported TIFF tag type for tag ${tag}`);
        }

        const rawValue = ifd[key];
        const valueLength = type === 2
            ? `${String(Array.isArray(rawValue) ? rawValue[0] ?? '' : rawValue ?? '')}\0`.length
            : getTiffValueCount(rawValue);
        const dataLength = (TIFF_TYPE_BYTES[type] ?? 0) * valueLength;
        if (dataLength > 4) {
            extraDataLength += dataLength + (dataLength & 1);
        }
    }

    return 2 + (keys.length * 12) + 4 + extraDataLength;
}

export function encodeTiffIfds(
    ifds: Array<Record<string, unknown>>,
    encoder: ITiffEncoderModule,
) {
    const capacity = 8 + sumBy(ifds, ifd => measureTiffIfdSize(ifd, encoder.ttypes));
    const data = new Uint8Array(capacity);
    const bin = encoder._binBE;

    data[0] = 77;
    data[1] = 77;
    data[3] = 42;

    let ifdOffset = 8;
    bin.writeUint(data, 4, ifdOffset);

    for (let index = 0; index < ifds.length; index += 1) {
        const [
            nextIfdPointerOffset,
            nextIfdOffset,
        ] = encoder._writeIFD(bin, data, ifdOffset, ifds[index]!);
        ifdOffset = nextIfdOffset;
        if (index < ifds.length - 1) {
            bin.writeUint(data, nextIfdPointerOffset, ifdOffset);
        }
    }

    return data.slice(0, ifdOffset);
}
