import type {
    ComputedRef,
    Ref,
} from 'vue';

export type TDocumentOperationKind =
    | 'save'
    | 'save-as'
    | 'repair-save'
    | 'page-operation'
    | 'split-capture';

export interface IDocumentOperationLease {
    activeKind: Ref<TDocumentOperationKind | null>;
    isBusy: ComputedRef<boolean>;
    runExclusive: <T>(kind: TDocumentOperationKind, operation: () => Promise<T>) => Promise<T>;
}

export function runWithoutDocumentOperationLease<T>(
    _kind: TDocumentOperationKind,
    operation: () => Promise<T>,
) {
    return operation();
}

export function useDocumentOperationLease(): IDocumentOperationLease {
    const activeKind = ref<TDocumentOperationKind | null>(null);
    const pendingCount = ref(0);
    let queueTail: Promise<void> = Promise.resolve();

    async function runExclusive<T>(kind: TDocumentOperationKind, operation: () => Promise<T>) {
        pendingCount.value += 1;
        const previousTail = queueTail;
        const operationPromise = previousTail
            .catch(() => undefined)
            .then(async () => {
                activeKind.value = kind;
                try {
                    return await operation();
                } finally {
                    activeKind.value = null;
                    pendingCount.value = Math.max(0, pendingCount.value - 1);
                }
            });

        queueTail = operationPromise.then(() => undefined, () => undefined);
        return operationPromise;
    }

    return {
        activeKind,
        isBusy: computed(() => pendingCount.value > 0),
        runExclusive,
    };
}
