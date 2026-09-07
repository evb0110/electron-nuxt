export interface IBuildRangeFromPageTextOptions {
    text: string;
    occurrence?: number;
    caseSensitive?: boolean;
    wholeWord?: boolean;
}

export function buildRangeFromPageText(
    pageContainer: HTMLElement,
    options: IBuildRangeFromPageTextOptions,
) {
    const spans = Array.from(pageContainer.querySelectorAll<HTMLElement>('.text-layer span, .textLayer span'))
        .filter(span => !span.parentElement?.closest('span'));
    const positions: Array<{
        node: Text;
        offset: number
    }> = [];
    let text = '';
    spans.forEach((span, spanIndex) => {
        if (spanIndex > 0 && text && !text.endsWith(' ')) {
            text += ' ';
            positions.push({
                node: span.firstChild as Text,
                offset: 0,
            });
        }
        const node = span.firstChild;
        if (!(node instanceof Text)) {
            return;
        }
        Array.from(node.data).forEach((character, offset) => {
            if (/\s/u.test(character)) {
                if (!text.endsWith(' ')) {
                    text += ' ';
                    positions.push({
                        node,
                        offset,
                    });
                }
                return;
            }
            text += character;
            positions.push({
                node,
                offset,
            });
        });
    });
    while (text.endsWith(' ')) {
        text = text.slice(0, -1);
        positions.pop();
    }
    const query = options.text.trim().replace(/\s+/gu, ' ');
    const haystack = options.caseSensitive === true ? text : text.toLocaleLowerCase();
    const needle = options.caseSensitive === true ? query : query.toLocaleLowerCase();
    let cursor = 0;
    let found = 0;
    while (cursor <= haystack.length) {
        const startOffset = haystack.indexOf(needle, cursor);
        if (startOffset < 0) {
            return null;
        }
        const endOffset = startOffset + needle.length;
        const before = haystack[startOffset - 1] ?? '';
        const after = haystack[endOffset] ?? '';
        if (!options.wholeWord || (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after))) {
            found += 1;
            if (found === Math.max(1, Math.trunc(options.occurrence ?? 1))) {
                const start = positions[startOffset];
                const end = positions[endOffset - 1];
                if (!start || !end) {
                    return null;
                }
                const range = document.createRange();
                range.setStart(start.node, start.offset);
                range.setEnd(end.node, end.offset + 1);
                return {
                    range,
                    matchedText: text.slice(startOffset, endOffset),
                };
            }
        }
        cursor = startOffset + Math.max(1, needle.length);
    }
    return null;
}
