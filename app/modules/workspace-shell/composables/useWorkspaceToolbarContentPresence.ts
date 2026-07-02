import type { Ref } from 'vue';
import { useMutationObserver } from '@vueuse/core';

export const useWorkspaceToolbarContentPresence = (toolbarHostRef: Ref<HTMLElement | null>) => {
    const hasWorkspaceToolbarContent = ref(false);

    function syncWorkspaceToolbarContent() {
        const host = toolbarHostRef.value;
        hasWorkspaceToolbarContent.value = Boolean(host?.querySelector(':scope > *'));
    }

    useMutationObserver(toolbarHostRef, syncWorkspaceToolbarContent, { childList: true });
    watch(toolbarHostRef, () => {
        if (import.meta.client) {
            void nextTick(syncWorkspaceToolbarContent);
        }
    }, { flush: 'post' });
    onMounted(syncWorkspaceToolbarContent);

    return { hasWorkspaceToolbarContent };
};
