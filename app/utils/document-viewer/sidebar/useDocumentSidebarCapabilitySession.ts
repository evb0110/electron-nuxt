import type {
    ComputedRef,
    Ref,
} from 'vue';
import {
    reconcileDocumentSidebarTab,
    resolveDocumentSidebarTabs,
    type IDocumentSidebarCapabilities,
    type TDocumentSidebarTab,
} from '@app/utils/document-viewer/sidebar/documentSidebarTabs';

interface IUseDocumentSidebarCapabilitySessionOptions {
    capabilities: ComputedRef<IDocumentSidebarCapabilities>;
    capabilitiesReady: ComputedRef<boolean>;
    preferredTab: Ref<TDocumentSidebarTab>;
}

/**
 * Keeps user preference separate from the effective tab allowed by a format.
 * A temporary capability loss (for example PDF annotations while viewing DjVu)
 * must not destructively rewrite the shared workspace preference.
 */
export const useDocumentSidebarCapabilitySession = (
    options: IUseDocumentSidebarCapabilitySessionOptions,
) => {
    const availableTabs = computed(() => (
        options.capabilitiesReady.value
            ? resolveDocumentSidebarTabs(options.capabilities.value)
            : []
    ));
    const effectiveTab = computed<TDocumentSidebarTab>(() => (
        reconcileDocumentSidebarTab(options.preferredTab.value, availableTabs.value)
        ?? options.preferredTab.value
    ));

    function select(tab: TDocumentSidebarTab) {
        if (availableTabs.value.includes(tab)) options.preferredTab.value = tab;
    }

    return {
        availableTabs,
        effectiveTab,
        select,
    };
};
