import type { IPagePointTarget } from '@app/composables/pdf/annotations/types';
import { clamp01 } from '@app/composables/pdf/annotationGeometry';

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
    const offset = Math.max(0, Math.min(length - 1, seedOffset));
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
