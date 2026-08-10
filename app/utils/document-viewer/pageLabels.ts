import { clamp } from 'es-toolkit/math';

const DOCUMENT_PAGE_LABEL_STYLE_VALUES = [
    'D',
    'R',
    'r',
    'A',
    'a',
] as const;

export type TDocumentPageLabelStyle = typeof DOCUMENT_PAGE_LABEL_STYLE_VALUES[number] | null;

export interface IDocumentPageLabelRange {
    startPage: number;
    style: TDocumentPageLabelStyle;
    prefix: string;
    startNumber: number;
}

export interface IDocumentPageRange {
    startPage: number;
    endPage: number;
}

type TNonNullPageLabelStyle = Exclude<TDocumentPageLabelStyle, null>;
const PAGE_LABEL_STYLE_SET: ReadonlySet<string> = new Set<TNonNullPageLabelStyle>(DOCUMENT_PAGE_LABEL_STYLE_VALUES);

function isNonNullPageLabelStyle(style: unknown): style is TNonNullPageLabelStyle {
    return typeof style === 'string' && PAGE_LABEL_STYLE_SET.has(style);
}

function toPositiveInt(value: unknown, fallback: number) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }
    return parsed;
}

function normalizeStyle(style: unknown): TDocumentPageLabelStyle {
    if (style === null) {
        return null;
    }
    if (isNonNullPageLabelStyle(style)) {
        return style;
    }
    return 'D';
}

function toRoman(number: number, lowerCase = false) {
    if (number < 1) {
        return '';
    }
    const numerals: Array<[number, string]> = [
        [
            1000,
            'M',
        ],
        [
            900,
            'CM',
        ],
        [
            500,
            'D',
        ],
        [
            400,
            'CD',
        ],
        [
            100,
            'C',
        ],
        [
            90,
            'XC',
        ],
        [
            50,
            'L',
        ],
        [
            40,
            'XL',
        ],
        [
            10,
            'X',
        ],
        [
            9,
            'IX',
        ],
        [
            5,
            'V',
        ],
        [
            4,
            'IV',
        ],
        [
            1,
            'I',
        ],
    ];

    let value = number;
    let result = '';
    for (const [
        decimal,
        roman,
    ] of numerals) {
        while (value >= decimal) {
            result += roman;
            value -= decimal;
        }
    }
    return lowerCase ? result.toLowerCase() : result;
}

function parseRoman(value: string) {
    if (!/^[ivxlcdm]+$/i.test(value)) {
        return null;
    }

    const numerals: Record<string, number> = {
        I: 1,
        V: 5,
        X: 10,
        L: 50,
        C: 100,
        D: 500,
        M: 1000,
    };

    const upper = value.toUpperCase();
    let total = 0;
    for (let index = 0; index < upper.length; index += 1) {
        const current = numerals[upper[index] ?? ''] ?? 0;
        const next = numerals[upper[index + 1] ?? ''] ?? 0;
        total += current < next ? -current : current;
    }

    if (total < 1) {
        return null;
    }

    const canonical = toRoman(total, value === value.toLowerCase());
    return canonical === value ? total : null;
}

function toAlphabetic(number: number, lowerCase = false) {
    if (number < 1) {
        return '';
    }
    const baseCode = lowerCase ? 0x61 : 0x41;
    const letterIndex = (number - 1) % 26;
    const repeatCount = Math.floor((number - 1) / 26) + 1;
    const character = String.fromCharCode(baseCode + letterIndex);
    return character.repeat(repeatCount);
}

function parseAlphabetic(value: string) {
    if (!/^[A-Za-z]+$/.test(value)) {
        return null;
    }
    const normalized = value.toLowerCase();
    if (!/^([a-z])\1*$/.test(normalized)) {
        return null;
    }
    const charCode = normalized.charCodeAt(0);
    const offset = charCode - 0x61;
    if (offset < 0 || offset > 25) {
        return null;
    }
    const repeatCount = normalized.length;
    return ((repeatCount - 1) * 26) + offset + 1;
}

function formatLabelValue(style: TDocumentPageLabelStyle, number: number) {
    switch (style) {
        case 'D':
            return String(number);
        case 'R':
            return toRoman(number, false);
        case 'r':
            return toRoman(number, true);
        case 'A':
            return toAlphabetic(number, false);
        case 'a':
            return toAlphabetic(number, true);
        default:
            return '';
    }
}

function getLabelForOffset(range: IDocumentPageLabelRange, offset: number) {
    if (range.style === null) {
        return range.prefix;
    }
    const number = Math.max(1, range.startNumber + offset);
    return range.prefix + formatLabelValue(range.style, number);
}

function createLiteralLabelCandidate(label: string): IDocumentPageLabelRange {
    return {
        startPage: 1,
        style: null,
        prefix: label,
        startNumber: 1,
    };
}

function inferDecimalCandidate(label: string): IDocumentPageLabelRange | null {
    const match = /^(.*?)(\d+)$/.exec(label);
    if (!match) {
        return null;
    }

    return {
        startPage: 1,
        style: 'D',
        prefix: match[1] ?? '',
        startNumber: toPositiveInt(match[2], 1),
    };
}

