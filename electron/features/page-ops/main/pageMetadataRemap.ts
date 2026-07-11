import {randomUUID} from 'node:crypto';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {
    IPageOpsMetadataSnapshot,
    IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/publicNative';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';

const PAGE_METADATA_REMAP_TIMEOUT_MS = 2 * 60 * 1000;

function createOldToNewPageIndex(delta: IPageIdentityDelta) {
    const oldToNew = new Map<number, number>();
    delta.pages.forEach((page, newPageIndex) => {
        if ('fromPageNumber' in page) {
            oldToNew.set(page.fromPageNumber - 1, newPageIndex);
        }
    });
    return oldToNew;
}

function remapBookmarkItems(
    items: readonly IPdfBookmarkEntry[],
    oldToNew: ReadonlyMap<number, number>,
): IPdfBookmarkEntry[] {
    return items.flatMap(item => {
        const children = remapBookmarkItems(item.items, oldToNew);
        if (item.pageIndex === null) {
            return [{
                ...item,
                items: children,
            }];
        }
        const pageIndex = oldToNew.get(item.pageIndex);
        if (pageIndex === undefined) {
            return children;
        }
        return [{
            ...item,
            pageIndex,
            namedDest: null,
            items: children,
        }];
    });
}

export function remapPageMetadata(
    metadata: IPageOpsMetadataSnapshot,
    delta: IPageIdentityDelta,
) {
    const oldToNew = createOldToNewPageIndex(delta);
    const labels = metadata.pageLabels?.length === delta.previousPageCount
        ? delta.pages.map((page, index) => (
            'fromPageNumber' in page
                ? metadata.pageLabels![page.fromPageNumber - 1] ?? String(index + 1)
                : String(index + 1)
        ))
        : null;
    return {
        pageLabels: {
            totalPages: delta.pages.length,
            ranges: labels?.map((label, index) => ({
                startPage: index + 1,
                style: null,
                prefix: label,
                startNumber: 1,
            })) ?? [],
        },
        bookmarks: {
            totalPages: delta.pages.length,
            untitledLabel: metadata.untitledBookmarkLabel,
            items: remapBookmarkItems(metadata.bookmarks, oldToNew),
        },
    };
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
        await writeFile(
            mutationsPath,
            JSON.stringify(remapPageMetadata(input.metadataSnapshot, input.delta)),
            'utf8',
        );
        await runNativeToolCommand(binaryPath, [
            'save-mutations',
            '--input',
            input.workingCopyPath,
            '--output',
            input.workingCopyPath,
            '--mutations-file',
            mutationsPath,
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
