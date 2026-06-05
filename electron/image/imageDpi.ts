const DEFAULT_IMAGE_DPI = 72;
const METERS_PER_INCH = 0.0254;
const CM_PER_INCH = 2.54;
const PNG_SIGNATURE_LENGTH = 8;
const PNG_CHUNK_HEADER_LENGTH = 8;
const PNG_CHUNK_CRC_LENGTH = 4;
const PNG_PHYS_CHUNK_LENGTH = 9;
const JPEG_APP0_MARKER = 0xE0;
const JPEG_START_OF_SCAN_MARKER = 0xDA;

function readUint32BE(buf: Uint8Array, offset: number) {
    return ((buf[offset]! << 24) | (buf[offset + 1]! << 16) | (buf[offset + 2]! << 8) | buf[offset + 3]!) >>> 0;
}

function readUint16BE(buf: Uint8Array, offset: number) {
    return (buf[offset]! << 8) | buf[offset + 1]!;
}

interface IPngChunk {
    offset: number;
    length: number;
}

function isPngPhysChunk(data: Uint8Array, offset: number) {
    return (
        data[offset + 4] === 0x70
        && data[offset + 5] === 0x48
        && data[offset + 6] === 0x59
        && data[offset + 7] === 0x73
    );
}

function parsePngPhysDpi(data: Uint8Array, offset: number) {
    const xPixelsPerUnit = readUint32BE(data, offset + PNG_CHUNK_HEADER_LENGTH);
    const yPixelsPerUnit = readUint32BE(data, offset + PNG_CHUNK_HEADER_LENGTH + 4);
    const unit = data[offset + PNG_CHUNK_HEADER_LENGTH + 8]!;

    if (unit !== 1 || (xPixelsPerUnit <= 0 && yPixelsPerUnit <= 0)) {
        return null;
    }

    const pixelsPerMeter = Math.max(xPixelsPerUnit, yPixelsPerUnit);
    const dpi = Math.round(pixelsPerMeter * METERS_PER_INCH);
    return dpi > 0 ? dpi : null;
}

function getNextPngChunk(data: Uint8Array, offset: number): IPngChunk | null {
    if (offset + PNG_CHUNK_HEADER_LENGTH + PNG_CHUNK_CRC_LENGTH > data.length) {
        return null;
    }

    const length = readUint32BE(data, offset);
    const chunkEnd = offset + PNG_CHUNK_HEADER_LENGTH + length + PNG_CHUNK_CRC_LENGTH;
    if (chunkEnd > data.length) {
        return null;
    }

    return {
        offset,
        length,
    };
}

function readPngDpi(data: Uint8Array) {
    if (data.length < PNG_SIGNATURE_LENGTH) {
        return null;
    }

    let offset = PNG_SIGNATURE_LENGTH;

    while (offset < data.length) {
        const chunk = getNextPngChunk(data, offset);
        if (!chunk) {
            return null;
        }

        if (isPngPhysChunk(data, chunk.offset) && chunk.length === PNG_PHYS_CHUNK_LENGTH) {
            return parsePngPhysDpi(data, chunk.offset);
        }

        offset += PNG_CHUNK_HEADER_LENGTH + chunk.length + PNG_CHUNK_CRC_LENGTH;
    }

    return null;
}

function isJfifSegment(data: Uint8Array, offset: number) {
    return (
        data[offset + 4] === 0x4A
        && data[offset + 5] === 0x46
        && data[offset + 6] === 0x49
        && data[offset + 7] === 0x46
        && data[offset + 8] === 0x00
    );
}

function parseJfifDensityDpi(units: number, xDensity: number, yDensity: number) {
    const density = Math.max(xDensity, yDensity);
    if (density <= 0) {
        return null;
    }

    if (units === 1) {
        return density;
    }
    if (units === 2) {
        return Math.round(density * CM_PER_INCH);
    }

    return null;
}

function readJfifDensityDpi(data: Uint8Array, offset: number) {
    return parseJfifDensityDpi(
        data[offset + 11]!,
        readUint16BE(data, offset + 12),
        readUint16BE(data, offset + 14),
    );
}

function readJpegSegmentDpi(data: Uint8Array, offset: number, marker: number) {
    if (marker !== JPEG_APP0_MARKER) {
        return null;
    }

    const segLength = readUint16BE(data, offset + 2);
    if (segLength < 14 || offset + 2 + segLength > data.length || !isJfifSegment(data, offset)) {
        return null;
    }

    return readJfifDensityDpi(data, offset);
}

function readJpegDpi(data: Uint8Array) {
    if (data.length < 20 || data[0] !== 0xFF || data[1] !== 0xD8) {
        return null;
    }

    let offset = 2;

    while (offset + 4 < data.length) {
        if (data[offset] !== 0xFF) break;
        const marker = data[offset + 1]!;

        const dpi = readJpegSegmentDpi(data, offset, marker);
        if (dpi) {
            return dpi;
        }

        if (marker === JPEG_START_OF_SCAN_MARKER) break;

        const segLength = readUint16BE(data, offset + 2);
        offset += 2 + segLength;
    }

    return null;
}

interface ITiffResolutionTags {
    t282?: unknown;
    t283?: unknown;
    t296?: unknown;
}

function extractNumber(value: unknown) {
    return typeof value === 'number' && value > 0 ? value : null;
}

function extractTiffRational(value: unknown) {
    const numericValue = extractNumber(value);
    if (numericValue !== null) {
        return numericValue;
    }

    if (!Array.isArray(value)) {
        return null;
    }

    const numerator = extractNumber(value[0]);
    if (numerator === null) {
        return null;
    }

    const denominator = extractNumber(value[1]);
    if (denominator !== null) {
        return numerator / denominator;
    }

    return numerator;
}

function extractTiffUnit(value: unknown) {
    if (typeof value === 'number') {
        return value;
    }
    if (Array.isArray(value) && value.length >= 1 && typeof value[0] === 'number') {
        return value[0];
    }
    return 2;
}

export function readTiffFrameDpi(ifd: ITiffResolutionTags) {
    const xRes = extractTiffRational(ifd.t282);
    const yRes = extractTiffRational(ifd.t283);
    const unit = extractTiffUnit(ifd.t296);

    const resolution = Math.max(xRes ?? 0, yRes ?? 0);
    if (resolution <= 0) {
        return null;
    }

    if (unit === 2) {
        return Math.round(resolution);
    }
    if (unit === 3) {
        return Math.round(resolution * CM_PER_INCH);
    }

    return null;
}

export function readImageDpi(data: Uint8Array, extension: string) {
    const ext = extension.toLowerCase();
    let dpi: number | null = null;

    if (ext === '.png') {
        dpi = readPngDpi(data);
    } else if (ext === '.jpg' || ext === '.jpeg') {
        dpi = readJpegDpi(data);
    }

    return dpi && dpi > 0 ? dpi : DEFAULT_IMAGE_DPI;
}

export function pixelsToPdfPoints(pixels: number, dpi: number) {
    return (pixels / dpi) * 72;
}
