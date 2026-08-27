import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TPageSelection } from '@contracts/pageNumbers';
import { createAllPageSelection } from '@contracts/pageNumbers';
import { useDocumentWorkspacePageOperationHandlers } from '@app/modules/workspace-shell/composables/useDocumentWorkspacePageOperationHandlers';

describe('useDocumentWorkspacePageOperationHandlers selection plumbing', () => {
    it('passes a million-page select-all model to toolbar actions instead of the legacy array', async () => {
        const pageSelection = createAllPageSelection(1_000_000);
        const controls = {
            handlePageRotate: vi.fn(async () => true),
            pageOpsDelete: vi.fn(async () => true),
            pageOpsExtract: vi.fn(async () => true),
            pageOpsInsert: vi.fn(async () => true),
            pageOpsReorder: vi.fn(async () => true),
            pageOpsMove: vi.fn(async () => true),
        };
        const handleExportImages = vi.fn(async () => {});
        const handlers = useDocumentWorkspacePageOperationHandlers({
            documentControls: controls,
            handleExportImages,
            selectedThumbnailPages: ref([]),
            selectedPageSelection: ref<TPageSelection | null>(pageSelection),
            totalPages: ref(1_000_000),
        });

        handlers.handleRotateCw();
        handlers.handleDeletePages();
        handlers.handleExtractPages();
        await Promise.resolve();

        expect(controls.handlePageRotate).toHaveBeenCalledWith(pageSelection, 90);
        expect(controls.pageOpsDelete).toHaveBeenCalledWith(pageSelection, 1_000_000);
        expect(controls.pageOpsExtract).toHaveBeenCalledWith(pageSelection);
        handlers.handlePageExport(pageSelection);
        expect(handleExportImages).toHaveBeenCalledWith(pageSelection);
    });
});
