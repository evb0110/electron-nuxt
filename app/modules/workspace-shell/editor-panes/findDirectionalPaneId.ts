import type {
    IEditorPaneRect,
    TEditorLayoutNode,
    TPaneDirection,
} from '@app/types/editorPanes';
import { clamp } from 'es-toolkit/math';

interface IFindDirectionalPaneIdParams {
    layout: TEditorLayoutNode | null;
    sourcePaneId: string;
    direction: TPaneDirection;
    paneMru: string[];
    wrap?: boolean;
}

function collectPaneRects(
    node: TEditorLayoutNode,
    x: number,
    y: number,
    width: number,
    height: number,
    target: IEditorPaneRect[],
) {
    if (node.type === 'leaf') {
        target.push({
            paneId: node.paneId,
            x,
            y,
            width,
            height,
        });
        return;
    }

    const ratio = clamp(node.ratio, 0.1, 0.9);
    if (node.orientation === 'horizontal') {
        const firstWidth = width * ratio;
        const secondWidth = width - firstWidth;
        collectPaneRects(node.first, x, y, firstWidth, height, target);
        collectPaneRects(node.second, x + firstWidth, y, secondWidth, height, target);
        return;
    }

    const firstHeight = height * ratio;
    const secondHeight = height - firstHeight;
    collectPaneRects(node.first, x, y, width, firstHeight, target);
    collectPaneRects(node.second, x, y + firstHeight, width, secondHeight, target);
}

function getPaneRects(layout: TEditorLayoutNode | null) {
    if (!layout) {
        return [];
    }

    const rects: IEditorPaneRect[] = [];
    collectPaneRects(layout, 0, 0, 1, 1, rects);
    return rects;
}

function overlapAmount(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function getMruRank(paneMru: string[], paneId: string) {
    const index = paneMru.indexOf(paneId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function findDirectionalPaneId({
    layout,
    sourcePaneId,
    direction,
    paneMru,
    wrap = true,
}: IFindDirectionalPaneIdParams) {
    const rects = getPaneRects(layout);
    const sourceRect = rects.find(rect => rect.paneId === sourcePaneId);
    if (!sourceRect) {
        return null;
    }

    interface IScore {
        paneId: string;
        distance: number;
        overlap: number;
        mruRank: number;
    }

    const candidates: IScore[] = [];
    for (const rect of rects) {
        if (rect.paneId === sourcePaneId) {
            continue;
        }

        let distance = Number.MAX_VALUE;
        let overlap = 0;

        if (direction === 'right') {
            if (rect.x >= sourceRect.x + sourceRect.width - 1e-6) {
                distance = rect.x - (sourceRect.x + sourceRect.width);
                overlap = overlapAmount(
                    sourceRect.y,
                    sourceRect.y + sourceRect.height,
                    rect.y,
                    rect.y + rect.height,
                );
            }
        } else if (direction === 'left') {
            if (rect.x + rect.width <= sourceRect.x + 1e-6) {
                distance = sourceRect.x - (rect.x + rect.width);
                overlap = overlapAmount(
                    sourceRect.y,
                    sourceRect.y + sourceRect.height,
                    rect.y,
                    rect.y + rect.height,
                );
            }
        } else if (direction === 'down') {
            if (rect.y >= sourceRect.y + sourceRect.height - 1e-6) {
                distance = rect.y - (sourceRect.y + sourceRect.height);
                overlap = overlapAmount(
                    sourceRect.x,
                    sourceRect.x + sourceRect.width,
                    rect.x,
                    rect.x + rect.width,
                );
            }
        } else if (rect.y + rect.height <= sourceRect.y + 1e-6) {
            distance = sourceRect.y - (rect.y + rect.height);
            overlap = overlapAmount(
                sourceRect.x,
                sourceRect.x + sourceRect.width,
                rect.x,
                rect.x + rect.width,
            );
        }

        if (distance !== Number.MAX_VALUE) {
            candidates.push({
                paneId: rect.paneId,
                distance,
                overlap,
                mruRank: getMruRank(paneMru, rect.paneId),
            });
        }
    }

    const sortScores = (left: IScore, right: IScore) => {
        if (left.distance !== right.distance) {
            return left.distance - right.distance;
        }
        if (left.overlap !== right.overlap) {
            return right.overlap - left.overlap;
        }
        return left.mruRank - right.mruRank;
    };

    if (candidates.length > 0) {
        candidates.sort(sortScores);
        return candidates[0]?.paneId ?? null;
    }

    if (!wrap) {
        return null;
    }

    const wrapCandidates = rects
        .filter(rect => rect.paneId !== sourcePaneId)
        .map((rect) => {
            let anchor = 0;
            let overlap = 0;

            if (direction === 'right') {
                anchor = rect.x;
                overlap = overlapAmount(
                    sourceRect.y,
                    sourceRect.y + sourceRect.height,
                    rect.y,
                    rect.y + rect.height,
                );
            } else if (direction === 'left') {
                anchor = rect.x + rect.width;
                overlap = overlapAmount(
                    sourceRect.y,
                    sourceRect.y + sourceRect.height,
                    rect.y,
                    rect.y + rect.height,
                );
            } else if (direction === 'down') {
                anchor = rect.y;
                overlap = overlapAmount(
                    sourceRect.x,
                    sourceRect.x + sourceRect.width,
                    rect.x,
                    rect.x + rect.width,
                );
            } else {
                anchor = rect.y + rect.height;
                overlap = overlapAmount(
                    sourceRect.x,
                    sourceRect.x + sourceRect.width,
                    rect.x,
                    rect.x + rect.width,
                );
            }

            return {
                paneId: rect.paneId,
                anchor,
                overlap,
                mruRank: getMruRank(paneMru, rect.paneId),
            };
        });

    wrapCandidates.sort((left, right) => {
        if (direction === 'right' || direction === 'down') {
            if (left.anchor !== right.anchor) {
                return left.anchor - right.anchor;
            }
        } else if (left.anchor !== right.anchor) {
            return right.anchor - left.anchor;
        }

        if (left.overlap !== right.overlap) {
            return right.overlap - left.overlap;
        }

        return left.mruRank - right.mruRank;
    });

    return wrapCandidates[0]?.paneId ?? null;
}
