import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';
import { clamp } from 'es-toolkit/math';
import type {
    IBookmarkItem,
    IBookmarkLocation,
    TCreateBookmarkId,
} from '@app/types/pdfOutline';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
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
const MAX_OUTLINE_DEPTH = 256;
const MAX_OUTLINE_ITEMS = 10000;

export interface IOutlineItemRaw {
    title: string;
    dest: string | unknown[] | null;
    bold?: boolean | undefined;
    italic?: boolean | undefined;
    color?: ArrayLike<number> | null | undefined;
    items?: IOutlineItemRaw[] | undefined;
}

export interface IBookmarkDestinationTarget {
    page: number;
    pageYRatio?: number | null | undefined;
}

/**
 * Returns a fast page-level bookmark target from the outline's cached page index.
 * Full PDF.js destination resolution can lag on large files, so bookmark clicks
 * first move to the known page and then refine once the exact destination resolves.
 */
export function resolveImmediateBookmarkDestinationTarget(
    item: Pick<IBookmarkItem, 'pageIndex' | 'pageYRatio'>,
): IBookmarkDestinationTarget | null {
    if (typeof item.pageIndex !== 'number' || !Number.isFinite(item.pageIndex)) {
        return null;
    }

    return {
        page: Math.max(0, Math.trunc(item.pageIndex)) + 1,
        pageYRatio: typeof item.pageYRatio === 'number' && Number.isFinite(item.pageYRatio)
            ? clamp(item.pageYRatio, 0, 1)
            : 0,
    };
}

function normalizeBookmarkDestinationRatio(target: IBookmarkDestinationTarget) {
    return typeof target.pageYRatio === 'number' && Number.isFinite(target.pageYRatio)
        ? target.pageYRatio
        : null;
}

function areBookmarkDestinationTargetsEquivalent(
    first: IBookmarkDestinationTarget,
    second: IBookmarkDestinationTarget,
) {
    return first.page === second.page
        && normalizeBookmarkDestinationRatio(first) === normalizeBookmarkDestinationRatio(second);
}

/**
 * Preserves bookmark destination intent by replaying async refinement after the
 * fast jump. Equal resolved targets are still useful for virtualized PDFs where
 * the first snap can run before the destination page DOM is ready.
 */
export function shouldEmitResolvedBookmarkDestinationTarget(
    target: IBookmarkDestinationTarget,
    immediateTarget: IBookmarkDestinationTarget | null,
) {
    if (immediateTarget === null || !areBookmarkDestinationTargetsEquivalent(target, immediateTarget)) {
        return true;
    }

    return typeof target.pageYRatio === 'number' && Number.isFinite(target.pageYRatio);
}

interface IPageViewBounds {
    top: number;
    bottom: number;
    height: number;
}

function isRefProxy(value: unknown): value is IRefProxy {
    return isRecord(value)
        && typeof value.num === 'number'
        && typeof value.gen === 'number';
}

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

    return {
        title,
        dest: normalizeOutlineDest(value.dest ?? null),
        bold: value.bold === true ? true : undefined,
        italic: value.italic === true ? true : undefined,
        color: normalizeOutlineColor(value.color),
    };
}

export function parseOutlineItems(value: unknown): IOutlineItemRaw[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const root: IOutlineItemRaw[] = [];
    const stack: Array<{
        value: unknown;
        target: IOutlineItemRaw[];
        depth: number;
    }> = [];
    let acceptedCount = 0;
    let skippedOverLimit = false;

    for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({
            value: value[index],
            target: root,
            depth: 1,
        });
    }

    while (stack.length > 0) {
        const frame = stack.pop();
        if (!frame) {
            break;
        }
        if (acceptedCount >= MAX_OUTLINE_ITEMS) {
            skippedOverLimit = true;
            continue;
        }

        const normalized = normalizeOutlineItem(frame.value);
        if (!normalized) {
            continue;
        }

        acceptedCount += 1;
        frame.target.push(normalized);

        const childValues = isRecord(frame.value)
            ? getOptionalArray(frame.value, 'items')
            : null;
        if (!childValues?.length) {
            continue;
        }

        if (frame.depth >= MAX_OUTLINE_DEPTH) {
            skippedOverLimit = true;
            continue;
        }

        normalized.items = [];
        for (let index = childValues.length - 1; index >= 0; index -= 1) {
            stack.push({
                value: childValues[index],
                target: normalized.items,
                depth: frame.depth + 1,
            });
        }
    }

    if (skippedOverLimit) {
        BrowserLogger.warn(OUTLINE_LOG_SECTION, 'Skipped over-limit PDF outline items', {
            maxDepth: MAX_OUTLINE_DEPTH,
            maxItems: MAX_OUTLINE_ITEMS,
        });
    }

    return root;
}

