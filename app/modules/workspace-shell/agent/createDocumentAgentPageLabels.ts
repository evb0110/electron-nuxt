import type { Ref } from 'vue';
import {
    getAgentNumberInput,
    getAgentRawStringInput,
    isAgentRecord,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import {
    getAgentPageNumberInput,
    normalizeAgentPageNumber,
    requireAgentPdfPageCount,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type {
    IPdfPageLabelRange,
    TPageLabelStyle,
} from '@app/types/pdfContracts';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdfPageLabels';

type TAgentMetadataIssueSeverity = 'error' | 'warning' | 'info';
type TAgentPageLabelInputMode = 'ranges' | 'segments' | 'labels';

interface IAgentMetadataIssue {
    severity: TAgentMetadataIssueSeverity;
    code: string;
    message: string;
    page?: number | null;
    path?: number[];
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

function getNumberInput(input: Record<string, unknown> | undefined, key: string) {
    const value = input?.[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
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

function normalizeAgentPageLabelStyle(value: unknown): TPageLabelStyle {
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

const createAgentPageLabelPlanSnapshot = createAgentPageLabelSnapshot;

interface ICreateDocumentAgentPageLabelsOptions {
    handlePageLabelRangesUpdate: (ranges: IPdfPageLabelRange[]) => void;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    pageLabels: Ref<string[] | null>;
    pageLabelsDirty: Ref<boolean>;
    totalPages: Ref<number>;
}

export function createDocumentAgentPageLabels(options: ICreateDocumentAgentPageLabelsOptions) {
    const {
        handlePageLabelRangesUpdate,
        pageLabelRanges,
        pageLabels,
        pageLabelsDirty,
        totalPages,
    } = options;

    function normalizeAgentPageLabelRange(input: Record<string, unknown>, actionId: string): IPdfPageLabelRange {
        return {
            startPage: getAgentPageNumberInput(input, totalPages.value, actionId),
            style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
            prefix: getAgentRawStringInput(input, 'prefix') ?? '',
            startNumber: Math.max(1, Math.trunc(
                getAgentNumberInput(input, 'startNumber')
                ?? getAgentNumberInput(input, 'number')
                ?? 1,
            )),
        };
    }

    function getEffectiveAgentPageLabels() {
        const pageCount = totalPages.value;
        if (pageCount <= 0) {
            return [];
        }
        if (pageLabels.value && pageLabels.value.length === pageCount) {
            return pageLabels.value;
        }
        return buildPageLabelsFromRanges(pageCount, pageLabelRanges.value);
    }

    function createAgentPageLabelSnapshot() {
        return createAgentPageLabelPlanSnapshot({
            totalPages: totalPages.value,
            dirty: pageLabelsDirty.value,
            pageLabelRanges: pageLabelRanges.value,
            pageLabels: pageLabels.value,
        });
    }

    function updateAgentPageLabelRanges(ranges: IPdfPageLabelRange[]) {
        handlePageLabelRangesUpdate(ranges);
        return createAgentPageLabelSnapshot();
    }

    function getAgentPageLabelRangesInput(input: Record<string, unknown>, actionId: string) {
        const rawRanges = input.ranges;
        if (!Array.isArray(rawRanges)) {
            throw new Error(`${actionId} requires input.ranges.`);
        }
        return rawRanges
            .filter(isAgentRecord)
            .map(range => normalizeAgentPageLabelRange(range, actionId));
    }

    function getAgentPageLabelApplyRangeOptions(input: Record<string, unknown>, actionId: string) {
        const startPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'startPage') ?? getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'),
            totalPages.value,
            actionId,
        );
        const endPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'endPage') ?? getAgentNumberInput(input, 'toPage') ?? startPage,
            totalPages.value,
            actionId,
        );
        if (endPage < startPage) {
            throw new Error(`${actionId} endPage must be greater than or equal to startPage.`);
        }
        return {
            startPage,
            endPage,
            style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
            prefix: getAgentRawStringInput(input, 'prefix') ?? '',
            startNumber: Math.max(1, Math.trunc(
                getAgentNumberInput(input, 'startNumber')
                ?? getAgentNumberInput(input, 'number')
                ?? 1,
            )),
        };
    }

    function applyAgentPageLabelsToRange(input: Record<string, unknown>, actionId: string) {
        const {
            startPage,
            endPage,
            style,
            prefix,
            startNumber,
        } = getAgentPageLabelApplyRangeOptions(input, actionId);
        const labels = [...getEffectiveAgentPageLabels()];
        const segmentLabels = buildPageLabelsFromRanges(
            endPage - startPage + 1,
            [{
                startPage: 1,
                style,
                prefix,
                startNumber,
            }],
        );
        segmentLabels.forEach((label, index) => {
            labels[startPage - 1 + index] = label;
        });
        return updateAgentPageLabelRanges(derivePageLabelRangesFromLabels(labels, totalPages.value));
    }

    function setAgentPageLabels(input: Record<string, unknown>, actionId: string) {
        const pageCount = requireAgentPdfPageCount(totalPages.value, actionId);
        const labels = [...getEffectiveAgentPageLabels()];
        const rawLabels = input.labels;
        if (Array.isArray(rawLabels)) {
            rawLabels.slice(0, pageCount).forEach((label, index) => {
                labels[index] = typeof label === 'string' ? label : '';
            });
        }

        const updates = input.updates;
        if (Array.isArray(updates)) {
            updates
                .filter(isAgentRecord)
                .forEach((update) => {
                    const page = getAgentPageNumberInput(update, totalPages.value, actionId);
                    labels[page - 1] = getAgentRawStringInput(update, 'label') ?? '';
                });
        }

        if (!Array.isArray(rawLabels) && !Array.isArray(updates)) {
            const page = getAgentPageNumberInput(input, totalPages.value, actionId);
            labels[page - 1] = getAgentRawStringInput(input, 'label') ?? '';
        }

        return updateAgentPageLabelRanges(derivePageLabelRangesFromLabels(labels, totalPages.value));
    }

    function previewAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
        return createAgentPageLabelPlan({
            input,
            totalPages: totalPages.value,
            currentRanges: pageLabelRanges.value,
            currentLabels: pageLabels.value,
            dirty: pageLabelsDirty.value,
            actionId,
        });
    }

    function applyAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentPageLabelPlan(input, actionId);
        const snapshot = updateAgentPageLabelRanges(plan.ranges);
        return {
            ...snapshot,
            plan,
        };
    }

    return {
        applyAgentPageLabelPlan,
        applyAgentPageLabelsToRange,
        createAgentPageLabelSnapshot,
        getAgentPageLabelRangesInput,
        previewAgentPageLabelPlan,
        setAgentPageLabels,
        updateAgentPageLabelRanges,
    };
}
