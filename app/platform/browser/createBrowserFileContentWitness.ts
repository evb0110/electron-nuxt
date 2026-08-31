import {BROWSER_MAX_FULL_READ_BYTES} from '@app/platform/browser/browserDocumentConstants';

const BROWSER_FILE_WITNESS_SAMPLE_BYTES = 64 * 1024;

function hashBytes(bytes: Uint8Array) {
    let first = 2_166_136_261;
    let second = 2_169_136_261;
    for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index] ?? 0;
        first = Math.imul(first ^ byte, 16_777_619);
        second = Math.imul(second ^ byte, 2_654_435_761);
    }
    return `${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}

/**
 * Reads small files in full and samples the first and last 64KB of large
 * files, keeping the content witness bounded by the browser memory policy.
 */
async function readWitnessBytes(file: File) {
    if (file.size <= BROWSER_MAX_FULL_READ_BYTES) {
        return new Uint8Array(await file.arrayBuffer());
    }

    const sampleSize = Math.min(BROWSER_FILE_WITNESS_SAMPLE_BYTES, file.size);
    const head = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
    const tailStart = Math.max(0, file.size - sampleSize);
    const tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer());
    const samples = new Uint8Array(head.byteLength + tail.byteLength);
    samples.set(head);
    samples.set(tail, head.byteLength);
    return samples;
}

/**
 * Builds a bounded witness. Files larger than the full-read limit use the
 * first and last 64 KiB, plus size and lastModified, rather than full content.
 */
export async function createBrowserFileContentWitness(
    file: File,
    knownBytes?: Uint8Array,
) {
    const bytes = knownBytes?.byteLength === file.size
        ? knownBytes
        : await readWitnessBytes(file);
    return `file:${file.size}:${file.lastModified}:${hashBytes(bytes)}`;
}
