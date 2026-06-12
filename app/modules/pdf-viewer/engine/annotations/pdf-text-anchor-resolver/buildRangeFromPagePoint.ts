import type { IPagePointTarget } from '@app/modules/pdf-viewer/engine/annotations/types';
import { clamp01 } from '@app/modules/pdf-viewer/engine/annotation-geometry/clamp01';
import { findClosestTextSpanInPage } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/findClosestTextSpanInPage';
import { resolveWordOffsets } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/resolveWordOffsets';

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
        .flatMap(node => node instanceof Text && (node.textContent?.length ?? 0) > 0 ? [node] : [])
        .at(0)
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
