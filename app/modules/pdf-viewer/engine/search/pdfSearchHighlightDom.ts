import type { IPdfSearchHighlightMatchRange } from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightMatchRange';
import { getHighlightMatchBoundsInSpan } from '@app/modules/pdf-viewer/engine/search/getHighlightMatchBoundsInSpan';
import { getRelevantHighlightMatches } from '@app/modules/pdf-viewer/engine/search/getRelevantHighlightMatches';

export type TTextLayerRun =
    | {
        kind: 'span';
        span: HTMLSpanElement;
        textNode: Text | null;
        text: string;
        startOffset: number;
        endOffset: number;
    }
    | {
        kind: 'br';
        startOffset: number;
        endOffset: number;
    };

export interface IHighlightMatchRange extends IPdfSearchHighlightMatchRange {}

export interface ITextLayerIndexCacheEntry {
    text: string;
    runs: TTextLayerRun[];
}

export interface ITextLayerTextMapping {
    textDivs: readonly HTMLElement[];
    textContentItemsStr: readonly string[];
}

const textLayerIndexCache = new WeakMap<HTMLElement, ITextLayerIndexCacheEntry>();
const textLayerTextMappingCache = new WeakMap<HTMLElement, {
    textBySpan: WeakMap<HTMLElement, string>;
    textDivs: readonly HTMLElement[];
    textContentItemsStr: readonly string[];
}>();

function buildTextLayerIndex(textLayerDiv: HTMLElement): {
    text: string;
    runs: TTextLayerRun[];
} {
    const runs: TTextLayerRun[] = [];
    const textParts: string[] = [];
    const mappedTextBySpan = textLayerTextMappingCache.get(textLayerDiv)?.textBySpan;
    let offset = 0;

    function visit(node: Node) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
        }

        const element = node as HTMLElement;

        if (element.tagName === 'BR') {
            runs.push({
                kind: 'br',
                startOffset: offset,
                endOffset: offset + 1,
            });
            textParts.push('\n');
            offset += 1;
            return;
        }

        if (element.tagName === 'SPAN' && element.children.length === 0) {
            const span = element;
            const text = mappedTextBySpan?.get(span) ?? span.textContent ?? '';
            const textNode = span.firstChild && span.firstChild.nodeType === Node.TEXT_NODE
                ? span.firstChild as Text
                : null;
            runs.push({
                kind: 'span',
                span,
                textNode,
                text,
                startOffset: offset,
                endOffset: offset + text.length,
            });
            textParts.push(text);
            offset += text.length;
            return;
        }

        for (const child of Array.from(element.childNodes)) {
            visit(child);
        }
    }

    for (const child of Array.from(textLayerDiv.childNodes)) {
        visit(child);
    }

    return {
        text: textParts.join(''),
        runs,
    };
}

function refreshTextLayerRunTextNodes(runs: TTextLayerRun[]) {
    for (const run of runs) {
        if (run.kind !== 'span') {
            continue;
        }

        run.textNode = run.span.firstChild && run.span.firstChild.nodeType === Node.TEXT_NODE
            ? run.span.firstChild as Text
            : null;
    }
}

export function getCachedTextLayerIndex(textLayerDiv: HTMLElement): ITextLayerIndexCacheEntry {
    const cachedEntry = textLayerIndexCache.get(textLayerDiv);

    if (cachedEntry) {
        refreshTextLayerRunTextNodes(cachedEntry.runs);
        return cachedEntry;
    }

    const builtIndex = buildTextLayerIndex(textLayerDiv);
    const cacheEntry: ITextLayerIndexCacheEntry = {
        text: builtIndex.text,
        runs: builtIndex.runs,
    };
    textLayerIndexCache.set(textLayerDiv, cacheEntry);
    return cacheEntry;
}

export function clearTextLayerIndexCache(textLayerDiv: HTMLElement) {
    textLayerIndexCache.delete(textLayerDiv);
}

export function registerTextLayerTextMapping(
    textLayerDiv: HTMLElement,
    mapping: ITextLayerTextMapping,
) {
    const textBySpan = new WeakMap<HTMLElement, string>();

    mapping.textDivs.forEach((span, index) => {
        const text = mapping.textContentItemsStr[index];
        if (text !== undefined) {
            textBySpan.set(span, text);
        }
    });

    textLayerTextMappingCache.set(textLayerDiv, {
        textBySpan,
        textDivs: mapping.textDivs,
        textContentItemsStr: mapping.textContentItemsStr,
    });
    clearTextLayerIndexCache(textLayerDiv);
}

export function clearTextLayerTextMapping(textLayerDiv: HTMLElement) {
    textLayerTextMappingCache.delete(textLayerDiv);
    clearTextLayerIndexCache(textLayerDiv);
}

