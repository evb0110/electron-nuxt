import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFRawStream,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import {
    safePdfContextLookupDict,
    safePdfDictLookupName,
    safePdfDictLookupNumber,
} from '@pdf-core';

const AES_BLOCK = 16;
const MIN_ENCRYPTED_SIZE = AES_BLOCK * 2;

function toAB(data: Uint8Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

async function sha(algo: string, data: Uint8Array) {
    return new Uint8Array(await crypto.subtle.digest(algo, toAB(data)));
}

function concat(...parts: Uint8Array[]) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

function repeat(block: Uint8Array, n: number) {
    const out = new Uint8Array(block.length * n);
    for (let i = 0; i < n; i++) out.set(block, i * block.length);
    return out;
}

async function importKey(bytes: Uint8Array, bits: 128 | 256): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'raw', toAB(bytes), {
            name: 'AES-CBC',
            length: bits, 
        }, false, [
            'encrypt',
            'decrypt',
        ],
    );
}

async function aesEncNoPad(key: CryptoKey, iv: Uint8Array, data: Uint8Array) {
    const out = new Uint8Array(
        await crypto.subtle.encrypt({
            name: 'AES-CBC',
            iv: toAB(iv), 
        }, key, toAB(data)),
    );
    return out.subarray(0, data.length);
}

async function aesDecNoPad(key: CryptoKey, iv: Uint8Array, data: Uint8Array) {
    const lastC = data.subarray(data.length - AES_BLOCK);
    const padXor = new Uint8Array(AES_BLOCK);
    for (let i = 0; i < AES_BLOCK; i++) padXor[i] = 0x10 ^ (lastC[i] ?? 0);

    const fakeEnc = new Uint8Array(
        await crypto.subtle.encrypt(
            {
                name: 'AES-CBC',
                iv: new ArrayBuffer(AES_BLOCK), 
            }, key, toAB(padXor),
        ),
    );

    const extended = concat(data, fakeEnc.subarray(0, AES_BLOCK));
    const dec = new Uint8Array(
        await crypto.subtle.decrypt({
            name: 'AES-CBC',
            iv: toAB(iv), 
        }, key, toAB(extended)),
    );
    return dec.subarray(0, data.length);
}

async function aesDec(key: CryptoKey, iv: Uint8Array, data: Uint8Array) {
    return new Uint8Array(
        await crypto.subtle.decrypt({
            name: 'AES-CBC',
            iv: toAB(iv), 
        }, key, toAB(data)),
    );
}

// ISO 32000-2 Algorithm 2.B — iterative hash for R=6
async function computeHash2B(
    password: Uint8Array,
    salt: Uint8Array,
    userKey: Uint8Array,
) {
    let K = await sha('SHA-256', concat(password, salt, userKey));
    let round = 0;

    for (;;) {
        const K1 = repeat(concat(password, K, userKey), 64);
        const aesKey = await importKey(K.subarray(0, 16), 128);
        const E = await aesEncNoPad(aesKey, K.subarray(16, 32), K1);

        let s = 0;
        for (let i = 0; i < 16; i++) s += E[i] ?? 0;
        const hashAlgos = [
            'SHA-256',
            'SHA-384',
            'SHA-512',
        ] as const;
        K = await sha(hashAlgos[s % 3]!, E);

        if (round >= 63 && (E[E.length - 1] ?? 0) <= round - 32) break;
        round++;
    }

    return K.subarray(0, 32);
}

interface IEncryptR6 {
    R: number;
    U: Uint8Array;
    UE: Uint8Array;
}

function parseEncryptDict(dict: PDFDict): IEncryptR6 | null {
    const R = safePdfDictLookupNumber(dict, PDFName.of('R'));
    const U = dict.get(PDFName.of('U'));
    const UE = dict.get(PDFName.of('UE'));

    if (!R || !U || !UE) {
        return null;
    }

    const uBytes = (U instanceof PDFString || U instanceof PDFHexString) ? U.asBytes() : null;
    const ueBytes = (UE instanceof PDFString || UE instanceof PDFHexString) ? UE.asBytes() : null;

    if (!uBytes || uBytes.length < 48 || !ueBytes || ueBytes.length < 32) {
        return null;
    }

    return {
        R: R.asNumber(),
        U: uBytes,
        UE: ueBytes, 
    };
}

async function deriveFileKey(params: IEncryptR6) {
    const empty = new Uint8Array(0);
    const valSalt = params.U.subarray(32, 40);
    const hash = await computeHash2B(empty, valSalt, empty);

    for (let i = 0; i < 32; i++) {
        if (hash[i] !== params.U[i]) {
            return null;
        }
    }

    const keySalt = params.U.subarray(40, 48);
    const keyHash = await computeHash2B(empty, keySalt, empty);
    const aesKey = await importKey(keyHash, 256);
    return aesDecNoPad(aesKey, new Uint8Array(AES_BLOCK), params.UE.subarray(0, 32));
}

