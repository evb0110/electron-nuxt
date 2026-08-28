import {createHash} from 'node:crypto';

const ORIGINAL_FILE_FINGERPRINT_VERSION = 'sha256-full-v1';

export function createOriginalFileContentFingerprintHash(size: number) {
    const hash = createHash('sha256');
    hash.update(`${ORIGINAL_FILE_FINGERPRINT_VERSION}\nsize:${size}\n`);
    return hash;
}
