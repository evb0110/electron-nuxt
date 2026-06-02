import type { IPagePointTarget } from '@app/composables/pdf/annotations/types';
import { clamp } from 'es-toolkit/math';
import { clamp01 } from '@app/composables/pdf/annotationGeometry';

export interface IPageTextRangeMatchOptions {
    text: string;
    occurrence?: number | undefined;
    caseSensitive?: boolean | undefined;
    wholeWord?: boolean | undefined;
}

export interface IPageTextRangeMatch {
    range: Range;
    matchedText: string;
    occurrence: number;
    startOffset: number;
    endOffset: number;
}

interface INormalizedTextPosition {
    node: Text;
    offset: number;
}

interface INormalizedPageText {
    text: string;
    positions: INormalizedTextPosition[];
}

function getTextSpanDistanceScore(rect: DOMRect, targetX: number, targetY: number) {
    const inside = targetX >= rect.left && targetX <= rect.right && targetY >= rect.top && targetY <= rect.bottom;
    const dx = inside ? 0 : Math.min(Math.abs(targetX - rect.left), Math.abs(targetX - rect.right));
    const dy = inside ? 0 : Math.min(Math.abs(targetY - rect.top), Math.abs(targetY - rect.bottom));
    return (dx * dx) + (dy * dy);
}

export function findClosestTextSpanInPage(pageContainer: HTMLElement, targetX: number, targetY: number): {
    span: HTMLElement;
    score: number;
    rect: DOMRect
} | null {
    const spans = Array.from(
        pageContainer.querySelectorAll<HTMLElement>('.text-layer span, .textLayer span'),
    );
    let best: {
        span: HTMLElement;
        score: number;
        rect: DOMRect
    } | null = null;

    spans.forEach((span) => {
        const text = span.textContent?.trim() ?? '';
        if (!text) {
            return;
        }
        const rect = span.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }
        const score = getTextSpanDistanceScore(rect, targetX, targetY);
        if (!best || score < best.score) {
            best = {
                span,
                score,
                rect,
            };
        }
    });

    return best;
}

function isWhitespaceAt(text: string, offset: number) {
    return /\s/.test(text[offset] ?? '');
}

function nearestNonWhitespaceOffset(text: string, seedOffset: number) {
    const length = text.length;
    const offset = clamp(seedOffset, 0, Math.max(0, length - 1));
    if (!isWhitespaceAt(text, offset)) {
        return offset;
    }

    let left = offset - 1;
    let right = offset + 1;
    while (left >= 0 || right < length) {
        if (left >= 0 && !isWhitespaceAt(text, left)) {
            return left;
        }
        if (right < length && !isWhitespaceAt(text, right)) {
            return right;
        }
        left -= 1;
        right += 1;
    }
    return offset;
}

function expandWordOffsets(text: string, offset: number) {
    const length = text.length;
    let start = offset;
    let end = Math.min(length, offset + 1);
    while (start > 0 && !isWhitespaceAt(text, start - 1)) {
        start -= 1;
    }
    while (end < length && !isWhitespaceAt(text, end)) {
        end += 1;
    }
    return {
        start,
        end,
    };
}

export function resolveWordOffsets(text: string, seedOffset: number) {
    const length = text.length;
    if (length <= 0) {
        return null;
    }

    const offset = nearestNonWhitespaceOffset(text, seedOffset);
    const offsets = expandWordOffsets(text, offset);

    if (offsets.start === offsets.end) {
        offsets.end = Math.min(length, offsets.start + 1);
    }
    return offsets;
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

export function buildRangeFromPagePoint(target: IPagePointTarget) {
    const pageRect = target.pageContainer.getBoundingClientRect();
    const clientX = pageRect.left + (target.pageX * pageRect.width);
    const clientY = pageRect.top + (target.pageY * pageRect.height);
    const nearest = findClosestTextSpanInPage(target.pageContainer, clientX, clientY);
    if (!nearest) {
        return null;
    }

    const textNode = Array
        .from(nearest.span.childNodes)
        .find((node): node is Text => node.nodeType === Node.TEXT_NODE && (node.textContent?.length ?? 0) > 0)
        ?? null;
    if (!textNode) {
        return null;
    }

    const text = textNode.textContent ?? '';
    if (!text.length) {
        return null;
    }

    const ratio = nearest.rect.width > 0
        ? clamp01((clientX - nearest.rect.left) / nearest.rect.width)
        : 0;
    const offsetSeed = Math.floor(ratio * Math.max(1, text.length - 1));
    const offsets = resolveWordOffsets(text, offsetSeed);
    if (!offsets) {
        return null;
    }

    const range = document.createRange();
    range.setStart(textNode, offsets.start);
    range.setEnd(textNode, offsets.end);
    return range;
}