export function convertOutlineColorToHex(color: ArrayLike<number> | null | undefined) {
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

function normalizeDestinationKind(value: string) {
    return value.startsWith('/') ? value.slice(1) : value;
}

function getDestinationKind(destinationArray: unknown[]) {
    const rawKind = destinationArray[1];
    if (typeof rawKind === 'string') {
        return normalizeDestinationKind(rawKind);
    }
    if (isRecord(rawKind)) {
        const name = getOptionalString(rawKind, 'name');
        return name ? normalizeDestinationKind(name) : null;
    }
    return null;
}

function getFiniteDestinationNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function getDestinationTopValue(destinationArray: unknown[], destinationKind: string | null) {
    switch (destinationKind) {
        case 'XYZ':
            return getFiniteDestinationNumber(destinationArray[3]);
        case 'FitH':
        case 'FitBH':
            return getFiniteDestinationNumber(destinationArray[2]);
        case 'FitR':
            return getFiniteDestinationNumber(destinationArray[5]);
        default:
            return null;
    }
}

function shouldAlignDestinationToPageTop(destinationKind: string | null) {
    return destinationKind === 'XYZ'
        || destinationKind === 'Fit'
        || destinationKind === 'FitB'
        || destinationKind === 'FitH'
        || destinationKind === 'FitBH'
        || destinationKind === 'FitR';
}

function getPageViewBounds(page: PDFPageProxy): IPageViewBounds | null {
    const view = Array.isArray(page.view) ? page.view : null;
    const top = view ? getFiniteDestinationNumber(view[3]) : null;
    const bottom = view ? getFiniteDestinationNumber(view[1]) : null;

    if (top !== null && bottom !== null && top > bottom) {
        return {
            top,
            bottom,
            height: top - bottom,
        };
    }

    const viewport = page.getViewport({ scale: 1 });
    const height = getFiniteDestinationNumber(viewport.height);
    if (height !== null && height > 0) {
        return {
            top: height,
            bottom: 0,
            height,
        };
    }

    return null;
}

async function resolveDestinationPageYRatio(
    pdfDocument: PDFDocumentProxy,
    page: number,
    destinationArray: unknown[],
) {
    const destinationKind = getDestinationKind(destinationArray);
    if (!shouldAlignDestinationToPageTop(destinationKind)) {
        return null;
    }

    const destinationTop = getDestinationTopValue(destinationArray, destinationKind);
    if (destinationTop === null) {
        return 0;
    }

    try {
        const pdfPage = await pdfDocument.getPage(page);
        const bounds = getPageViewBounds(pdfPage);
        if (!bounds) {
            return null;
        }

        return clamp((bounds.top - destinationTop) / bounds.height, 0, 1);
    } catch (error) {
        BrowserLogger.debug(OUTLINE_LOG_SECTION, `Failed to resolve bookmark destination y for page ${page}`, error);
        return null;
    }
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

async function resolvePageIndexFromDestinationArray(
    pdfDocument: PDFDocumentProxy,
    destinationArray: unknown[],
    refIndexCache?: Map<string, number | null>,
) {
    if (destinationArray.length === 0) {
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
    if (refIndexCache?.has(refKey)) {
        return refIndexCache.get(refKey) ?? null;
    }

    try {
        const pageIndex = await pdfDocument.getPageIndex(pageRef);
        refIndexCache?.set(refKey, pageIndex);
        return pageIndex;
    } catch (error) {
        BrowserLogger.debug(OUTLINE_LOG_SECTION, `Failed to resolve page index by reference: ${refKey}`, error);
        refIndexCache?.set(refKey, null);
        return null;
    }
}

export async function resolvePageIndex(
    pdfDocument: PDFDocumentProxy,
    dest: IOutlineItemRaw['dest'],
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
) {
    if (!dest) {
        return null;
    }

    const destinationArray = await resolveDestinationArray(pdfDocument, dest, destinationCache);

    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    return resolvePageIndexFromDestinationArray(pdfDocument, destinationArray, refIndexCache);
}

async function resolveDestinationTarget(
    pdfDocument: PDFDocumentProxy,
    dest: IOutlineItemRaw['dest'],
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
) {
    if (!dest) {
        return null;
    }

    const destinationArray = await resolveDestinationArray(pdfDocument, dest, destinationCache);
    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const pageIndex = await resolvePageIndexFromDestinationArray(pdfDocument, destinationArray, refIndexCache);
    if (pageIndex === null) {
        return null;
    }

    const pageYRatio = await resolveDestinationPageYRatio(pdfDocument, pageIndex + 1, destinationArray);
    return {
        pageIndex,
        pageYRatio,
    };
}

export async function buildResolvedOutline(
    items: IOutlineItemRaw[],
    pdfDocument: PDFDocumentProxy,
    destinationCache: Map<string, unknown[] | null>,
    refIndexCache: Map<string, number | null>,
    createId: TCreateBookmarkId,
): Promise<IBookmarkItem[]> {
    const root: IBookmarkItem[] = [];
    const stack: Array<{
        item: IOutlineItemRaw;
        target: IBookmarkItem[];
        parentId: string | null;
        depth: number;
    }> = [];
    let acceptedCount = 0;
    let skippedOverLimit = false;

    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item) {
            stack.push({
                item,
                target: root,
                parentId: null,
                depth: 1,
            });
        }
    }

    while (stack.length > 0) {
        const frame = stack.pop();
        if (!frame) {
            break;
        }
        if (acceptedCount >= MAX_OUTLINE_ITEMS) {
            skippedOverLimit = true;
            continue;
        }

        acceptedCount += 1;
        const destinationTarget = await resolveDestinationTarget(
            pdfDocument,
            frame.item.dest,
            destinationCache,
            refIndexCache,
        );
        const children: IBookmarkItem[] = [];
        const id = createId({
            parentId: frame.parentId,
            title: frame.item.title,
            pageIndex: destinationTarget?.pageIndex ?? null,
            dest: frame.item.dest,
        });
        frame.target.push({
            title: frame.item.title,
            dest: frame.item.dest,
            id,
            pageIndex: destinationTarget?.pageIndex ?? null,
            ...(destinationTarget?.pageYRatio === null || destinationTarget?.pageYRatio === undefined
                ? {}
                : {pageYRatio: destinationTarget.pageYRatio}),
            bold: frame.item.bold === true,
            italic: frame.item.italic === true,
            color: convertOutlineColorToHex(frame.item.color),
            items: children,
        });

        if (!frame.item.items?.length) {
            continue;
        }
        if (frame.depth >= MAX_OUTLINE_DEPTH) {
            skippedOverLimit = true;
            continue;
        }

        for (let index = frame.item.items.length - 1; index >= 0; index -= 1) {
            const item = frame.item.items[index];
            if (item) {
                stack.push({
                    item,
                    target: children,
                    parentId: id,
                    depth: frame.depth + 1,
                });
            }
        }
    }

    if (skippedOverLimit) {
        BrowserLogger.warn(OUTLINE_LOG_SECTION, 'Skipped over-limit resolved PDF outline items', {
            maxDepth: MAX_OUTLINE_DEPTH,
            maxItems: MAX_OUTLINE_ITEMS,
        });
    }

    return root;
}

export function buildOutlineFromBookmarkEntries(
    entries: readonly IPdfBookmarkEntry[],
    createId: TCreateBookmarkId,
) {
    const root: IBookmarkItem[] = [];
    const stack: Array<{
        entry: IPdfBookmarkEntry;
        target: IBookmarkItem[];
        parentId: string | null;
        depth: number;
    }> = [];
    let acceptedCount = 0;
    let skippedOverLimit = false;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry) {
            stack.push({
                entry,
                target: root,
                parentId: null,
                depth: 1,
            });
        }
    }

    while (stack.length > 0) {
        const frame = stack.pop();
        if (!frame) {
            break;
        }
        if (acceptedCount >= MAX_OUTLINE_ITEMS) {
            skippedOverLimit = true;
            continue;
        }

        acceptedCount += 1;
        const children: IBookmarkItem[] = [];
        const pageIndex = typeof frame.entry.pageIndex === 'number' && Number.isFinite(frame.entry.pageIndex)
            ? Math.max(0, Math.trunc(frame.entry.pageIndex))
            : null;
        const id = createId({
            parentId: frame.parentId,
            title: frame.entry.title,
            pageIndex,
            dest: frame.entry.namedDest,
        });
        frame.target.push({
            title: frame.entry.title,
            dest: frame.entry.namedDest,
            id,
            pageIndex,
            ...(typeof frame.entry.pageYRatio === 'number' && Number.isFinite(frame.entry.pageYRatio)
                ? {pageYRatio: clamp(frame.entry.pageYRatio, 0, 1)}
                : {}),
            bold: frame.entry.bold === true,
            italic: frame.entry.italic === true,
            color: normalizeBookmarkColor(frame.entry.color),
            items: children,
        });

        if (!frame.entry.items.length) {
            continue;
        }
        if (frame.depth >= MAX_OUTLINE_DEPTH) {
            skippedOverLimit = true;
            continue;
        }

        for (let index = frame.entry.items.length - 1; index >= 0; index -= 1) {
            const entry = frame.entry.items[index];
            if (entry) {
                stack.push({
                    entry,
                    target: children,
                    parentId: id,
                    depth: frame.depth + 1,
                });
            }
        }
    }

    if (skippedOverLimit) {
        BrowserLogger.warn(OUTLINE_LOG_SECTION, 'Skipped over-limit pending PDF bookmark items', {
            maxDepth: MAX_OUTLINE_DEPTH,
            maxItems: MAX_OUTLINE_ITEMS,
        });
    }

    return root;
}

