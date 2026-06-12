

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
