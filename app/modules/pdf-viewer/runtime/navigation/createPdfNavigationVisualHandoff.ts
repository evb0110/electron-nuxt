export function createPdfNavigationVisualHandoff() {
    const current = ref<{
        page: number;
        sequence: number;
    } | null>(null);
    const intentSequences = new Map<string, number>();

    function assign(page: number, sequence: number) {
        current.value = {
            page,
            sequence,
        };
    }

    function clearSequence(sequence: number) {
        if (current.value?.sequence === sequence) {
            current.value = null;
        }
    }

    return {
        targetPage: computed(() => current.value?.page ?? null),
        assign,
        clear: () => {
            current.value = null;
        },
        clearSequence,
        registerIntent: (intentId: string, sequence: number) => {
            intentSequences.set(intentId, sequence);
        },
        resolveIntent: (intentId: string, page: number, aborted: boolean) => {
            const sequence = intentSequences.get(intentId);
            if (sequence !== undefined && !aborted) {
                assign(page, sequence);
            }
        },
        finishIntent: (intentId: string) => {
            intentSequences.delete(intentId);
        },
        releaseIntent: (intentId: string) => {
            const sequence = intentSequences.get(intentId);
            if (sequence === undefined) {
                return false;
            }
            clearSequence(sequence);
            return true;
        },
    };
}