async function decryptContent(
    fileKey: CryptoKey,
    data: Uint8Array,
) {
    if (data.length < MIN_ENCRYPTED_SIZE) {
        return null;
    }

    const iv = data.subarray(0, AES_BLOCK);
    const ct = data.subarray(AES_BLOCK);
    if (ct.length === 0 || ct.length % AES_BLOCK !== 0) {
        return null;
    }

    try {
        return await aesDec(fileKey, iv, ct);
    } catch {
        return null;
    }
}

function bytesToHexString(bytes: Uint8Array): PDFHexString {
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return PDFHexString.of(hex);
}

async function decryptStringsInDict(
    dict: PDFDict,
    fileKey: CryptoKey,
) {
    for (const [
        key,
        value,
    ] of dict.entries()) {
        if (value instanceof PDFString || value instanceof PDFHexString) {
            const dec = await decryptContent(fileKey, value.asBytes());
            if (dec) dict.set(key, bytesToHexString(dec));
        } else if (value instanceof PDFDict) {
            await decryptStringsInDict(value, fileKey);
        } else if (value instanceof PDFArray) {
            await decryptStringsInArray(value, fileKey);
        }
    }
}

async function decryptStringsInArray(
    arr: PDFArray,
    fileKey: CryptoKey,
) {
    for (let i = 0; i < arr.size(); i++) {
        const value = arr.get(i);
        if (value instanceof PDFString || value instanceof PDFHexString) {
            const dec = await decryptContent(fileKey, value.asBytes());
            if (dec) arr.set(i, bytesToHexString(dec));
        } else if (value instanceof PDFDict) {
            await decryptStringsInDict(value, fileKey);
        } else if (value instanceof PDFArray) {
            await decryptStringsInArray(value, fileKey);
        }
    }
}

async function decryptPdfRawStream(
    doc: PDFDocument,
    ref: PDFRef,
    obj: PDFRawStream,
    fileKey: CryptoKey,
) {
    const type = safePdfDictLookupName(obj.dict, PDFName.of('Type'));
    if (type?.toString() === '/XRef') {
        return;
    }

    const dec = await decryptContent(fileKey, obj.contents);
    if (dec) {
        doc.context.assign(ref, PDFRawStream.of(obj.dict, dec));
    }

    await decryptStringsInDict(obj.dict, fileKey);
}

async function decryptIndirectObject(
    doc: PDFDocument,
    ref: PDFRef,
    obj: unknown,
    fileKey: CryptoKey,
) {
    if (obj instanceof PDFRawStream) {
        await decryptPdfRawStream(doc, ref, obj, fileKey);
        return;
    }

    if (obj instanceof PDFDict) {
        await decryptStringsInDict(obj, fileKey);
        return;
    }

    if (obj instanceof PDFArray) {
        await decryptStringsInArray(obj, fileKey);
        return;
    }

    if (obj instanceof PDFString || obj instanceof PDFHexString) {
        const dec = await decryptContent(fileKey, obj.asBytes());
        if (dec) {
            doc.context.assign(ref, bytesToHexString(dec));
        }
    }
}

function hasEncryptMarker(data: Uint8Array) {
    const decoder = new TextDecoder('latin1');
    const marker = '/Encrypt';

    // The /Encrypt reference lives in the PDF trailer dictionary, found at
    // the end of the file (standard PDFs) or near the start (linearized PDFs).
    // Scanning only these regions avoids an O(n) full-file scan.
    const REGION = 32768;

    const headEnd = Math.min(REGION, data.length);
    if (decoder.decode(data.subarray(0, headEnd)).includes(marker)) {
        return true;
    }

    const tailStart = Math.max(headEnd, data.length - REGION);
    if (tailStart < data.length && decoder.decode(data.subarray(tailStart)).includes(marker)) {
        return true;
    }

    return false;
}

export async function stripPdfEncryption(data: Uint8Array) {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        return data;
    }
    if (!hasEncryptMarker(data)) {
        return data;
    }

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
    } catch {
        return data;
    }

    if (!doc.isEncrypted) {
        return data;
    }

    const encryptRef = doc.context.trailerInfo.Encrypt;
    if (!encryptRef || !(encryptRef instanceof PDFRef)) {
        return data;
    }

    const encryptDict = safePdfContextLookupDict(doc.context, encryptRef);
    if (!encryptDict) {
        return data;
    }

    const params = parseEncryptDict(encryptDict);
    if (!params || params.R !== 6) {
        return data;
    }

    let fileKeyBytes: Uint8Array | null;
    try {
        fileKeyBytes = await deriveFileKey(params);
    } catch {
        return data;
    }
    if (!fileKeyBytes) {
        return data;
    }

    const fileKey = await importKey(fileKeyBytes, 256);
    const encryptRefStr = encryptRef.toString();

    for (const [
        ref,
        obj,
    ] of doc.context.enumerateIndirectObjects()) {
        if (ref.toString() === encryptRefStr) continue;
        await decryptIndirectObject(doc, ref, obj, fileKey);
    }

    delete doc.context.trailerInfo.Encrypt;
    doc.context.delete(encryptRef);

    try {
        return await doc.save();
    } catch {
        return data;
    }
}