export async function resolveBookmarkDestinationPage(
    pdfDocument: PDFDocumentProxy,
    dest: string | unknown[] | null,
) {
    const target = await resolveBookmarkDestinationTarget(pdfDocument, dest);
    return target?.page ?? null;
}

export async function resolveBookmarkDestinationTarget(
    pdfDocument: PDFDocumentProxy,
    dest: string | unknown[] | null,
): Promise<IBookmarkDestinationTarget | null> {
    if (!dest) {
        return null;
    }

    const destinationArray = await resolveDestinationArray(pdfDocument, dest);

    if (!destinationArray || destinationArray.length === 0) {
        return null;
    }

    const zeroBasedIndex = await resolvePageIndexFromDestinationArray(pdfDocument, destinationArray);
    if (zeroBasedIndex === null) {
        return null;
    }

    const page = zeroBasedIndex + 1;
    const pageYRatio = await resolveDestinationPageYRatio(pdfDocument, page, destinationArray);
    return {
        page,
        ...(pageYRatio === null ? {} : { pageYRatio }),
    };
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

/**
 * Depth of every entry of a pre-order flattened outline, keyed by identity.
 * A parent always precedes its children in that order, so one pass is enough.
 */
function resolveFlattenedBookmarkDepths(flatBookmarks: IBookmarkItem[]) {
    const depths = new Map<IBookmarkItem, number>();

    for (const item of flatBookmarks) {
        const depth = depths.get(item) ?? 0;
        depths.set(item, depth);
        for (const child of item.items) {
            depths.set(child, depth + 1);
        }
    }

    return depths;
}

export function resolveActiveBookmarkForPage(
    flatBookmarks: IBookmarkItem[],
    currentPage: number,
    currentActiveItemId: string | null,
) {
    const pageIndex = Math.max(0, (Number.isFinite(currentPage) ? currentPage : 1) - 1);
    const currentActive = currentActiveItemId
        ? flatBookmarks.find(item => item.id === currentActiveItemId) ?? null
        : null;

    if (currentActive?.pageIndex === pageIndex) {
        return currentActive;
    }

    const depths = resolveFlattenedBookmarkDepths(flatBookmarks);
    let active: IBookmarkItem | null = null;

    for (const item of flatBookmarks) {
        if (
            typeof item.pageIndex !== 'number'
            || !Number.isFinite(item.pageIndex)
            || item.pageIndex > pageIndex
        ) {
            continue;
        }
        // Later candidates win, except that a child inheriting its parent's
        // page must not outrank the parent that names the section.
        if (
            active === null
            || item.pageIndex !== active.pageIndex
            || (depths.get(item) ?? 0) <= (depths.get(active) ?? 0)
        ) {
            active = item;
        }
    }

    return active;
}

export function normalizeBookmarkColor(color: string | null | undefined) {
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
