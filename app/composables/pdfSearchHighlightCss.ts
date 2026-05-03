import { STORAGE_KEYS } from '@app/constants/storage-keys';
import type { IPdfSearchHighlightMatchRange } from '@app/composables/pdfSearchHighlightRanges';
import {
    getHighlightMatchBoundsInSpan,
    getRelevantHighlightMatches,
} from '@app/composables/pdfSearchHighlightRanges';

type TPdfHighlightMode = 'dom' | 'css';

export interface IHighlightRange {
    range: Range;
    isCurrent: boolean;
}

export function canUseHighlightAPI() {
    return typeof CSS !== 'undefined'
        && 'highlights' in CSS
        && typeof Highlight !== 'undefined';
}

function readHighlightStorageValue(key: string) {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        return window.localStorage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

export function getHighlightMode(): TPdfHighlightMode {
    if (!canUseHighlightAPI()) {
        return 'dom';
    }

    const stored = readHighlightStorageValue(STORAGE_KEYS.HIGHLIGHT_MODE);
    return stored === 'css' ? 'css' : 'dom';
}

export function isHighlightDebugEnabled() {
    return readHighlightStorageValue(STORAGE_KEYS.HIGHLIGHT_DEBUG) === '1';
}

export function isHighlightDebugVerboseEnabled() {
    return readHighlightStorageValue(STORAGE_KEYS.HIGHLIGHT_DEBUG_VERBOSE) === '1';
}

export function createHighlightRangesInSpan(
    textNode: Text,
    spanStartOffset: number,
    matches: IPdfSearchHighlightMatchRange[],
    precomputedMatches?: IPdfSearchHighlightMatchRange[],
): IHighlightRange[] {
    const text = textNode.nodeValue ?? '';
    const relevantMatches = getRelevantHighlightMatches(text.length, spanStartOffset, matches, precomputedMatches);

    if (relevantMatches.length === 0) {
        return [];
    }

    const ranges: IHighlightRange[] = [];
    for (const match of relevantMatches) {
        const {
            start: matchStartInSpan,
            end: matchEndInSpan,
        } = getHighlightMatchBoundsInSpan(text.length, spanStartOffset, match);

        if (matchStartInSpan >= matchEndInSpan) {
            continue;
        }

        const range = document.createRange();
        range.setStart(textNode, matchStartInSpan);
        range.setEnd(textNode, matchEndInSpan);
        ranges.push({
            range,
            isCurrent: match.isCurrent,
        });
    }

    return ranges;
}

export interface ICssHighlightState {
    highlightRanges: Map<string, Range>;
    currentHighlightRanges: Map<string, Range>;
    layerRangeIds: WeakMap<HTMLElement, {
        normal: Set<string>;
        current: Set<string>;
    }>;
    layerCurrentRanges: WeakMap<HTMLElement, Range[]>;
}

export function createCssHighlightState(): ICssHighlightState {
    return {
        highlightRanges: new Map(),
        currentHighlightRanges: new Map(),
        layerRangeIds: new WeakMap(),
        layerCurrentRanges: new WeakMap(),
    };
}

export function updateHighlightAPI(
    state: ICssHighlightState,
    highlightApiName: string,
    highlightApiCurrentName: string,
) {
    if (!canUseHighlightAPI()) {
        return;
    }

    if (state.highlightRanges.size === 0) {
        CSS.highlights.delete(highlightApiName);
    } else {
        CSS.highlights.set(highlightApiName, new Highlight(...state.highlightRanges.values()));
    }

    if (state.currentHighlightRanges.size === 0) {
        CSS.highlights.delete(highlightApiCurrentName);
    } else {
        CSS.highlights.set(highlightApiCurrentName, new Highlight(...state.currentHighlightRanges.values()));
    }
}

export function registerHighlightRange(
    state: ICssHighlightState,
    container: HTMLElement,
    range: Range,
    isCurrent: boolean,
    id: string,
) {
    let ids = state.layerRangeIds.get(container);
    if (!ids) {
        ids = {
            normal: new Set<string>(),
            current: new Set<string>(),
        };
        state.layerRangeIds.set(container, ids);
    }

    if (isCurrent) {
        ids.current.add(id);
        state.currentHighlightRanges.set(id, range);
    } else {
        ids.normal.add(id);
        state.highlightRanges.set(id, range);
    }
}

export function clearHighlightAPIForLayer(
    state: ICssHighlightState,
    container: HTMLElement,
    highlightApiName: string,
    highlightApiCurrentName: string,
) {
    if (!canUseHighlightAPI()) {
        return;
    }

    const ids = state.layerRangeIds.get(container);
    if (!ids) {
        return;
    }

    for (const id of ids.normal) {
        state.highlightRanges.delete(id);
    }
    for (const id of ids.current) {
        state.currentHighlightRanges.delete(id);
    }

    state.layerRangeIds.delete(container);
    state.layerCurrentRanges.delete(container);
    updateHighlightAPI(state, highlightApiName, highlightApiCurrentName);
}
