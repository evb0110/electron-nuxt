import type { TDocumentRef } from '@contracts/documentRef';
import type { TDjvuPdfExportStrategy } from '@contracts/djvuConversionPolicy';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import type {
    TPdfViewMode,
    TPrintOrientation,
} from '@contracts/shared';
import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    ISearchMatchOptions,
} from '@contracts/search';
import {
    DJVU_OUTLINE_MAX_DEPTH,
    DJVU_OUTLINE_MAX_NODES,
    DJVU_OUTLINE_MAX_TITLE_CHARS,
    DJVU_SEARCH_MAX_PAGE_TEXT_CHARS,
} from '@contracts/djvuResourceLimits';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';

export type { TDjvuPdfExportStrategy } from '@contracts/djvuConversionPolicy';

export interface IDjvuProgress {
    jobId: string;
    requestId?: string;
    documentRef?: TDocumentRef;
    phase: 'converting' | 'bookmarks' | 'optimizing' | 'loading' | 'printing';
    status?: 'running' | 'success' | 'canceled' | 'failed';
    current?: number;
    total?: number;
    percent: number;
    error?: string;
}

export const DJVU_DOCUMENT_OUTPUT_OPERATIONS = [
    'djvu-convert',
    'djvu-open',
    'djvu-print',
] as const;

export type TDjvuDocumentOutputOperation = typeof DJVU_DOCUMENT_OUTPUT_OPERATIONS[number];

export function isDjvuDocumentOutputOperation(value: unknown): value is TDjvuDocumentOutputOperation {
    return DJVU_DOCUMENT_OUTPUT_OPERATIONS.some(operation => value === operation);
}

export type TDocumentOutputOperation = TDjvuDocumentOutputOperation;

export type TDocumentOutputJobState =
    | {
        jobId: string;
        operation: TDocumentOutputOperation;
        status: 'queued' | 'running';
        progress: IDjvuProgress;
        updatedAtMs: number;
    }
    | {
        jobId: string;
        operation: TDocumentOutputOperation;
        status: 'handoff';
        artifactPath: TDocumentRef;
        progress: IDjvuProgress;
        updatedAtMs: number;
    }
    | {
        jobId: string;
        operation: TDocumentOutputOperation;
        status: 'completed';
        artifactPath?: TDocumentRef;
        progress: IDjvuProgress;
        updatedAtMs: number;
    }
    | {
        jobId: string;
        operation: TDocumentOutputOperation;
        status: 'canceled' | 'failed';
        error?: string;
        progress: IDjvuProgress;
        updatedAtMs: number;
    };

export interface IDjvuInfo {
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}

export interface IDjvuSizeEstimate {
    subsample: number;
    label: string;
    description: string;
    resultingDpi: number;
    estimatedBytes: number;
}

export interface IDjvuPageSize {
    width: number;
    height: number;
    dpi: number;
}

export interface IDjvuPageSourceInfo {
    pageCount: number;
    pageNumber: number;
    pageSize: IDjvuPageSize;
    /** Native source revision used to fence trusted pre-open geometry. */
    sourceSize?: number;
    sourceModifiedAt?: number;
}

export interface IDjvuOutlineItem {
    title: string;
    pageNumber: number | null;
    children: IDjvuOutlineItem[];
}

export function decodeDjvuPageText(value: unknown) {
    if (typeof value !== 'string') {
        throw new Error('DjVu page text must be a string');
    }
    if (value.length > DJVU_SEARCH_MAX_PAGE_TEXT_CHARS) {
        throw new Error('DjVu page text exceeds the supported limit');
    }
    return value;
}

export function decodeDjvuOutline(value: unknown): IDjvuOutlineItem[] {
    if (!Array.isArray(value)) {
        throw new Error('DjVu outline must be an array');
    }
    const result: IDjvuOutlineItem[] = [];
    const items = value as unknown[];
    const stack: Array<{
        depth: number;
        item: unknown;
        target: IDjvuOutlineItem[];
    }> = items.toReversed().map(item => ({
        depth: 1,
        item,
        target: result,
    }));
    let nodeCount = 0;
    let titleChars = 0;
    while (stack.length > 0) {
        const entry = stack.pop()!;
        if (
            !isRecord(entry.item)
            || typeof entry.item.title !== 'string'
            || (
                entry.item.pageNumber !== null
                && (
                    !Number.isSafeInteger(entry.item.pageNumber)
                    || Number(entry.item.pageNumber) < 1
                )
            )
            || !Array.isArray(entry.item.children)
        ) {
            throw new Error('invalid DjVu outline item');
        }
        nodeCount += 1;
        titleChars += entry.item.title.length;
        if (
            entry.depth > DJVU_OUTLINE_MAX_DEPTH
            || nodeCount > DJVU_OUTLINE_MAX_NODES
            || titleChars > DJVU_OUTLINE_MAX_TITLE_CHARS
        ) {
            throw new Error('DjVu outline exceeds the supported limit');
        }
        const mapped: IDjvuOutlineItem = {
            title: entry.item.title,
            pageNumber: entry.item.pageNumber === null ? null : Number(entry.item.pageNumber),
            children: [],
        };
        entry.target.push(mapped);
        const children = entry.item.children as unknown[];
        for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push({
                depth: entry.depth + 1,
                item: children[index],
                target: mapped.children,
            });
        }
    }
    return result;
}

