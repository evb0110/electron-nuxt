const useRestoringTabCounts = () => useState<Record<string, number>>(
    'workspace-restore:counts',
    () => ({}),
);

function omitCount(record: Record<string, number>, key: string) {
    const {
        [key]: _removed,
        ...rest
    } = record;
    return rest;
}

export function useWorkspaceRestoreTracker() {
    const restoringTabCounts = useRestoringTabCounts();

    function start(tabId: string) {
        restoringTabCounts.value = {
            ...restoringTabCounts.value,
            [tabId]: (restoringTabCounts.value[tabId] ?? 0) + 1,
        };
    }

    function finish(tabId: string) {
        const current = restoringTabCounts.value[tabId] ?? 0;
        if (current <= 1) {
            restoringTabCounts.value = omitCount(restoringTabCounts.value, tabId);
            return;
        }

        restoringTabCounts.value = {
            ...restoringTabCounts.value,
            [tabId]: current - 1,
        };
    }

    function has(tabId: string) {
        return (restoringTabCounts.value[tabId] ?? 0) > 0;
    }

    return {
        start,
        finish,
        has,
    };
}
