import { v4 as uuidV4 } from 'uuid';

let uuidCounter = 0;

function createUuidBytes() {
    const bytes = new Uint8Array(16);
    let seed = Date.now() + uuidCounter;
    uuidCounter = (uuidCounter + 1) % Number.MAX_SAFE_INTEGER;

    for (let index = 0; index < bytes.length; index += 1) {
        seed = (seed * 1_664_525 + 1_013_904_223) % 0x1_0000_0000;
        bytes[index] = (seed ^ Math.floor(Math.random() * 256)) & 0xff;
    }

    return bytes;
}

export function createUuid() {
    return uuidV4({ random: createUuidBytes() });
}
