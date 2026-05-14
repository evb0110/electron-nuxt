import type {
    IEditorGroupRect,
    TEditorLayoutNode,
    TGroupDirection,
} from '@app/types/editorGroups';
import { clamp } from 'es-toolkit/math';

interface IFindDirectionalGroupIdParams {
    layout: TEditorLayoutNode | null;
    sourceGroupId: string;
    direction: TGroupDirection;
    groupMru: string[];
    wrap?: boolean;
}

function collectGroupRects(
    node: TEditorLayoutNode,
    x: number,
    y: number,
    width: number,
    height: number,
    target: IEditorGroupRect[],
) {
    if (node.type === 'leaf') {
        target.push({
            groupId: node.groupId,
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
        collectGroupRects(node.first, x, y, firstWidth, height, target);
        collectGroupRects(node.second, x + firstWidth, y, secondWidth, height, target);
        return;
    }

    const firstHeight = height * ratio;
    const secondHeight = height - firstHeight;
    collectGroupRects(node.first, x, y, width, firstHeight, target);
    collectGroupRects(node.second, x, y + firstHeight, width, secondHeight, target);
}

function getGroupRects(layout: TEditorLayoutNode | null) {
    if (!layout) {
        return [];
    }

    const rects: IEditorGroupRect[] = [];
    collectGroupRects(layout, 0, 0, 1, 1, rects);
    return rects;
}

function overlapAmount(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function getMruRank(groupMru: string[], groupId: string) {
    const index = groupMru.indexOf(groupId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function findDirectionalGroupId({
    layout,
    sourceGroupId,
    direction,
    groupMru,
    wrap = true,
}: IFindDirectionalGroupIdParams): string | null {
    const rects = getGroupRects(layout);
    const sourceRect = rects.find(rect => rect.groupId === sourceGroupId);
    if (!sourceRect) {
        return null;
    }

    interface IScore {
        groupId: string;
        distance: number;
        overlap: number;
        mruRank: number;
    }

    const candidates: IScore[] = [];
    for (const rect of rects) {
        if (rect.groupId === sourceGroupId) {
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
                groupId: rect.groupId,
                distance,
                overlap,
                mruRank: getMruRank(groupMru, rect.groupId),
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
        return candidates[0]?.groupId ?? null;
    }

    if (!wrap) {
        return null;
    }

    const wrapCandidates = rects
        .filter(rect => rect.groupId !== sourceGroupId)
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
                groupId: rect.groupId,
                anchor,
                overlap,
                mruRank: getMruRank(groupMru, rect.groupId),
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

    return wrapCandidates[0]?.groupId ?? null;
}
