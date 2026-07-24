import {
    open,
    stat,
} from 'fs/promises';

export async function readPngDimensions(path: string) {
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(26);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (
            bytesRead !== header.byteLength
            || header.subarray(0, 8).compare(Buffer.from([
                0x89,
                0x50,
                0x4e,
                0x47,
                0x0d,
                0x0a,
                0x1a,
                0x0a,
            ])) !== 0
        ) {
            throw new Error(`Unable to inspect raster dimensions for ${path}`);
        }
        const width = header.readUInt32BE(16);
        const height = header.readUInt32BE(20);
        const colorType = header[25]!;
        if (
            width === 0
            || height === 0
            || ![
                0,
                2,
                3,
                4,
                6,
            ].includes(colorType)
        ) {
            throw new Error(`Invalid PNG header for ${path}`);
        }
        return {
            width,
            height,
            isColor: colorType === 2 || colorType === 3 || colorType === 6,
        };
    } finally {
        await handle.close();
    }
}

export async function readPbmDimensions(path: string) {
    const fileStats = await stat(path);
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(Math.min(fileStats.size, 4_096));
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        const data = header.subarray(0, bytesRead);
        if (data.subarray(0, 2).toString('ascii') !== 'P4') {
            throw new Error(`Unsupported PBM header for ${path}`);
        }
        const state = {offset: 2};
        function readNumber(label: string) {
            while (state.offset < data.length) {
                const byte = data[state.offset]!;
                if (byte === 0x23) {
                    while (state.offset < data.length && data[state.offset] !== 0x0a) {
                        state.offset += 1;
                    }
                } else if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) {
                    state.offset += 1;
                } else {
                    break;
                }
            }
            const start = state.offset;
            while (
                state.offset < data.length
                && data[state.offset]! >= 0x30
                && data[state.offset]! <= 0x39
            ) {
                state.offset += 1;
            }
            if (start === state.offset) {
                throw new Error(`Invalid PBM ${label} for ${path}`);
            }
            const value = Number.parseInt(data.subarray(start, state.offset).toString('ascii'), 10);
            if (!Number.isSafeInteger(value) || value <= 0) {
                throw new Error(`Invalid PBM ${label} for ${path}`);
            }
            return value;
        }
        const width = readNumber('width');
        const height = readNumber('height');
        const terminator = data[state.offset];
        if (terminator !== 0x09 && terminator !== 0x0a && terminator !== 0x0d && terminator !== 0x20) {
            throw new Error(`Invalid PBM header terminator for ${path}`);
        }
        state.offset += terminator === 0x0d && data[state.offset + 1] === 0x0a ? 2 : 1;
        const expectedBytes = state.offset + Math.ceil(width / 8) * height;
        if (!Number.isSafeInteger(expectedBytes) || fileStats.size < expectedBytes) {
            throw new Error(`Truncated PBM payload for ${path}`);
        }
        return {
            width,
            height,
        };
    } finally {
        await handle.close();
    }
}
