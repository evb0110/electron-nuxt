import {
    open,
    rm,
} from 'node:fs/promises';
import {
    parseDocumentRevisionToken,
    type IDocumentRevisionInfo,
} from '@contracts/documentRevision';
import {isErrnoException} from '@contracts/runtimeGuards';
import {
    PageIdentitySidecarCorruptError,
    readPageIdentitySidecarHeader,
    streamPageIdentityIds,
} from '@electron/file-access/pageIdentitySidecarStreaming';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {quarantineCorruptFile} from '@electron/utils/quarantineCorruptFile';

const PAGE_IDENTITY_HEADER_BYTES = 64 * 1024;
const PAGE_IDENTITY_COPY_CHUNK_BYTES = 64 * 1024;

export function getPageIdentitySidecarPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-pages.json`;
}

/** Moves an unfenced page ledger aside so the next open can seed fresh IDs. */
export function quarantinePageIdentitySidecar(workingCopyPath: string) {
    return quarantineCorruptFile(getPageIdentitySidecarPath(workingCopyPath));
}

async function readSidecarPrefix(path: string) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
        handle = await open(path, 'r');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    try {
        const buffer = Buffer.alloc(PAGE_IDENTITY_HEADER_BYTES);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
            const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
            if (result.bytesRead === 0) {
                break;
            }
            bytesRead += result.bytesRead;
        }
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

async function writeAll(
    handle: Awaited<ReturnType<typeof open>>,
    buffer: Uint8Array,
) {
    let offset = 0;
    while (offset < buffer.byteLength) {
        const result = await handle.write(buffer, offset, buffer.byteLength - offset);
        if (result.bytesWritten < 1) {
            throw new Error('Page identity sidecar write made no progress');
        }
        offset += result.bytesWritten;
    }
}

function getRevisionTokenOffsets(prefix: Buffer, expectedToken: string) {
    const text = prefix.toString('utf8');
    const match = /("documentRevisionToken"\s*:\s*)("(?:\\.|[^"\\])*")/u.exec(text);
    if (!match) {
        throw new PageIdentitySidecarCorruptError('does not contain a readable document revision');
    }
    const encodedToken = match[2]!;
    let decodedToken: unknown;
    try {
        decodedToken = JSON.parse(encodedToken) as unknown;
    } catch (error) {
        throw new PageIdentitySidecarCorruptError('contains an invalid document revision', {cause: error});
    }
    if (decodedToken !== expectedToken) {
        throw new PageIdentitySidecarCorruptError('contains an inconsistent document revision');
    }
    const tokenStart = match.index + match[0].length - encodedToken.length;
    const tokenEnd = tokenStart + encodedToken.length;
    const prefixStart = Buffer.byteLength(text.slice(0, tokenStart), 'utf8');
    const prefixEnd = Buffer.byteLength(text.slice(0, tokenEnd), 'utf8');
    if (
        text.slice(0, tokenStart).includes('\uFFFD')
        || prefixEnd > prefix.byteLength
    ) {
        throw new PageIdentitySidecarCorruptError('has an unreadable document revision header');
    }
    return {
        prefixEnd,
        prefixStart,
    };
}

function validateSidecarHeader(
    header: Awaited<ReturnType<typeof readPageIdentitySidecarHeader>>,
    scan: Awaited<ReturnType<typeof streamPageIdentityIds>>,
) {
    if (!header) {
        throw new PageIdentitySidecarCorruptError('does not contain a readable header');
    }
    if (header.version === 1) {
        if (!scan.foundPageIds) {
            throw new PageIdentitySidecarCorruptError('does not contain page identities');
        }
        return;
    }
    if (
        header.version !== 2
        || header.storage !== 'ranges'
        || header.pageCount === undefined
        || !Number.isSafeInteger(header.pageCount)
        || header.pageCount < 0
        || (scan.foundPageIds && scan.count !== header.pageCount)
    ) {
        throw new PageIdentitySidecarCorruptError('contains an invalid identity header');
    }
}

async function replaceRevisionToken(
    sidecarPath: string,
    prefix: Buffer,
    prefixStart: number,
    prefixEnd: number,
    nextToken: string,
) {
    const tempPath = makeSiblingTempPath(sidecarPath);
    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
    let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        sourceHandle = await open(sidecarPath, 'r');
        const currentPrefix = Buffer.alloc(prefix.byteLength);
        let prefixBytesRead = 0;
        while (prefixBytesRead < currentPrefix.byteLength) {
            const prefixResult = await sourceHandle.read(
                currentPrefix,
                prefixBytesRead,
                currentPrefix.byteLength - prefixBytesRead,
                prefixBytesRead,
            );
            if (prefixResult.bytesRead === 0) {
                break;
            }
            prefixBytesRead += prefixResult.bytesRead;
        }
        if (
            prefixBytesRead !== prefix.byteLength
            || !currentPrefix.equals(prefix)
        ) {
            throw new PageIdentitySidecarCorruptError('changed while its revision was being rebound');
        }
        tempHandle = await open(tempPath, 'w');
        await writeAll(tempHandle, prefix.subarray(0, prefixStart));
        await writeAll(tempHandle, Buffer.from(JSON.stringify(nextToken), 'utf8'));
        await writeAll(tempHandle, prefix.subarray(prefixEnd));

        const buffer = Buffer.alloc(PAGE_IDENTITY_COPY_CHUNK_BYTES);
        let position = prefix.byteLength;
        for (;;) {
            const result = await sourceHandle.read(buffer, 0, buffer.byteLength, position);
            if (result.bytesRead === 0) {
                break;
            }
            await writeAll(tempHandle, buffer.subarray(0, result.bytesRead));
            position += result.bytesRead;
        }
        await tempHandle.close();
        tempHandle = undefined;
        await sourceHandle.close();
        sourceHandle = undefined;
        await atomicReplace(tempPath, sidecarPath);
    } finally {
        await tempHandle?.close().catch(() => undefined);
        await sourceHandle?.close().catch(() => undefined);
        await rm(tempPath, {force: true}).catch(() => undefined);
    }
}

/**
 * Rebinds only the revision token in an existing page ledger. Keeping the
 * original bytes means legacy and large range ledgers stay lazy, while the
 * streaming validation keeps malformed identity data from being published.
 * The caller supplies the revision that was current when the content commit
 * ran, so this module does not depend on the revision-sidecar module.
 */
export async function rebasePageIdentitySidecarRevision(
    workingCopyPath: string,
    previousRevision: IDocumentRevisionInfo | null,
    nextRevision: IDocumentRevisionInfo,
) {
    const sidecarPath = getPageIdentitySidecarPath(workingCopyPath);
    const header = await readPageIdentitySidecarHeader(sidecarPath);
    if (header === null) {
        const prefix = await readSidecarPrefix(sidecarPath);
        if (prefix !== null) {
            throw new PageIdentitySidecarCorruptError('does not contain a readable header');
        }
        return;
    }
    const sidecarToken = header.documentRevisionToken;
    if (
        sidecarToken === undefined
        || parseDocumentRevisionToken(sidecarToken) === null
    ) {
        throw new PageIdentitySidecarCorruptError('does not declare a document revision');
    }
    if (!previousRevision) {
        throw new Error('Cannot rebase page identity sidecar without a current document revision');
    }
    if (
        nextRevision.token !== previousRevision.token
        && nextRevision.contentRevision !== previousRevision.contentRevision + 1
    ) {
        throw new Error('Page identity publication has a stale document revision');
    }
    if (sidecarToken === nextRevision.token) {
        return;
    }
    if (sidecarToken !== previousRevision.token) {
        throw new Error('Page identity state belongs to a stale document revision');
    }

    const scan = await streamPageIdentityIds(sidecarPath);
    validateSidecarHeader(header, scan);
    const prefix = await readSidecarPrefix(sidecarPath);
    if (prefix === null) {
        throw new PageIdentitySidecarCorruptError('disappeared while its revision was being rebound');
    }
    const {
        prefixEnd,
        prefixStart,
    } = getRevisionTokenOffsets(prefix, sidecarToken);
    await replaceRevisionToken(
        sidecarPath,
        prefix,
        prefixStart,
        prefixEnd,
        nextRevision.token,
    );
}