function inferRomanCandidate(label: string): IDocumentPageLabelRange | null {
    const match = /^(.*?)([ivxlcdm]+)$/i.exec(label);
    if (!match) {
        return null;
    }

    const suffix = match[2] ?? '';
    const romanValue = parseRoman(suffix);
    if (romanValue === null) {
        return null;
    }

    return {
        startPage: 1,
        style: suffix === suffix.toLowerCase() ? 'r' : 'R',
        prefix: match[1] ?? '',
        startNumber: romanValue,
    };
}

function inferAlphabeticCandidate(label: string): IDocumentPageLabelRange | null {
    const match = /^(.*?)([A-Za-z]+)$/.exec(label);
    if (!match) {
        return null;
    }

    const suffix = match[2] ?? '';
    const alphaValue = parseAlphabetic(suffix);
    if (alphaValue === null) {
        return null;
    }

    return {
        startPage: 1,
        style: suffix === suffix.toLowerCase() ? 'a' : 'A',
        prefix: match[1] ?? '',
        startNumber: alphaValue,
    };
}

function inferCandidates(label: string): IDocumentPageLabelRange[] {
    const candidates = [createLiteralLabelCandidate(label)];
    const parsedCandidates = [
        inferDecimalCandidate(label),
        inferRomanCandidate(label),
        inferAlphabeticCandidate(label),
    ];

    for (const candidate of parsedCandidates) {
        if (candidate) {
            candidates.push(candidate);
        }
    }

    return candidates;
}

export function normalizePageLabelRanges(
    ranges: IDocumentPageLabelRange[],
    totalPages: number,
): IDocumentPageLabelRange[] {
    if (totalPages <= 0) {
        return [];
    }

    const deduped = new Map<number, IDocumentPageLabelRange>();

    for (const range of ranges) {
        const startPage = clamp(
            toPositiveInt(range.startPage, 1),
            1,
            totalPages,
        );
        const style = normalizeStyle(range.style);
        const prefix = typeof range.prefix === 'string' ? range.prefix : '';
        const startNumber = toPositiveInt(range.startNumber, 1);

        deduped.set(startPage, {
            startPage,
            style,
            prefix,
            startNumber,
        });
    }

    if (!deduped.has(1)) {
        deduped.set(1, {
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        });
    }

    return Array.from(deduped.values()).sort((left, right) => left.startPage - right.startPage);
}

export function buildPageLabelsFromRanges(totalPages: number, ranges: IDocumentPageLabelRange[]): string[] {
    if (totalPages <= 0) {
        return [];
    }

    const normalizedRanges = normalizePageLabelRanges(ranges, totalPages);
    const labels = new Array<string>(totalPages);
    let rangeIndex = 0;
    let activeRange = normalizedRanges[0] ?? {
        startPage: 1,
        style: 'D' as const,
        prefix: '',
        startNumber: 1,
    };

    for (let page = 1; page <= totalPages; page += 1) {
        while (
            rangeIndex + 1 < normalizedRanges.length
            && (normalizedRanges[rangeIndex + 1]?.startPage ?? totalPages + 1) <= page
        ) {
            rangeIndex += 1;
            activeRange = normalizedRanges[rangeIndex] ?? activeRange;
        }

        const offset = page - activeRange.startPage;
        labels[page - 1] = getLabelForOffset(activeRange, offset);
    }

    return labels;
}

export function buildWholeDocumentPageLabelRanges(
    totalPages: number,
    options: Omit<IDocumentPageLabelRange, 'startPage'>,
): IDocumentPageLabelRange[] {
    if (totalPages <= 0) {
        return [];
    }

    return normalizePageLabelRanges([{
        startPage: 1,
        style: options.style,
        prefix: options.prefix,
        startNumber: options.startNumber,
    }], totalPages);
}

export function derivePageLabelRangesFromLabels(
    pageLabels: string[] | null,
    totalPages: number,
): IDocumentPageLabelRange[] {
    if (totalPages <= 0) {
        return [];
    }

    if (!pageLabels || pageLabels.length !== totalPages) {
        return [{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }];
    }

    const ranges: IDocumentPageLabelRange[] = [];
    let pageIndex = 0;

    while (pageIndex < totalPages) {
        const label = pageLabels[pageIndex] ?? '';
        const candidates = inferCandidates(label);

        let bestRange: IDocumentPageLabelRange = candidates[0]!;
        let bestLength = 1;
        let bestPriority = bestRange.style === null ? 0 : 1;

        for (const candidate of candidates) {
            let length = 1;
            while (pageIndex + length < totalPages) {
                const actual = pageLabels[pageIndex + length] ?? '';
                const expected = getLabelForOffset(candidate, length);
                if (actual !== expected) {
                    break;
                }
                length += 1;
            }

            const priority = candidate.style === null ? 0 : 1;
            if (length > bestLength || (length === bestLength && priority > bestPriority)) {
                bestRange = candidate;
                bestLength = length;
                bestPriority = priority;
            }
        }

        ranges.push({
            ...bestRange,
            startPage: pageIndex + 1,
        });
        pageIndex += bestLength;
    }

    return normalizePageLabelRanges(ranges, totalPages);
}

