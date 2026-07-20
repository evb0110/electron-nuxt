export type TScanCleanupSelectionIntent = 'single' | 'toggle' | 'range';

export interface IScanCleanupSelectionState {
    anchor: number;
    leader: number;
    selectedPages: ReadonlySet<number>;
}

export function resolveScanCleanupSelection(
    state: IScanCleanupSelectionState,
    page: number,
    intent: TScanCleanupSelectionIntent,
    orderedPages: readonly number[],
): IScanCleanupSelectionState {
    if (intent === 'toggle') {
        const selectedPages = new Set(state.selectedPages);
        if (selectedPages.has(page)) selectedPages.delete(page);
        else selectedPages.add(page);
        return {
            anchor: page,
            leader: page,
            selectedPages,
        };
    }
    if (intent === 'range') {
        const anchorIndex = orderedPages.indexOf(state.anchor);
        const pageIndex = orderedPages.indexOf(page);
        if (anchorIndex >= 0 && pageIndex >= 0) {
            const start = Math.min(anchorIndex, pageIndex);
            const end = Math.max(anchorIndex, pageIndex);
            return {
                anchor: state.anchor,
                leader: page,
                selectedPages: new Set(orderedPages.slice(start, end + 1)),
            };
        }
    }
    return {
        anchor: page,
        leader: page,
        selectedPages: new Set([page]),
    };
}
