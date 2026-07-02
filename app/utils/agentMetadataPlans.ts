import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import { isEqual } from 'es-toolkit/predicate';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type {
    IPdfPageLabelRange,
    TPageLabelStyle,
} from '@app/types/pdf';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdfPageLabels';
import { normalizeBookmarkColor } from '@app/utils/pdfOutlineHelpers';

type TAgentMetadataIssueSeverity = 'error' | 'warning' | 'info';
type TAgentBookmarkInputMode = 'nested' | 'flat';
type TAgentPageLabelInputMode = 'ranges' | 'segments' | 'labels';

interface IAgentMetadataIssue {
    severity: TAgentMetadataIssueSeverity;
    code: string;
    message: string;
    page?: number | null;
    path?: number[];
}

interface IAgentBookmarkFlatEntry {
    path: number[];
    depth: number;
    title: string;
    pageIndex: number | null;
    pageNumber: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    childCount: number;
}

interface IAgentBookmarkSnapshot {
    count: number;
    dirty: boolean;
    summary: {
        rootCount: number;
        totalCount: number;
        maxDepth: number;
        destinationlessCount: number;
        namedDestinationCount: number;
        firstPageNumber: number | null;
        lastPageNumber: number | null;
    };
    issues: IAgentMetadataIssue[];
    flat: IAgentBookmarkFlatEntry[];
    bookmarks: Array<Record<string, unknown>>;
}

interface IAgentBookmarkPlan {
    inputMode: TAgentBookmarkInputMode;
    bookmarks: IPdfBookmarkEntry[];
    proposed: IAgentBookmarkSnapshot;
    diff: {
        wouldChange: boolean;
        currentCount: number;
        proposedCount: number;
        addedCount: number;
        removedCount: number;
        updatedCount: number;
        added: IAgentBookmarkFlatEntry[];
        removed: IAgentBookmarkFlatEntry[];
        updated: Array<{
            path: number[];
            before: IAgentBookmarkFlatEntry;
            after: IAgentBookmarkFlatEntry;
        }>;
    };
    issues: IAgentMetadataIssue[];
}

interface IAgentPageLabelSegment {
    startPage: number;
    endPage: number;
    pageCount: number;
    style: TPageLabelStyle;
    prefix: string;
    startNumber: number;
    startLabel: string;
    endLabel: string;
}

interface IAgentPageLabelSample {
    page: number;
    label: string;
}

interface IAgentPageLabelSnapshot {
    totalPages: number;
    dirty: boolean;
    isDefault: boolean;
    summary: {
        rangeCount: number;
        firstLabel: string | null;
        lastLabel: string | null;
        duplicateLabelCount: number;
    };
    issues: IAgentMetadataIssue[];
    ranges: IPdfPageLabelRange[];
    segments: IAgentPageLabelSegment[];
    samples: IAgentPageLabelSample[];
    labels: string[];
}

interface IAgentPageLabelPlan {
    inputMode: TAgentPageLabelInputMode;
    ranges: IPdfPageLabelRange[];
    proposed: IAgentPageLabelSnapshot;
    diff: {
        wouldChange: boolean;
        changedPageCount: number;
        unchangedPageCount: number;
        firstChangedPage: number | null;
        lastChangedPage: number | null;
        changedPages: Array<{
            page: number;
            before: string;
            after: string;
        }>;
    };
    issues: IAgentMetadataIssue[];
}

const AGENT_PAGE_LABEL_STYLES = [
    'D',
    'R',
    'r',
    'A',
    'a',
] as const satisfies ReadonlyArray<Exclude<TPageLabelStyle, null>>;

const MAX_ISSUE_COUNT = 50;
const MAX_DIFF_SAMPLE_COUNT = 50;
const MAX_LABEL_SAMPLE_COUNT = 40;


function hasInputKey(input: Record<string, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(input, key);
}

function getRawStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'string' ? value : null;
}

function getStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = getRawStringInput(input, key);
    return value !== null && value.trim().length > 0 ? value.trim() : null;
}

function getNullableStringInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    if (value === null) {
        return null;
    }
    return typeof value === 'string' ? value.trim() : undefined;
}

function getNumberInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function getBooleanInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'boolean' ? value : null;
}

function pushIssue(issues: IAgentMetadataIssue[], issue: IAgentMetadataIssue) {
    if (issues.length < MAX_ISSUE_COUNT) {
        issues.push(issue);
    }
}

function requirePageCount(totalPages: number, actionId: string) {
    if (totalPages <= 0) {
        throw new Error(`${actionId} requires an open PDF document.`);
    }
    return totalPages;
}

function normalizePageNumber(value: number | null | undefined, totalPages: number, actionId: string) {
    requirePageCount(totalPages, actionId);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${actionId} requires a valid one-based page number.`);
    }
    const page = Math.trunc(value);
    if (page < 1 || page > totalPages) {
        throw new Error(`${actionId} page ${page} is outside the document.`);
    }
    return page;
}

function getPageNumberInput(input: Record<string, unknown>, totalPages: number, actionId: string) {
    return normalizePageNumber(
        getNumberInput(input, 'page') ?? getNumberInput(input, 'pageNumber') ?? getNumberInput(input, 'startPage'),
        totalPages,
        actionId,
    );
}

export function normalizeAgentPageLabelStyle(value: unknown): TPageLabelStyle {
    if (value === null) {
        return null;
    }
    if (isOneOf(AGENT_PAGE_LABEL_STYLES, value)) {
        return value;
    }
    if (typeof value !== 'string') {
        return 'D';
    }

    switch (value.trim().toLowerCase()) {
        case 'decimal':
        case 'number':
        case 'numbers':
        case 'arabic':
            return 'D';
        case 'roman':
        case 'roman-upper':
        case 'uppercase-roman':
            return 'R';
        case 'roman-lower':
        case 'lowercase-roman':
            return 'r';
        case 'letters':
        case 'letters-upper':
        case 'alpha':
        case 'alpha-upper':
        case 'uppercase-alpha':
            return 'A';
        case 'letters-lower':
        case 'alpha-lower':
        case 'lowercase-alpha':
            return 'a';
        case 'literal':
        case 'none':
        case 'prefix':
        case '':
            return null;
        default:
            return 'D';
    }
}

function normalizePageLabelRangeInput(
    input: Record<string, unknown>,
    totalPages: number,
    actionId: string,
): IPdfPageLabelRange {
    const literalLabel = getRawStringInput(input, 'label');
    const hasExplicitStyle = hasInputKey(input, 'style') || hasInputKey(input, 'numberStyle') || hasInputKey(input, 'format');
    const hasExplicitPrefix = hasInputKey(input, 'prefix');
    return {
        startPage: getPageNumberInput(input, totalPages, actionId),
        style: !hasExplicitStyle && !hasExplicitPrefix && literalLabel !== null
            ? null
            : normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
        prefix: !hasExplicitStyle && !hasExplicitPrefix && literalLabel !== null
            ? literalLabel
            : getRawStringInput(input, 'prefix') ?? '',
        startNumber: Math.max(1, Math.trunc(
            getNumberInput(input, 'startNumber')
            ?? getNumberInput(input, 'number')
            ?? 1,
        )),
    };
}

function normalizeEndPageInput(
    input: Record<string, unknown>,
    startPage: number,
    totalPages: number,
    actionId: string,
) {
    const endPage = normalizePageNumber(
        getNumberInput(input, 'endPage')
        ?? getNumberInput(input, 'toPage')
        ?? getNumberInput(input, 'lastPage')
        ?? startPage,
        totalPages,
        actionId,
    );
    if (endPage < startPage) {
        throw new Error(`${actionId} endPage must be greater than or equal to startPage.`);
    }
    return endPage;
}

function createCurrentLabels(
    totalPages: number,
    ranges: IPdfPageLabelRange[],
    labels: string[] | null,
) {
    if (labels && labels.length === totalPages) {
        return labels;
    }
    return buildPageLabelsFromRanges(totalPages, ranges);
}

function createDefaultLabels(totalPages: number) {
    return buildPageLabelsFromRanges(totalPages, [{
        startPage: 1,
        style: 'D',
        prefix: '',
        startNumber: 1,
    }]);
}

function chooseBaseLabels(
    input: Record<string, unknown>,
    totalPages: number,
    currentRanges: IPdfPageLabelRange[],
    currentLabels: string[] | null,
) {
    const base = getStringInput(input, 'base') ?? getStringInput(input, 'baseLabels');
    return base === 'default' || base === 'physical'
        ? createDefaultLabels(totalPages)
        : createCurrentLabels(totalPages, currentRanges, currentLabels);
}

function applyPageLabelSegment(
    labels: string[],
    segment: Record<string, unknown>,
    totalPages: number,
    actionId: string,
) {
    const range = normalizePageLabelRangeInput(segment, totalPages, actionId);
    const endPage = normalizeEndPageInput(segment, range.startPage, totalPages, actionId);
    const segmentLabels = buildPageLabelsFromRanges(
        endPage - range.startPage + 1,
        [{
            ...range,
            startPage: 1,
        }],
    );
    segmentLabels.forEach((label, index) => {
        labels[range.startPage - 1 + index] = label;
    });
}

function applyExplicitLabels(
    labels: string[],
    input: Record<string, unknown>,
    totalPages: number,
    actionId: string,
) {
    const rawLabels = input.labels;
    if (Array.isArray(rawLabels)) {
        const startPage = normalizePageNumber(
            getNumberInput(input, 'startPage') ?? getNumberInput(input, 'page') ?? 1,
            totalPages,
            actionId,
        );
        rawLabels.slice(0, totalPages - startPage + 1).forEach((label, index) => {
            labels[startPage - 1 + index] = typeof label === 'string' ? label : '';
        });
    }

    const updates = input.updates;
    if (Array.isArray(updates)) {
        updates
            .filter(isRecord)
            .forEach((update) => {
                const page = normalizePageNumber(
                    getNumberInput(update, 'page') ?? getNumberInput(update, 'pageNumber'),
                    totalPages,
                    actionId,
                );
                labels[page - 1] = getRawStringInput(update, 'label') ?? '';
            });
    }

    if (!Array.isArray(rawLabels) && !Array.isArray(updates) && hasInputKey(input, 'label')) {
        const page = normalizePageNumber(
            getNumberInput(input, 'page') ?? getNumberInput(input, 'pageNumber'),
            totalPages,
            actionId,
        );
        labels[page - 1] = getRawStringInput(input, 'label') ?? '';
    }
}

function createRangesFromPageLabelInput(
    input: Record<string, unknown>,
    totalPages: number,
    currentRanges: IPdfPageLabelRange[],
    currentLabels: string[] | null,
    actionId: string,
) {
    const rawRanges = input.ranges;
    if (Array.isArray(rawRanges)) {
        return {
            inputMode: 'ranges' as const,
            ranges: normalizePageLabelRanges(
                rawRanges
                    .filter(isRecord)
                    .map(range => normalizePageLabelRangeInput(range, totalPages, actionId)),
                totalPages,
            ),
        };
    }

    const rawSegments = input.segments;
    if (Array.isArray(rawSegments)) {
        const labels = chooseBaseLabels(input, totalPages, currentRanges, currentLabels);
        rawSegments
            .filter(isRecord)
            .forEach(segment => applyPageLabelSegment(labels, segment, totalPages, actionId));
        return {
            inputMode: 'segments' as const,
            ranges: derivePageLabelRangesFromLabels(labels, totalPages),
        };
    }

    if (
        Array.isArray(input.labels)
        || Array.isArray(input.updates)
        || hasInputKey(input, 'label')
    ) {
        const labels = chooseBaseLabels(input, totalPages, currentRanges, currentLabels);
        applyExplicitLabels(labels, input, totalPages, actionId);
        return {
            inputMode: 'labels' as const,
            ranges: derivePageLabelRangesFromLabels(labels, totalPages),
        };
    }

    throw new Error(`${actionId} requires input.ranges, input.segments, input.labels, input.updates, or input.label.`);
}

function createPageLabelSegments(
    ranges: IPdfPageLabelRange[],
    labels: string[],
    totalPages: number,
) {
    return ranges.map((range, index): IAgentPageLabelSegment => {
        const nextRange = ranges[index + 1] ?? null;
        const endPage = nextRange ? nextRange.startPage - 1 : totalPages;
        return {
            startPage: range.startPage,
            endPage,
            pageCount: Math.max(0, endPage - range.startPage + 1),
            style: range.style,
            prefix: range.prefix,
            startNumber: range.startNumber,
            startLabel: labels[range.startPage - 1] ?? '',
            endLabel: labels[endPage - 1] ?? '',
        };
    });
}

function createPageLabelSamples(
    ranges: IPdfPageLabelRange[],
    labels: string[],
    totalPages: number,
) {
    const pages = new Set<number>();
    [
        1,
        2,
        totalPages - 1,
        totalPages,
    ].forEach(page => {
        if (page >= 1 && page <= totalPages) {
            pages.add(page);
        }
    });

    for (const segment of createPageLabelSegments(ranges, labels, totalPages)) {
        [
            segment.startPage,
            segment.startPage + 1,
            segment.endPage - 1,
            segment.endPage,
        ].forEach(page => {
            if (page >= 1 && page <= totalPages) {
                pages.add(page);
            }
        });
        if (pages.size >= MAX_LABEL_SAMPLE_COUNT) {
            break;
        }
    }

    return Array.from(pages)
        .sort((left, right) => left - right)
        .slice(0, MAX_LABEL_SAMPLE_COUNT)
        .map(page => ({
            page,
            label: labels[page - 1] ?? '',
        }));
}

function createDuplicateLabelIssues(labels: string[]) {
    const counts = new Map<string, number>();
    for (const label of labels) {
        if (!label) {
            continue;
        }
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    return Array.from(counts.entries())
        .filter(([
            , count,
        ]) => count > 1)
        .slice(0, 10)
        .map(([
            label,
            count,
        ]): IAgentMetadataIssue => ({
            severity: 'info',
            code: 'duplicate_page_label',
            message: `Page label "${label}" appears on ${count} pages.`,
        }));
}

function createPageLabelIssues(
    ranges: IPdfPageLabelRange[],
    labels: string[],
    totalPages: number,
) {
    const issues = createDuplicateLabelIssues(labels);
    const segments = createPageLabelSegments(ranges, labels, totalPages);
    for (const segment of segments) {
        if (segment.style === null && segment.pageCount > 1) {
            pushIssue(issues, {
                severity: 'warning',
                code: 'repeated_literal_label_range',
                message: `Literal label "${segment.prefix}" repeats from page ${segment.startPage} to ${segment.endPage}.`,
                page: segment.startPage,
            });
        }
    }
    return issues;
}

function countDuplicateLabels(labels: string[]) {
    const counts = new Map<string, number>();
    let duplicateCount = 0;
    for (const label of labels) {
        if (!label) {
            continue;
        }
        const count = counts.get(label) ?? 0;
        if (count === 1) {
            duplicateCount += 1;
        }
        counts.set(label, count + 1);
    }
    return duplicateCount;
}

export function createAgentPageLabelSnapshot(options: {
    totalPages: number;
    dirty: boolean;
    pageLabelRanges: IPdfPageLabelRange[];
    pageLabels: string[] | null;
}): IAgentPageLabelSnapshot {
    const totalPages = Math.max(0, Math.trunc(options.totalPages));
    const ranges = normalizePageLabelRanges(options.pageLabelRanges, totalPages);
    const labels = createCurrentLabels(totalPages, ranges, options.pageLabels);
    const issues = createPageLabelIssues(ranges, labels, totalPages);
    return {
        totalPages,
        dirty: options.dirty,
        isDefault: isImplicitDefaultPageLabels(ranges, totalPages),
        summary: {
            rangeCount: ranges.length,
            firstLabel: labels[0] ?? null,
            lastLabel: labels[labels.length - 1] ?? null,
            duplicateLabelCount: countDuplicateLabels(labels),
        },
        issues,
        ranges,
        segments: createPageLabelSegments(ranges, labels, totalPages),
        samples: createPageLabelSamples(ranges, labels, totalPages),
        labels,
    };
}

function createPageLabelDiff(beforeLabels: string[], afterLabels: string[]) {
    const changedPages: IAgentPageLabelPlan['diff']['changedPages'] = [];
    let firstChangedPage: number | null = null;
    let lastChangedPage: number | null = null;
    let changedPageCount = 0;
    const pageCount = Math.max(beforeLabels.length, afterLabels.length);

    for (let index = 0; index < pageCount; index += 1) {
        const before = beforeLabels[index] ?? '';
        const after = afterLabels[index] ?? '';
        if (before === after) {
            continue;
        }
        const page = index + 1;
        changedPageCount += 1;
        firstChangedPage ??= page;
        lastChangedPage = page;
        if (changedPages.length < MAX_DIFF_SAMPLE_COUNT) {
            changedPages.push({
                page,
                before,
                after,
            });
        }
    }

    return {
        wouldChange: changedPageCount > 0,
        changedPageCount,
        unchangedPageCount: Math.max(0, pageCount - changedPageCount),
        firstChangedPage,
        lastChangedPage,
        changedPages,
    };
}

export function createAgentPageLabelPlan(options: {
    input: Record<string, unknown>;
    totalPages: number;
    currentRanges: IPdfPageLabelRange[];
    currentLabels: string[] | null;
    dirty: boolean;
    actionId: string;
}): IAgentPageLabelPlan {
    const totalPages = requirePageCount(options.totalPages, options.actionId);
    const currentRanges = normalizePageLabelRanges(options.currentRanges, totalPages);
    const beforeLabels = createCurrentLabels(totalPages, currentRanges, options.currentLabels);
    const plan = createRangesFromPageLabelInput(
        options.input,
        totalPages,
        currentRanges,
        options.currentLabels,
        options.actionId,
    );
    const proposed = createAgentPageLabelSnapshot({
        totalPages,
        dirty: options.dirty,
        pageLabelRanges: plan.ranges,
        pageLabels: null,
    });

    return {
        inputMode: plan.inputMode,
        ranges: proposed.ranges,
        proposed,
        diff: createPageLabelDiff(beforeLabels, proposed.labels),
        issues: proposed.issues,
    };
}

function normalizeBookmarkPageIndex(
    input: Record<string, unknown>,
    totalPages: number,
    actionId: string,
) {
    const pageNumber = getNumberInput(input, 'page') ?? getNumberInput(input, 'pageNumber');
    if (pageNumber !== null) {
        return normalizePageNumber(pageNumber, totalPages, actionId) - 1;
    }

    const pageIndex = getNumberInput(input, 'pageIndex');
    if (pageIndex === null) {
        return null;
    }
    const normalizedPageIndex = Math.trunc(pageIndex);
    if (normalizedPageIndex < 0 || normalizedPageIndex >= requirePageCount(totalPages, actionId)) {
        throw new Error(`${actionId} pageIndex ${normalizedPageIndex} is outside the document.`);
    }
    return normalizedPageIndex;
}

function normalizeBookmarkEntry(
    input: Record<string, unknown>,
    totalPages: number,
    untitledTitle: string,
    actionId: string,
): IPdfBookmarkEntry {
    const rawTitle = getRawStringInput(input, 'title')?.trim();
    const title = rawTitle && rawTitle.length > 0 ? rawTitle : untitledTitle;
    const namedDest = getRawStringInput(input, 'namedDest')
        ?? getRawStringInput(input, 'dest')
        ?? null;
    const color = getNullableStringInput(input, 'color');
    const rawItems = Array.isArray(input.items) ? input.items : input.children;
    return {
        title,
        pageIndex: normalizeBookmarkPageIndex(input, totalPages, actionId),
        namedDest: namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null,
        bold: getBooleanInput(input, 'bold') ?? false,
        italic: getBooleanInput(input, 'italic') ?? false,
        color: color === null ? null : normalizeBookmarkColor(color),
        items: Array.isArray(rawItems)
            ? rawItems
                .filter(isRecord)
                .map(item => normalizeBookmarkEntry(item, totalPages, untitledTitle, actionId))
            : [],
    };
}

function normalizeFlatBookmarkDepth(input: Record<string, unknown>) {
    const depth = getNumberInput(input, 'depth');
    if (depth !== null) {
        return Math.max(0, Math.trunc(depth));
    }

    const level = getNumberInput(input, 'level');
    if (level !== null) {
        return Math.max(0, Math.trunc(level) - 1);
    }

    return 0;
}

function buildBookmarkTreeFromFlatEntries(
    entries: Array<Record<string, unknown>>,
    totalPages: number,
    untitledTitle: string,
    actionId: string,
) {
    const roots: IPdfBookmarkEntry[] = [];
    const stack: IPdfBookmarkEntry[] = [];
    const issues: IAgentMetadataIssue[] = [];

    entries.forEach((entry, index) => {
        const depth = normalizeFlatBookmarkDepth(entry);
        const bookmark = normalizeBookmarkEntry(entry, totalPages, untitledTitle, actionId);
        if (depth === 0) {
            roots.push(bookmark);
            stack.length = 0;
            stack[0] = bookmark;
            return;
        }

        const parent = stack[depth - 1] ?? null;
        if (!parent) {
            pushIssue(issues, {
                severity: 'warning',
                code: 'flat_bookmark_missing_parent',
                message: `Flat bookmark "${bookmark.title}" at entry ${index + 1} has depth ${depth} without a parent; it was promoted to the root level.`,
                page: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
            });
            roots.push(bookmark);
            stack.length = 0;
            stack[0] = bookmark;
            return;
        }

        parent.items.push(bookmark);
        stack.length = depth + 1;
        stack[depth] = bookmark;
    });

    return {
        bookmarks: roots,
        issues,
    };
}

function normalizeBookmarkTreeInput(options: {
    input: Record<string, unknown>;
    totalPages: number;
    untitledTitle: string;
    actionId: string;
}) {
    const rawTree = options.input.bookmarks ?? options.input.items ?? options.input.tree;
    if (Array.isArray(rawTree)) {
        return {
            inputMode: 'nested' as const,
            bookmarks: rawTree
                .filter(isRecord)
                .map(item => normalizeBookmarkEntry(item, options.totalPages, options.untitledTitle, options.actionId)),
            issues: [] as IAgentMetadataIssue[],
        };
    }

    const rawFlat = options.input.entries ?? options.input.flat ?? options.input.outline;
    if (Array.isArray(rawFlat)) {
        const flatResult = buildBookmarkTreeFromFlatEntries(
            rawFlat.filter(isRecord),
            options.totalPages,
            options.untitledTitle,
            options.actionId,
        );
        return {
            inputMode: 'flat' as const,
            ...flatResult,
        };
    }

    throw new Error(`${options.actionId} requires input.bookmarks, input.items, input.tree, input.entries, input.flat, or input.outline.`);
}

function normalizeBookmarkForAgent(
    bookmark: IPdfBookmarkEntry,
    path: number[] = [],
): Record<string, unknown> {
    return {
        path,
        depth: path.length,
        title: bookmark.title,
        pageIndex: bookmark.pageIndex,
        pageNumber: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
        namedDest: bookmark.namedDest,
        bold: bookmark.bold,
        italic: bookmark.italic,
        color: bookmark.color,
        items: bookmark.items.map((child, index) => normalizeBookmarkForAgent(child, [
            ...path,
            index,
        ])),
    };
}

function flattenBookmarks(bookmarks: IPdfBookmarkEntry[]) {
    const flat: IAgentBookmarkFlatEntry[] = [];
    const visit = (items: IPdfBookmarkEntry[], path: number[]) => {
        items.forEach((bookmark, index) => {
            const nextPath = [
                ...path,
                index,
            ];
            flat.push({
                path: nextPath,
                depth: nextPath.length - 1,
                title: bookmark.title,
                pageIndex: bookmark.pageIndex,
                pageNumber: bookmark.pageIndex === null ? null : bookmark.pageIndex + 1,
                namedDest: bookmark.namedDest,
                bold: bookmark.bold,
                italic: bookmark.italic,
                color: bookmark.color,
                childCount: bookmark.items.length,
            });
            visit(bookmark.items, nextPath);
        });
    };
    visit(bookmarks, []);
    return flat;
}

function getBookmarkComparable(entry: IAgentBookmarkFlatEntry) {
    return {
        title: entry.title,
        pageIndex: entry.pageIndex,
        namedDest: entry.namedDest,
        bold: entry.bold,
        italic: entry.italic,
        color: entry.color,
        childCount: entry.childCount,
    };
}

function createBookmarkIssues(bookmarks: IPdfBookmarkEntry[]) {
    const issues: IAgentMetadataIssue[] = [];
    const flat = flattenBookmarks(bookmarks);
    for (const entry of flat) {
        if (entry.pageIndex === null && !entry.namedDest) {
            pushIssue(issues, {
                severity: 'warning',
                code: 'bookmark_without_destination',
                message: `Bookmark "${entry.title}" has no page or named destination.`,
                path: entry.path,
            });
        }
    }

    let previousPage: number | null = null;
    for (const entry of flat) {
        if (entry.pageNumber === null) {
            continue;
        }
        if (previousPage !== null && entry.pageNumber < previousPage) {
            pushIssue(issues, {
                severity: 'info',
                code: 'bookmark_page_order_decreases',
                message: `Bookmark "${entry.title}" points to page ${entry.pageNumber}, before the previous bookmark page ${previousPage}.`,
                page: entry.pageNumber,
                path: entry.path,
            });
        }
        previousPage = entry.pageNumber;
    }

    const visitSiblings = (items: IPdfBookmarkEntry[], path: number[]) => {
        const counts = new Map<string, number>();
        items.forEach((item) => {
            const key = item.title.trim().toLowerCase();
            counts.set(key, (counts.get(key) ?? 0) + 1);
        });
        items.forEach((item, index) => {
            const key = item.title.trim().toLowerCase();
            if ((counts.get(key) ?? 0) > 1) {
                pushIssue(issues, {
                    severity: 'info',
                    code: 'duplicate_sibling_bookmark_title',
                    message: `Sibling bookmark title "${item.title}" appears more than once.`,
                    path: [
                        ...path,
                        index,
                    ],
                });
            }
            visitSiblings(item.items, [
                ...path,
                index,
            ]);
        });
    };
    visitSiblings(bookmarks, []);

    return issues;
}

function createBookmarkSummary(bookmarks: IPdfBookmarkEntry[], flat: IAgentBookmarkFlatEntry[]) {
    const pageNumbers: number[] = [];
    for (const entry of flat) {
        if (typeof entry.pageNumber === 'number') {
            pageNumbers.push(entry.pageNumber);
        }
    }
    return {
        rootCount: bookmarks.length,
        totalCount: flat.length,
        maxDepth: flat.reduce((maxDepth, entry) => Math.max(maxDepth, entry.depth), 0),
        destinationlessCount: flat.filter(entry => entry.pageIndex === null && !entry.namedDest).length,
        namedDestinationCount: flat.filter(entry => Boolean(entry.namedDest)).length,
        firstPageNumber: pageNumbers.length > 0 ? Math.min(...pageNumbers) : null,
        lastPageNumber: pageNumbers.length > 0 ? Math.max(...pageNumbers) : null,
    };
}

export function createAgentBookmarkSnapshot(
    bookmarks: IPdfBookmarkEntry[],
    options: {dirty: boolean;},
): IAgentBookmarkSnapshot {
    const flat = flattenBookmarks(bookmarks);
    return {
        count: bookmarks.length,
        dirty: options.dirty,
        summary: createBookmarkSummary(bookmarks, flat),
        issues: createBookmarkIssues(bookmarks),
        flat,
        bookmarks: bookmarks.map((bookmark, index) => normalizeBookmarkForAgent(bookmark, [index])),
    };
}

function createBookmarkDiff(current: IAgentBookmarkSnapshot, proposed: IAgentBookmarkSnapshot) {
    const currentByPath = new Map(current.flat.map(entry => [
        entry.path.join('.'),
        entry,
    ]));
    const proposedByPath = new Map(proposed.flat.map(entry => [
        entry.path.join('.'),
        entry,
    ]));
    const added: IAgentBookmarkFlatEntry[] = [];
    const removed: IAgentBookmarkFlatEntry[] = [];
    const updated: IAgentBookmarkPlan['diff']['updated'] = [];

    for (const proposedEntry of proposed.flat) {
        const key = proposedEntry.path.join('.');
        const currentEntry = currentByPath.get(key);
        if (!currentEntry) {
            if (added.length < MAX_DIFF_SAMPLE_COUNT) {
                added.push(proposedEntry);
            }
            continue;
        }
        if (!isEqual(getBookmarkComparable(currentEntry), getBookmarkComparable(proposedEntry))) {
            if (updated.length < MAX_DIFF_SAMPLE_COUNT) {
                updated.push({
                    path: proposedEntry.path,
                    before: currentEntry,
                    after: proposedEntry,
                });
            }
        }
    }

    for (const currentEntry of current.flat) {
        const key = currentEntry.path.join('.');
        if (!proposedByPath.has(key) && removed.length < MAX_DIFF_SAMPLE_COUNT) {
            removed.push(currentEntry);
        }
    }

    const addedCount = proposed.flat.filter(entry => !currentByPath.has(entry.path.join('.'))).length;
    const removedCount = current.flat.filter(entry => !proposedByPath.has(entry.path.join('.'))).length;
    const updatedCount = proposed.flat.filter((entry) => {
        const currentEntry = currentByPath.get(entry.path.join('.'));
        return currentEntry
            ? !isEqual(getBookmarkComparable(currentEntry), getBookmarkComparable(entry))
            : false;
    }).length;

    return {
        wouldChange: addedCount > 0 || removedCount > 0 || updatedCount > 0,
        currentCount: current.flat.length,
        proposedCount: proposed.flat.length,
        addedCount,
        removedCount,
        updatedCount,
        added,
        removed,
        updated,
    };
}

export function createAgentBookmarkPlan(options: {
    input: Record<string, unknown>;
    currentBookmarks: IPdfBookmarkEntry[];
    totalPages: number;
    dirty: boolean;
    untitledTitle: string;
    actionId: string;
}): IAgentBookmarkPlan {
    requirePageCount(options.totalPages, options.actionId);
    const normalized = normalizeBookmarkTreeInput(options);
    const current = createAgentBookmarkSnapshot(options.currentBookmarks, {dirty: options.dirty});
    const proposed = createAgentBookmarkSnapshot(normalized.bookmarks, {dirty: options.dirty});
    const issues = [
        ...normalized.issues,
        ...proposed.issues,
    ];
    return {
        inputMode: normalized.inputMode,
        bookmarks: normalized.bookmarks,
        proposed,
        diff: createBookmarkDiff(current, proposed),
        issues,
    };
}