export function decodeDjvuPageSize(value: unknown): IDjvuPageSize {
    if (
        !isRecord(value)
        || !isFiniteNumber(value.width)
        || !isFiniteNumber(value.height)
        || !isFiniteNumber(value.dpi)
    ) {
        throw new Error('invalid DjVu page size');
    }
    return {
        width: value.width,
        height: value.height,
        dpi: value.dpi,
    };
}

export function decodeDjvuPageSizes(value: unknown) {
    if (!Array.isArray(value)) {
        throw new Error('page sizes must be an array');
    }
    return (value as unknown[]).map(decodeDjvuPageSize);
}

export function decodeDjvuPageSourceInfo(value: unknown): IDjvuPageSourceInfo {
    if (
        !isRecord(value)
        || !Number.isSafeInteger(value.pageCount)
        || Number(value.pageCount) < 1
        || !Number.isSafeInteger(value.pageNumber)
        || Number(value.pageNumber) < 1
        || Number(value.pageNumber) > Number(value.pageCount)
    ) {
        throw new Error('invalid DjVu page source info');
    }
    return {
        pageCount: Number(value.pageCount),
        pageNumber: Number(value.pageNumber),
        pageSize: decodeDjvuPageSize(value.pageSize),
        ...(Number.isSafeInteger(value.sourceSize) && Number(value.sourceSize) >= 0
            ? {sourceSize: Number(value.sourceSize)}
            : {}),
        ...(Number.isSafeInteger(value.sourceModifiedAt) && Number(value.sourceModifiedAt) >= 0
            ? {sourceModifiedAt: Number(value.sourceModifiedAt)}
            : {}),
    };
}

export interface IDjvuPagePreview {
    bytes: Uint8Array;
    width: number;
    height: number;
}

export function decodeDjvuPagePreview(value: unknown): IDjvuPagePreview {
    if (
        !isRecord(value)
        || !(value.bytes instanceof Uint8Array)
        || !isFiniteNumber(value.width)
        || !isFiniteNumber(value.height)
    ) {
        throw new Error('invalid DjVu page preview');
    }
    return {
        bytes: value.bytes,
        width: value.width,
        height: value.height,
    };
}

export interface IDjvuPagePreviewOptions {
    previewPriority?: number;
    previewRequestId?: string;
    subsample?: number;
    targetWidthPx?: number;
}

export interface IDjvuTextSearchOptions extends ISearchMatchOptions {
    requestId: string;
    pageCount: number;
}

export interface IDjvuTextSearchProgress extends IPdfSearchProgress {}

export interface IDjvuTextSearchResponse extends IPdfSearchResponse {}

export interface IDjvuConvertOptions {
    jobId?: string;
    subsample?: number;
    preserveBookmarks?: boolean;
    pdfStrategy?: TDjvuPdfExportStrategy;
    requestId?: string;
    documentRef?: TDocumentRef;
    hostTier?: THostResourceTier;
}

export interface IDjvuJobStartHandle {
    jobId: string;
    requestId: string;
}

export interface IDjvuPrintOptions {
    fileName?: string;
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
    requestId?: string;
    subsample?: number;
    pdfStrategy?: TDjvuPdfExportStrategy;
}

export interface IDjvuOpenResult {
    success: boolean;
    pageCount?: number;
    pageSourceInfo?: IDjvuPageSourceInfo;
    jobId?: string;
    error?: string;
}

export interface IDjvuConvertResult {
    success: boolean;
    pdfPath?: TDocumentRef;
    jobId?: string;
    requestId?: string;
    documentRef?: TDocumentRef;
    error?: string;
}

export interface IDjvuPrintResult {
    success: boolean;
    canceled?: boolean;
    jobId?: string;
    error?: string;
}