export function findPageByPageLabelInput(input: string, totalPages: number, pageLabels: string[] | null) {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return null;
    }

    if (pageLabels && pageLabels.length === totalPages) {
        const exactIndex = pageLabels.findIndex(label => label === trimmed);
        if (exactIndex >= 0) {
            return exactIndex + 1;
        }

        const lowered = trimmed.toLowerCase();
        const caseInsensitiveIndex = pageLabels.findIndex(label => label.toLowerCase() === lowered);
        if (caseInsensitiveIndex >= 0) {
            return caseInsensitiveIndex + 1;
        }
    }

    if (/^\d+$/.test(trimmed)) {
        const page = Number.parseInt(trimmed, 10);
        if (Number.isFinite(page) && page >= 1 && page <= totalPages) {
            return page;
        }
    }

    return null;
}

export function getVisiblePageLabel(page: number, pageLabels: string[] | null) {
    const rawLabel = pageLabels?.[page - 1] ?? '';
    const label = rawLabel.trim();
    if (!label) {
        return null;
    }
    return label;
}

export interface IPageIndicatorFormatOptions { compactPhysicalPage?: boolean; }

export function formatPageIndicatorWithOptions(
    page: number,
    pageLabels: string[] | null,
    options: IPageIndicatorFormatOptions = {},
) {
    const logical = getVisiblePageLabel(page, pageLabels);
    if (!logical || logical === String(page)) {
        return String(page);
    }

    const physicalPage = options.compactPhysicalPage
        ? `(${page})`
        : ` (${page})`;

    return `${logical}${physicalPage}`;
}

export function getMaxPageIndicatorLength(
    totalPages: number,
    pageLabels: string[] | null,
    options: IPageIndicatorFormatOptions = {},
) {
    if (totalPages <= 0) {
        return 0;
    }

    if (!pageLabels || pageLabels.length !== totalPages) {
        return String(totalPages).length;
    }

    let maxLength = 0;
    for (let page = 1; page <= totalPages; page += 1) {
        maxLength = Math.max(maxLength, formatPageIndicatorWithOptions(page, pageLabels, options).length);
    }

    return maxLength;
}

const PAGE_INDICATOR_MIN_TOTAL_WIDTH_CH = 3;

export function getPageIndicatorLayoutMetrics(
    totalPages: number,
    pageLabels: string[] | null,
    showTotal: boolean,
    options: IPageIndicatorFormatOptions = {},
) {
    const currentMinimumWidth = showTotal ? 5 : 3;
    const currentWidthCh = Math.max(currentMinimumWidth, getMaxPageIndicatorLength(totalPages, pageLabels, options));

    if (!showTotal) {
        return {
            currentWidthCh,
            totalWidthCh: 0,
            separatorWidthCh: 0,
            displayWidthCh: currentWidthCh + 2,
        };
    }

    const totalWidthCh = Math.max(
        PAGE_INDICATOR_MIN_TOTAL_WIDTH_CH,
        String(totalPages).length,
    );
    const separatorWidthCh = 1;

    return {
        currentWidthCh,
        totalWidthCh,
        separatorWidthCh,
        displayWidthCh: currentWidthCh + totalWidthCh + separatorWidthCh + 2,
    };
}

export function isImplicitDefaultPageLabels(ranges: IDocumentPageLabelRange[], totalPages: number) {
    const normalizedRanges = normalizePageLabelRanges(ranges, totalPages);
    if (normalizedRanges.length !== 1) {
        return false;
    }
    const range = normalizedRanges[0];
    if (!range) {
        return false;
    }
    return (
        range.startPage === 1
        && range.style === 'D'
        && range.prefix.length === 0
        && range.startNumber === 1
    );
}

export function parsePageRangeInput(input: string, totalPages: number): IDocumentPageRange | null {
    if (totalPages <= 0) {
        return null;
    }

    const normalized = input
        .trim()
        .replace(/[–—]/g, '-')
        .replace(/\.\./g, '-')
        .replace(/\s+/g, '');

    if (!normalized) {
        return null;
    }

    const match = /^(\d+)(?:-(\d+))?$/.exec(normalized);
    if (!match) {
        return null;
    }

    const first = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(first) || first < 1 || first > totalPages) {
        return null;
    }

    const secondToken = match[2];
    if (!secondToken) {
        return {
            startPage: first,
            endPage: first,
        };
    }

    const second = Number.parseInt(secondToken, 10);
    if (!Number.isFinite(second) || second < 1 || second > totalPages) {
        return null;
    }

    const startPage = Math.min(first, second);
    const endPage = Math.max(first, second);

    return {
        startPage,
        endPage,
    };
}

export function formatPageRange(range: IDocumentPageRange) {
    if (range.startPage === range.endPage) {
        return String(range.startPage);
    }
    return `${range.startPage}-${range.endPage}`;
}
