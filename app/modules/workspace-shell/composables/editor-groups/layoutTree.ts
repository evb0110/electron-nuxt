import type {
    IEditorLayoutLeafNode,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
} from '@app/types/editor-groups';

export function collectLayoutGroupIds(node: TEditorLayoutNode, target: Set<string>) {
    if (node.type === 'leaf') {
        target.add(node.groupId);
        return;
    }

    collectLayoutGroupIds(node.first, target);
    collectLayoutGroupIds(node.second, target);
}

export function pruneLayoutToExistingGroups(
    node: TEditorLayoutNode,
    validGroupIds: Set<string>,
): TEditorLayoutNode | null {
    if (node.type === 'leaf') {
        return validGroupIds.has(node.groupId) ? node : null;
    }

    const nextFirst = pruneLayoutToExistingGroups(node.first, validGroupIds);
    const nextSecond = pruneLayoutToExistingGroups(node.second, validGroupIds);

    if (!nextFirst && !nextSecond) {
        return null;
    }
    if (!nextFirst) {
        return nextSecond;
    }
    if (!nextSecond) {
        return nextFirst;
    }

    if (nextFirst === node.first && nextSecond === node.second) {
        return node;
    }

    return {
        ...node,
        first: nextFirst,
        second: nextSecond,
    };
}

export function appendGroupToLayout(
    currentLayout: TEditorLayoutNode | null,
    groupId: string,
): TEditorLayoutNode {
    const nextLeaf: IEditorLayoutLeafNode = {
        type: 'leaf',
        groupId,
    };
    if (!currentLayout) {
        return nextLeaf;
    }

    return {
        type: 'split',
        id: crypto.randomUUID(),
        orientation: 'horizontal',
        ratio: 0.5,
        first: currentLayout,
        second: nextLeaf,
    };
}

export function removeLeafNode(
    node: TEditorLayoutNode,
    groupId: string,
): TEditorLayoutNode | null {
    if (node.type === 'leaf') {
        return node.groupId === groupId ? null : node;
    }

    const nextFirst = removeLeafNode(node.first, groupId);
    const nextSecond = removeLeafNode(node.second, groupId);

    if (!nextFirst && !nextSecond) {
        return null;
    }
    if (!nextFirst) {
        return nextSecond;
    }
    if (!nextSecond) {
        return nextFirst;
    }

    return {
        ...node,
        first: nextFirst,
        second: nextSecond,
    };
}

export function replaceLeafWithSplit(
    node: TEditorLayoutNode,
    sourceGroupId: string,
    splitNode: IEditorLayoutSplitNode,
): TEditorLayoutNode {
    if (node.type === 'leaf') {
        return node.groupId === sourceGroupId ? splitNode : node;
    }

    return {
        ...node,
        first: replaceLeafWithSplit(node.first, sourceGroupId, splitNode),
        second: replaceLeafWithSplit(node.second, sourceGroupId, splitNode),
    };
}

export function updateLayoutSplitRatio(
    layout: TEditorLayoutNode,
    splitId: string,
    nextRatio: number,
): TEditorLayoutNode {
    if (layout.type === 'leaf') {
        return layout;
    }

    if (layout.id === splitId) {
        return {
            ...layout,
            ratio: nextRatio,
        };
    }

    return {
        ...layout,
        first: updateLayoutSplitRatio(layout.first, splitId, nextRatio),
        second: updateLayoutSplitRatio(layout.second, splitId, nextRatio),
    };
}
