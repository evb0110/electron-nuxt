import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { IDocumentOpenSurfaceSnapshot } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IUseWorkspaceSidebarOpenGenerationOptions {
    sidebarPresentationEnabled: TReadableRef<boolean>;
    isOpeningDocumentForToolbar: TReadableRef<boolean>;
    initialDocumentVisualReady: TReadableRef<boolean>;
    hasDocumentOpenError: TReadableRef<boolean>;
    openSurfaceSnapshot: TReadableRef<IDocumentOpenSurfaceSnapshot>;
}

/**
 * Sidebar content belongs to one document generation. The moment a staged open
 * claims the title/open surface, the previous document's outline, thumbnails,
 * and bookmarks stop being a true description of what the centre surface shows,
 * so presentation is suspended until the claiming generation owns a committed
 * visual surface of its own.
 *
 * Suspension is released - not cleared - so an invalid staged open leaves the
 * previous document, its page, and its sidebar exactly as they were. The
 * persisted `showSidebar` preference is never written here.
 */
export const useWorkspaceSidebarOpenGeneration = (
    options: IUseWorkspaceSidebarOpenGenerationOptions,
) => {
    const sidebarSuspendedForDocumentOpen = ref(false);

    watch(
        () => ({
            failed: options.hasDocumentOpenError.value
                || options.openSurfaceSnapshot.value.phase === 'failed',
            idle: options.openSurfaceSnapshot.value.phase === 'idle',
            opening: options.isOpeningDocumentForToolbar.value,
            ready: options.initialDocumentVisualReady.value,
        }),
        (next) => {
            if (next.opening) {
                sidebarSuspendedForDocumentOpen.value = true;
                return;
            }
            if (!sidebarSuspendedForDocumentOpen.value) {
                return;
            }
            // The claiming generation either committed its own pixels, failed
            // and handed the surface back to the previous document, or was
            // abandoned before it ever owned one.
            if (next.ready || next.failed || next.idle) {
                sidebarSuspendedForDocumentOpen.value = false;
            }
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );

    const toolbarShowSidebarForDisplay = computed(() => (
        options.sidebarPresentationEnabled.value
        && !sidebarSuspendedForDocumentOpen.value
    ));

    return {
        sidebarSuspendedForDocumentOpen,
        toolbarShowSidebarForDisplay,
    };
};
