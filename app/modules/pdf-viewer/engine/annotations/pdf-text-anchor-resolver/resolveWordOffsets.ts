import { clamp } from 'es-toolkit/math';

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
