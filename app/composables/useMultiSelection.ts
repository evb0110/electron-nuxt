function getSelectionRange<T extends string | number>(
    id: T,
    allIds: T[],
    anchorId: T | null,
) {
    if (anchorId === null) {
        return null;
    }

    const anchorIndex = allIds.indexOf(anchorId);
    const targetIndex = allIds.indexOf(id);
    if (anchorIndex < 0 || targetIndex < 0) {
        return null;
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return allIds.slice(start, end + 1);
}

function toggleIdInSelection<T extends string | number>(selectedIds: Set<T>, id: T) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }
    return next;
}

export const useMultiSelection = <T extends string | number>() => {
    const selected = shallowRef<Set<T>>(new Set());
    const anchor = shallowRef<T | null>(null);

    function toggle(
        id: T,
        allIds: T[],
        opts: {
            shift?: boolean;
            meta?: boolean 
        } = {},
    ) {
        const selectionRange = opts.shift
            ? getSelectionRange(id, allIds, anchor.value)
            : null;
        if (selectionRange) {
            selected.value = new Set<T>(selectionRange);
            return;
        }

        if (opts.meta) {
            selected.value = toggleIdInSelection(selected.value, id);
            anchor.value = id;
            return;
        }

        selected.value = new Set<T>([id]);
        anchor.value = id;
    }

    function clear() {
        selected.value = new Set<T>();
        anchor.value = null;
    }

    function selectAll(ids: T[]) {
        selected.value = new Set<T>(ids);
    }

    function isSelected(id: T) {
        return selected.value.has(id);
    }

    return {
        selected,
        anchor,
        toggle,
        clear,
        selectAll,
        isSelected, 
    };
};
