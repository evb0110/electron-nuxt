export { shouldPreloadWorkspaceDuringStartup } from '@app/modules/workspace-shell/host/shouldPreloadWorkspaceDuringStartup';
export { usePdfFile } from '@app/modules/workspace-shell/composables/usePdfFile';
export function preloadDocumentWorkspace() {
    return import('@app/modules/workspace-shell/components/DocumentWorkspace.vue');
}
