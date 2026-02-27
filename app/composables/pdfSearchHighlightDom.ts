export type TTextLayerRun =
    | {
        kind: 'span';
        span: HTMLSpanElement;
        textNode: Text | null;
        startOffset: number;
        endOffset: number;
    }
    | {
        kind: 'br';
        startOffset: number;
        endOffset: number;
    };

export interface IHighlightMatchRange {
    start: number;
    end: number;
    isCurrent: boolean;
}

export function buildTextLayerIndex(textLayerDiv: HTMLElement): {
    text: string;
    runs: TTextLayerRun[];
} {
    const runs: TTextLayerRun[] = [];
    const textParts: string[] = [];
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
            const span = element as HTMLSpanElement;
            const text = span.textContent ?? '';
            const textNode = span.firstChild && span.firstChild.nodeType === Node.TEXT_NODE
                ? span.firstChild as Text
                : null;
            runs.push({
                kind: 'span',
                span,
                textNode,
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

export function highlightTextInSpan(
    span: HTMLSpanElement,
    spanStartOffset: number,
    matches: IHighlightMatchRange[],
    highlightClass: string,
    highlightCurrentClass: string,
    precomputedMatches?: IHighlightMatchRange[],
): HTMLElement[] {
    const text = span.textContent ?? '';
    const spanEndOffset = spanStartOffset + text.length;

    const relevantMatches = precomputedMatches
        ?? matches.filter(
            (m) => m.start < spanEndOffset && m.end > spanStartOffset,
        );

    if (relevantMatches.length === 0) {
        return [];
    }

    const highlightElements: HTMLElement[] = [];
    const fragments: Array<{
        text: string;
        isHighlight: boolean;
        isCurrent: boolean;
    }> = [];

    let currentPos = 0;
    for (const match of relevantMatches) {
        const matchStartInSpan = Math.max(0, match.start - spanStartOffset);
        const matchEndInSpan = Math.min(text.length, match.end - spanStartOffset);

        if (matchStartInSpan > currentPos) {
            fragments.push({
                text: text.slice(currentPos, matchStartInSpan),
                isHighlight: false,
                isCurrent: false,
            });
        }

        fragments.push({
            text: text.slice(matchStartInSpan, matchEndInSpan),
            isHighlight: true,
            isCurrent: match.isCurrent,
        });

        currentPos = matchEndInSpan;
    }

    if (currentPos < text.length) {
        fragments.push({
            text: text.slice(currentPos),
            isHighlight: false,
            isCurrent: false,
        });
    }

    span.textContent = '';

    for (const fragment of fragments) {
        if (fragment.isHighlight) {
            const mark = document.createElement('mark');
            mark.className = fragment.isCurrent
                ? `${highlightClass} ${highlightCurrentClass}`
                : highlightClass;
            mark.textContent = fragment.text;
            span.appendChild(mark);
            highlightElements.push(mark);
        } else {
            span.appendChild(document.createTextNode(fragment.text));
        }
    }

    return highlightElements;
}

export function clearDomHighlights(container: HTMLElement, highlightClass: string) {
    const highlights = container.querySelectorAll(`.${highlightClass}`);
    highlights.forEach((el) => {
        const parent = el.parentNode;
        if (parent) {
            while (el.firstChild) {
                parent.insertBefore(el.firstChild, el);
            }
            parent.removeChild(el);
            parent.normalize();
        }
    });
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
