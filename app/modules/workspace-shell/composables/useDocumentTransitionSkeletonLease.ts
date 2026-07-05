import type {
    ComputedRef,
    Ref,
} from 'vue';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IUseDocumentTransitionSkeletonLeaseOptions {
    djvuError: TReadableRef<unknown>;
    onInitialVisualPending: () => void;
    onInitialVisualReady: () => void;
    pendingDocumentOpen: TReadableRef<boolean>;
    pdfError: TReadableRef<unknown>;
}

export const useDocumentTransitionSkeletonLease = (options: IUseDocumentTransitionSkeletonLeaseOptions) => {
    const transitionSkeletonLeaseActive = ref(options.pendingDocumentOpen.value);
    const releasedCurrentOpenLease = ref(false);

    watch(
        () => options.pendingDocumentOpen.value,
        (pending, wasPending) => {
            if (!pending) {
                transitionSkeletonLeaseActive.value = false;
                releasedCurrentOpenLease.value = false;
                return;
            }

            if (!wasPending) {
                transitionSkeletonLeaseActive.value = true;
                releasedCurrentOpenLease.value = false;
            }
        },
        { flush: 'sync' },
    );

    function releaseDocumentTransitionSkeletonLease() {
        transitionSkeletonLeaseActive.value = false;
        releasedCurrentOpenLease.value = true;
    }

    function handleDocumentInitialVisualPending() {
        if (options.pendingDocumentOpen.value && !releasedCurrentOpenLease.value) {
            transitionSkeletonLeaseActive.value = true;
        }
        options.onInitialVisualPending();
    }

    function handleDocumentInitialVisualReady() {
        releaseDocumentTransitionSkeletonLease();
        options.onInitialVisualReady();
    }

    const showDocumentTransitionSkeleton = computed(() => (
        transitionSkeletonLeaseActive.value
        && options.pendingDocumentOpen.value
        && !options.pdfError.value
        && !options.djvuError.value
    ));

    return {
        handleDocumentInitialVisualPending,
        handleDocumentInitialVisualReady,
        releaseDocumentTransitionSkeletonLease,
        showDocumentTransitionSkeleton,
    };
};
