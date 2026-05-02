
import {
    watchDebounced,
    tryOnScopeDispose,
} from '@vueuse/core';
import {
    groupBy,
    keyBy,
} from 'es-toolkit/array';
import type {
    IAnnotationCommentSummary,
    ILinkAnnotation,
} from '@app/types/annotations';

interface IUseAnnotationStoreOptions {
    emitAnnotationComments?: (comments: IAnnotationCommentSummary[]) => void;
    debounceMs?: number;
}

export const useAnnotationStore = (options: IUseAnnotationStoreOptions = {}) => {
    const {
        emitAnnotationComments,
        debounceMs = 140,
    } = options;

    const annotations = ref<IAnnotationCommentSummary[]>([]);
    const linkAnnotations = ref<ILinkAnnotation[]>([]);
    const activeAnnotationKey = ref<string | null>(null);

    const byPage = computed(() =>
        groupBy(annotations.value, comment => comment.pageNumber),
    );

    const linksByPage = computed(() =>
        groupBy(linkAnnotations.value, link => link.pageNumber),
    );

    const byKey = computed(() =>
        keyBy(annotations.value, comment => comment.stableKey),
    );

    const activeAnnotation = computed(() => {
        const key = activeAnnotationKey.value;
        if (!key) {
            return null;
        }
        return byKey.value[key] ?? null;
    });

    if (emitAnnotationComments) {
        const { stop } = watchDebounced(
            annotations,
            (value) => {
                emitAnnotationComments(value);
            },
            {
                debounce: debounceMs,
                deep: false, 
            },
        );

        tryOnScopeDispose(stop);
    }

    function setAnnotations(comments: IAnnotationCommentSummary[]) {
        annotations.value = comments;
    }

    function setLinkAnnotations(links: ILinkAnnotation[]) {
        linkAnnotations.value = links;
    }

    function updateAnnotation(
        stableKey: string,
        updater: (comment: IAnnotationCommentSummary) => IAnnotationCommentSummary,
    ) {
        const index = annotations.value.findIndex(c => c.stableKey === stableKey);
        if (index === -1) {
            return false;
        }
        const current = annotations.value[index]!;
        const updated = updater(current);
        const next = [...annotations.value];
        next[index] = updated;
        annotations.value = next;
        return true;
    }

    function removeAnnotation(stableKey: string) {
        const before = annotations.value.length;
        annotations.value = annotations.value.filter(c => c.stableKey !== stableKey);
        return annotations.value.length < before;
    }

    function setActiveKey(key: string | null) {
        activeAnnotationKey.value = key;
    }

    function findByStableKey(stableKey: string) {
        return byKey.value[stableKey] ?? null;
    }

    function getAnnotationsForPage(pageNumber: number) {
        return byPage.value[pageNumber] ?? [];
    }

    function clear() {
        annotations.value = [];
        linkAnnotations.value = [];
        activeAnnotationKey.value = null;
    }

    return {
        annotations,
        linkAnnotations,
        activeAnnotationKey,
        byPage,
        linksByPage,
        byKey,
        activeAnnotation,
        setAnnotations,
        setLinkAnnotations,
        updateAnnotation,
        removeAnnotation,
        setActiveKey,
        findByStableKey,
        getAnnotationsForPage,
        clear,
    };
};