export function resetTextLayerMappedText(textLayerDiv: HTMLElement) {
    const mapping = textLayerTextMappingCache.get(textLayerDiv);
    if (!mapping) {
        return false;
    }

    mapping.textDivs.forEach((span, index) => {
        const text = mapping.textContentItemsStr[index];
        if (text === undefined) {
            return;
        }

        span.textContent = text;
    });
    clearTextLayerIndexCache(textLayerDiv);
    return true;
}

export function buildRunMatchOverlaps(
    runs: TTextLayerRun[],
    matches: IHighlightMatchRange[],
): IHighlightMatchRange[][] {
    const overlaps = Array.from(
        { length: runs.length },
        () => [] as IHighlightMatchRange[],
    );

    if (runs.length === 0 || matches.length === 0) {
        return overlaps;
    }

    let runIndex = 0;

    for (const match of matches) {
        while (
            runIndex < runs.length
            && runs[runIndex]!.endOffset <= match.start
        ) {
            runIndex += 1;
        }

        if (runIndex >= runs.length) {
            break;
        }

        for (let i = runIndex; i < runs.length; i += 1) {
            const run = runs[i]!;
            if (run.startOffset >= match.end) {
                break;
            }

            if (run.kind !== 'span') {
                continue;
            }

            if (run.endOffset <= match.start) {
                continue;
            }

            overlaps[i]!.push(match);
        }
    }

    return overlaps;
}

function getPdfjsHighlightSegmentClass(
    run: Extract<TTextLayerRun, { kind: 'span' }>,
    match: IHighlightMatchRange,
) {
    const startsInRun = match.start >= run.startOffset && match.start < run.endOffset;
    const endsInRun = match.end > run.startOffset && match.end <= run.endOffset;

    if (startsInRun && endsInRun) {
        return '';
    }
    if (startsInRun) {
        return ' begin';
    }
    if (endsInRun) {
        return ' end';
    }
    return ' middle';
}

export function highlightTextRunInPdfjsStyle(
    run: Extract<TTextLayerRun, { kind: 'span' }>,
    matches: IHighlightMatchRange[],
    highlightClass: string,
    highlightCurrentClass: string,
    precomputedMatches?: IHighlightMatchRange[],
): HTMLElement[] {
    const text = run.text;
    const relevantMatches = getRelevantHighlightMatches(
        text.length,
        run.startOffset,
        matches,
        precomputedMatches,
    );

    if (relevantMatches.length === 0) {
        return [];
    }

    const highlightElements: HTMLElement[] = [];
    const fragmentNode = document.createDocumentFragment();
    let currentPos = 0;

    function appendPlainText(toOffset: number) {
        if (toOffset <= currentPos) {
            return;
        }

        fragmentNode.appendChild(document.createTextNode(text.slice(currentPos, toOffset)));
        currentPos = toOffset;
    }

    for (const match of relevantMatches) {
        const {
            start: matchStartInSpan,
            end: matchEndInSpan,
        } = getHighlightMatchBoundsInSpan(text.length, run.startOffset, match);

        if (matchStartInSpan >= matchEndInSpan) {
            continue;
        }

        appendPlainText(matchStartInSpan);

        const highlight = document.createElement('span');
        highlight.className = match.isCurrent
            ? `${highlightClass} appended${getPdfjsHighlightSegmentClass(run, match)} ${highlightCurrentClass}`
            : `${highlightClass} appended${getPdfjsHighlightSegmentClass(run, match)}`;
        highlight.textContent = text.slice(matchStartInSpan, matchEndInSpan);
        fragmentNode.appendChild(highlight);
        highlightElements.push(highlight);
        currentPos = matchEndInSpan;
    }

    appendPlainText(text.length);
    run.span.replaceChildren(fragmentNode);
    run.textNode = run.span.firstChild && run.span.firstChild.nodeType === Node.TEXT_NODE
        ? run.span.firstChild as Text
        : null;

    return highlightElements;
}

export function clearDomHighlights(container: HTMLElement, highlightClass: string) {
    const highlights = container.getElementsByClassName(highlightClass);
    if (highlights.length === 0) {
        return;
    }

    const parentsToNormalize = new Set<Node>();

    while (highlights.length > 0) {
        const el = highlights[0];
        if (!el) {
            break;
        }

        const parent = el.parentNode;
        if (!parent) {
            el.remove();
            continue;
        }

        while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
        }
        parent.removeChild(el);
        parentsToNormalize.add(parent);
    }

    parentsToNormalize.forEach(parent => parent.normalize());
}

export function scrollToHighlight(
    element: HTMLElement,
    container: HTMLElement,
) {
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();

    const elementTop = elementRect.top - containerRect.top + container.scrollTop;
    const elementCenter = elementTop - container.clientHeight / 2 + elementRect.height / 2;

    container.scrollTop = Math.max(0, elementCenter);
}
