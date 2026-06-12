import type {
    IPageTextRangeMatch,
    IPageTextRangeMatchOptions,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/pdfTextAnchorResolverTypes';

interface INormalizedTextPosition {
    node: Text;
    offset: number;
}

interface INormalizedPageText {
    text: string;
    positions: INormalizedTextPosition[];
}

function normalizeWhitespace(text: string) {
    return text.trim().replace(/\s+/g, ' ');
}

function collectTextNodes(pageContainer: HTMLElement) {
    const spans = Array.from(
        pageContainer.querySelectorAll<HTMLElement>('.text-layer span, .textLayer span'),
    );
    const textNodes: Text[] = [];
    spans.forEach((span) => {
        Array.from(span.childNodes).forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE && (node.textContent?.length ?? 0) > 0) {
                textNodes.push(node as Text);
            }
        });
    });
    return textNodes;
}

function appendNormalizedChar(
    normalized: INormalizedPageText,
    char: string,
    position: INormalizedTextPosition,
) {
    normalized.text += char;
    normalized.positions.push(position);
}

function appendNormalizedSpace(
    normalized: INormalizedPageText,
    position: INormalizedTextPosition,
) {
    if (!normalized.text || normalized.text.endsWith(' ')) {
        return;
    }
    appendNormalizedChar(normalized, ' ', position);
}

function normalizePageTextNodes(textNodes: Text[]): INormalizedPageText {
    const normalized: INormalizedPageText = {
        text: '',
        positions: [],
    };

    textNodes.forEach((node, nodeIndex) => {
        const rawText = node.textContent ?? '';
        if (!rawText) {
            return;
        }
        if (nodeIndex > 0) {
            appendNormalizedSpace(normalized, {
                node,
                offset: 0,
            });
        }

        let previousWasWhitespace = normalized.text.endsWith(' ');
        for (let charIndex = 0; charIndex < rawText.length; charIndex += 1) {
            const char = rawText.charAt(charIndex);
            if (/\s/.test(char)) {
                if (!previousWasWhitespace) {
                    appendNormalizedSpace(normalized, {
                        node,
                        offset: charIndex,
                    });
                    previousWasWhitespace = true;
                }
                continue;
            }

            appendNormalizedChar(normalized, char, {
                node,
                offset: charIndex,
            });
            previousWasWhitespace = false;
        }
    });

    while (normalized.text.endsWith(' ')) {
        normalized.text = normalized.text.slice(0, -1);
        normalized.positions.pop();
    }

    return normalized;
}

function isWordCharacter(char: string) {
    return /[\p{L}\p{N}_]/u.test(char);
}

function isWholeWordMatch(text: string, startOffset: number, endOffset: number) {
    const before = text[startOffset - 1] ?? '';
    const after = text[endOffset] ?? '';
    return (!before || !isWordCharacter(before))
        && (!after || !isWordCharacter(after));
}

function findNormalizedTextMatch(
    haystack: string,
    needle: string,
    occurrence: number,
    wholeWord: boolean,
) {
    let found = 0;
    let fromIndex = 0;

    while (fromIndex <= haystack.length) {
        const index = haystack.indexOf(needle, fromIndex);
        if (index < 0) {
            return null;
        }

        const endOffset = index + needle.length;
        if (!wholeWord || isWholeWordMatch(haystack, index, endOffset)) {
            found += 1;
            if (found === occurrence) {
                return {
                    startOffset: index,
                    endOffset,
                };
            }
        }
        fromIndex = index + Math.max(1, needle.length);
    }

    return null;
}

function createRangeFromNormalizedMatch(
    normalized: INormalizedPageText,
    startOffset: number,
    endOffset: number,
) {
    const startPosition = normalized.positions[startOffset];
    const endPosition = normalized.positions[endOffset - 1];
    if (!startPosition || !endPosition) {
        return null;
    }

    const range = document.createRange();
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset + 1);
    return range;
}

export function buildRangeFromPageText(
    pageContainer: HTMLElement,
    options: IPageTextRangeMatchOptions,
): IPageTextRangeMatch | null {
    const query = normalizeWhitespace(options.text);
    if (!query) {
        return null;
    }

    const occurrence = Math.max(1, Math.trunc(options.occurrence ?? 1));
    const normalized = normalizePageTextNodes(collectTextNodes(pageContainer));
    if (!normalized.text || normalized.positions.length === 0) {
        return null;
    }

    const haystack = options.caseSensitive === true
        ? normalized.text
        : normalized.text.toLocaleLowerCase();
    const needle = options.caseSensitive === true
        ? query
        : query.toLocaleLowerCase();
    const match = findNormalizedTextMatch(
        haystack,
        needle,
        occurrence,
        options.wholeWord === true,
    );
    if (!match) {
        return null;
    }

    const range = createRangeFromNormalizedMatch(
        normalized,
        match.startOffset,
        match.endOffset,
    );
    if (!range) {
        return null;
    }

    return {
        range,
        matchedText: normalized.text.slice(match.startOffset, match.endOffset),
        occurrence,
        startOffset: match.startOffset,
        endOffset: match.endOffset,
    };
}
