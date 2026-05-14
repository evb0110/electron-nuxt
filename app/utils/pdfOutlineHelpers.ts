import type { PDFDocumentProxy } from 'pdfjs-dist';
import { clamp } from 'es-toolkit/math';
import type {
    IBookmarkItem,
    IBookmarkLocation,
} from '@app/types/pdfOutline';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getOptionalArray,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';

interface IRefProxy {
    num: number;
    gen: number;
}

const OUTLINE_LOG_SECTION = 'pdfOutline';

export interface IOutlineItemRaw {
    title: string;
    dest: string | unknown[] | null;
    bold?: boolean | undefined;
    italic?: boolean | undefined;
    color?: ArrayLike<number> | null | undefined;
    items?: IOutlineItemRaw[] | undefined;
}

function isRefProxy(value: unknown): value is IRefProxy {
    return isRecord(value)
        && typeof value.num === 'number'
        && typeof value.gen === 'number';
}

export { isRefProxy };

function normalizeOutlineDest(value: unknown): IOutlineItemRaw['dest'] {
    if (typeof value === 'string' || value === null || Array.isArray(value)) {
        return value;
    }

    return null;
}

function isOutlineColorCandidate(value: unknown): value is ArrayLike<number> {
    return isRecord(value)
        && typeof value.length === 'number'
        && value.length >= 3
        && typeof value[0] === 'number'
        && typeof value[1] === 'number'
        && typeof value[2] === 'number';
}

function normalizeOutlineColor(value: unknown): ArrayLike<number> | null {
    return isOutlineColorCandidate(value) ? value : null;
}

function normalizeOutlineItem(value: unknown): IOutlineItemRaw | null {
    if (!isRecord(value)) {
        return null;
    }

    const title = getOptionalString(value, 'title') ?? '';
    const items = getOptionalArray(value, 'items');

    return {
        title,
        dest: normalizeOutlineDest(value.dest ?? null),
        bold: value.bold === true ? true : undefined,
        italic: value.italic === true ? true : undefined,
        color: normalizeOutlineColor(value.color),
        items: items
            ? parseOutlineItems(items)
            : undefined,
    };
}

export function parseOutlineItems(value: unknown): IOutlineItemRaw[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(normalizeOutlineItem)
        .filter(item => item !== null);
}

