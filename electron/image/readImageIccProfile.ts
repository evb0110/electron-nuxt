import {inflateSync} from 'zlib';

const MAX_ICC_PROFILE_BYTES = 16 * 1024 * 1024;

function u16be(data: Uint8Array, offset: number) {
    return (data[offset]! << 8) | data[offset + 1]!;
}

function u32be(data: Uint8Array, offset: number) {
    return ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;
}

function readJpegIccProfile(data: Uint8Array) {
    const chunks: Array<{
        sequence: number;
        total: number;
        data: Uint8Array
    }> = [];
    let offset = 2;
    while (offset + 4 <= data.byteLength && data[offset] === 0xff) {
        const marker = data[offset + 1]!;
        if (marker === 0xda || marker === 0xd9) break;
        const length = u16be(data, offset + 2);
        if (length < 2 || offset + 2 + length > data.byteLength) break;
        const payload = offset + 4;
        if (marker === 0xe2 && length >= 16 && Buffer.from(data.subarray(payload, payload + 12)).equals(Buffer.from('ICC_PROFILE\0', 'ascii'))) {
            chunks.push({
                sequence: data[payload + 12]!,
                total: data[payload + 13]!,
                data: data.slice(payload + 14, offset + 2 + length),
            });
        }
        offset += 2 + length;
    }
    const total = chunks[0]?.total ?? 0;
    chunks.sort((left, right) => left.sequence - right.sequence);
    if (total === 0 || chunks.length !== total || chunks.some((chunk, index) => chunk.total !== total || chunk.sequence !== index + 1)) {
        return undefined;
    }
    const profile = Buffer.concat(chunks.map(chunk => chunk.data));
    if (profile.byteLength > MAX_ICC_PROFILE_BYTES) throw new Error('Image ICC profile is too large');
    return new Uint8Array(profile);
}

function readPngIccProfile(data: Uint8Array) {
    let offset = 8;
    while (offset + 12 <= data.byteLength) {
        const length = u32be(data, offset);
        if (offset + 12 + length > data.byteLength) break;
        if (Buffer.from(data.subarray(offset + 4, offset + 8)).equals(Buffer.from('iCCP', 'ascii'))) {
            const chunk = data.subarray(offset + 8, offset + 8 + length);
            const nameEnd = chunk.indexOf(0);
            if (nameEnd < 1 || chunk[nameEnd + 1] !== 0) throw new Error('Invalid PNG ICC profile');
            const profile = inflateSync(chunk.subarray(nameEnd + 2), {maxOutputLength: MAX_ICC_PROFILE_BYTES});
            return new Uint8Array(profile);
        }
        offset += 12 + length;
    }
    return undefined;
}

export function readImageIccProfile(data: Uint8Array, extension: string) {
    if (extension === '.jpg' || extension === '.jpeg') {
        return readJpegIccProfile(data);
    }
    if (extension === '.png') {
        return readPngIccProfile(data);
    }
    return undefined;
}
