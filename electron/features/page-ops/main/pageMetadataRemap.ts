import {randomUUID} from 'node:crypto';
import {
    mkdtemp,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {
    IPageOpsMetadataSnapshot,
    IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import {mapPageNumberThroughPageIdentityDelta} from '@contracts/electronApiPageOps';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/main/nativePageOpsPath';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';

const PAGE_METADATA_REMAP_TIMEOUT_MS = 2 * 60 * 1000;

function remapBookmarkItems(
    items: readonly IPdfBookmarkEntry[],
    delta: IPageIdentityDelta,
): IPdfBookmarkEntry[] {
    return items.flatMap(item => {
        const children = remapBookmarkItems(item.items, delta);
        if (item.pageIndex === null) {
            return [{
                ...item,
                items: children,
            }];
        }
        const mappedPageNumber = mapPageNumberThroughPageIdentityDelta(delta, item.pageIndex + 1);
        if (mappedPageNumber === null) {
            return children;
        }
        return [{
            ...item,
            pageIndex: mappedPageNumber - 1,
            namedDest: null,
            items: children,
        }];
    });
}

function remapKnownPageLabels(
    pageLabels: readonly string[],
    delta: IPageIdentityDelta,
    nextPageCount: number | undefined,
) {
    if (pageLabels.length !== delta.previousPageCount || nextPageCount === undefined) {
        return undefined;
    }
    const remapped = Array<string | undefined>(nextPageCount);
    if (delta.pages !== undefined) {
        delta.pages.forEach((page, index) => {
            remapped[index] = 'fromPageNumber' in page
                ? pageLabels[page.fromPageNumber - 1]
                : undefined;
        });
    } else {
        for (const range of delta.ranges ?? []) {
            if (range.kind !== 'retain' && range.kind !== 'move') continue;
            for (let offset = 0; offset < range.count; offset += 1) {
                remapped[range.toPageNumber - 1 + offset] = pageLabels[range.fromPageNumber - 1 + offset];
            }
        }
    }
    return remapped.map((label, index) => label ?? String(index + 1));
}

export function remapPageMetadata(
    metadata: IPageOpsMetadataSnapshot,
    delta: IPageIdentityDelta,
) {
    const nextPageCount = delta.nextPageCount ?? delta.pages?.length;
    const labels = metadata.pageLabels === undefined
        ? undefined
        : metadata.pageLabels === null
            ? []
            : remapKnownPageLabels(metadata.pageLabels, delta, nextPageCount);
    const result: {
        pageLabels?: {
            totalPages: number;
            ranges: Array<{
                startPage: number;
                style: null;
                prefix: string;
                startNumber: number;
            }>;
        };
        bookmarks?: {
            totalPages: number;
            untitledLabel: string;
            items: IPdfBookmarkEntry[];
        };
    } = {};
    if (labels !== undefined) {
        result.pageLabels = {
            totalPages: nextPageCount ?? 0,
            ranges: labels.map((label, index) => ({
                startPage: index + 1,
                style: null,
                prefix: label,
                startNumber: 1,
            })),
        };
    }
    if (metadata.bookmarks !== undefined) {
        result.bookmarks = {
            totalPages: nextPageCount ?? 0,
            untitledLabel: metadata.untitledBookmarkLabel,
            items: remapBookmarkItems(metadata.bookmarks, delta),
        };
    }
    return result;
}

function createNativeModifiedAt() {
    const date = new Date();
    const pad = (value: number, length = 2) => String(value).padStart(length, '0');
    return `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export async function applyPageMetadataRemap(input: {
    workingCopyPath: string;
    delta: IPageIdentityDelta;
    metadataSnapshot?: IPageOpsMetadataSnapshot;
    signal: AbortSignal;
    cancelGroup: string;
}) {
    if (!input.metadataSnapshot) {
        return;
    }
    if (isNativePageOpsDisabled()) {
        throw new Error('Cannot safely remap PDF page metadata while native page operations are disabled');
    }
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Cannot safely remap PDF page metadata because the native page tool is unavailable');
    }
    const tempDir = await mkdtemp(join(tmpdir(), `page-metadata-${randomUUID()}-`));
    const mutationsPath = join(tempDir, 'mutations.json');
    try {
        const workingCopyStat = await stat(input.workingCopyPath, {bigint: true});
        if (!workingCopyStat.isFile() || workingCopyStat.nlink !== 1n) {
            throw new Error('Page metadata remap requires an exclusively owned working-copy inode');
        }
        const mutations = remapPageMetadata(input.metadataSnapshot, input.delta);
        if (Object.keys(mutations).length === 0) {
            return;
        }
        await writeFile(mutationsPath, JSON.stringify(mutations), 'utf8');
        await runNativeToolCommand(binaryPath, [
            'save-mutations',
            '--input',
            input.workingCopyPath,
            '--output',
            input.workingCopyPath,
            '--mutations-file',
            mutationsPath,
            '--qpdf',
            getPdfNativeToolPaths().qpdf,
            '--modified-at',
            createNativeModifiedAt(),
            '--append',
        ], {
            timeoutMs: PAGE_METADATA_REMAP_TIMEOUT_MS,
            commandLabel: 'evb-pdf-page-ops(page-metadata-remap)',
            signal: input.signal,
            cancelGroup: input.cancelGroup,
        });
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    }
}