export function convertOutlineColorToHex(color: ArrayLike<number> | null | undefined): string | null {
    if (!color || typeof color.length !== 'number' || color.length < 3) {
        return null;
    }

    const parts = [
        color[0],
        color[1],
        color[2],
    ];

    const rgb = parts.map((value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return 0;
        }
        return clamp(Math.round(numeric), 0, 255);
    });

    return `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function normalizeDestinationPageIndex(rawPageRef: number, numPages: number) {
    const maybeIndex = Math.trunc(rawPageRef);
    if (maybeIndex >= 0 && maybeIndex < numPages) {
        return maybeIndex;
    }
    if (maybeIndex > 0 && maybeIndex <= numPages) {
        return maybeIndex - 1;
    }
    return null;
}

async function resolveDestinationArray(
    pdfDocument: PDFDocumentProxy,
    dest: IOutlineItemRaw['dest'],
    destinationCache?: Map<string, unknown[] | null>,
): Promise<unknown[] | null> {
    if (!dest) {
        return null;
    }
    if (Array.isArray(dest)) {
        return dest;
    }
    if (typeof dest !== 'string') {
        return null;
    }

    if (destinationCache?.has(dest)) {
        return destinationCache.get(dest) ?? null;
    }

    try {
        const resolved = await pdfDocument.getDestination(dest);
        destinationCache?.set(dest, resolved);
        return resolved;
    } catch (error) {
        BrowserLogger.debug(OUTLINE_LOG_SECTION, `Failed to resolve named destination: ${dest}`, error);
        destinationCache?.set(dest, null);
        return null;
    }
}

export async function resolvePageIndex(
    pdfDocument: PDFDocumentProxy,
    dest: IOutlineItemRaw['dest'],
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
): Promise<number | null> {
    if (!dest) {
        return null;
    }

    const destinationArray = await resolveDestinationArray(pdfDocument, dest, destinationCache);

    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const pageRef = destinationArray[0];

    if (typeof pageRef === 'number' && Number.isFinite(pageRef)) {
        return normalizeDestinationPageIndex(pageRef, pdfDocument.numPages);
    }

    if (!isRefProxy(pageRef)) {
        return null;
    }

    const refKey = `${pageRef.num}:${pageRef.gen}`;
    if (refIndexCache.has(refKey)) {
        return refIndexCache.get(refKey) ?? null;
    }

    try {
        const pageIndex = await pdfDocument.getPageIndex(pageRef);
        refIndexCache.set(refKey, pageIndex);
        return pageIndex;
    } catch (error) {
        BrowserLogger.debug(OUTLINE_LOG_SECTION, `Failed to resolve page index by reference: ${refKey}`, error);
        refIndexCache.set(refKey, null);
        return null;
    }
}

export async function buildResolvedOutline(
    items: IOutlineItemRaw[],
    pdfDocument: PDFDocumentProxy,
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
    createId: () => string,
): Promise<IBookmarkItem[]> {
    return Promise.all(
        items.map(async (item) => {
            const pageIndex = await resolvePageIndex(
                pdfDocument,
                item.dest,
                destinationCache,
                refIndexCache,
            );
            const children = item.items?.length
                ? await buildResolvedOutline(
                    item.items,
                    pdfDocument,
                    destinationCache,
                    refIndexCache,
                    createId,
                )
                : [];

            return {
                title: item.title,
                dest: item.dest,
                id: createId(),
                pageIndex,
                bold: item.bold === true,
                italic: item.italic === true,
                color: convertOutlineColorToHex(item.color),
                items: children,
            };
        }),
    );
}

export async function resolveBookmarkDestinationPage(
    pdfDocument: PDFDocumentProxy,
    dest: string | unknown[] | null,
): Promise<number | null> {
    if (!dest) {
        return null;
    }

    const destinationArray = await resolveDestinationArray(pdfDocument, dest);

    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const pageRef = destinationArray[0];

    if (typeof pageRef === 'number' && Number.isFinite(pageRef)) {
        const zeroBasedIndex = normalizeDestinationPageIndex(pageRef, pdfDocument.numPages);
        return zeroBasedIndex === null ? null : zeroBasedIndex + 1;
    }

    if (!isRefProxy(pageRef)) {
        return null;
    }

    try {
        const pageIndex = await pdfDocument.getPageIndex(pageRef);
        return pageIndex + 1;
    } catch (error) {
        BrowserLogger.debug(OUTLINE_LOG_SECTION, 'Failed to resolve bookmark destination page by reference', error);
        return null;
    }
}

export function findBookmarkLocation(
    items: IBookmarkItem[],
    id: string,
    parent: IBookmarkItem | null = null,
): IBookmarkLocation | null {
    for (const [
        index,
        item,
    ] of items.entries()) {
        if (item.id === id) {
            return {
                parent,
                list: items,
                index,
                item,
            };
        }

        const child = findBookmarkLocation(item.items, id, item);
        if (child) {
            return child;
        }
    }

    return null;
}

export function findBookmarkById(items: IBookmarkItem[], id: string): IBookmarkItem | null {
    for (const item of items) {
        if (item.id === id) {
            return item;
        }
        const child = findBookmarkById(item.items, id);
        if (child) {
            return child;
        }
    }

    return null;
}

export function collectBookmarkIds(item: IBookmarkItem, ids: Set<string>) {
    ids.add(item.id);
    for (const child of item.items) {
        collectBookmarkIds(child, ids);
    }
}

export function flattenBookmarks(items: IBookmarkItem[]) {
    const flattened: IBookmarkItem[] = [];

    function visit(source: IBookmarkItem[]) {
        for (const item of source) {
            flattened.push(item);
            visit(item.items);
        }
    }

    visit(items);
    return flattened;
}

export function normalizeBookmarkColor(color: string | null | undefined): string | null {
    if (typeof color !== 'string') {
        return null;
    }

    const value = color.trim().toLowerCase();
    const shortHexMatch = /^#([0-9a-f]{3})$/.exec(value);
    if (shortHexMatch) {
        const triple = shortHexMatch[1];
        if (!triple) {
            return null;
        }
        const [
            r,
            g,
            b,
        ] = triple.split('');
        return `#${r}${r}${g}${g}${b}${b}`;
    }

    return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}
