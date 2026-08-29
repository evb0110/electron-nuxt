import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { useDjvuProjectionActions } from '@app/modules/workspace-shell/composables/useDjvuProjectionActions';

describe('useDjvuProjectionActions', () => {
    it('cancels an active DOCX export before waiting for DjVu projection', async () => {
        const ensureProjection = vi.fn(async () => true);
        const exportDocx = vi.fn(async () => undefined);
        const cancelExportDocx = vi.fn();
        const actions = useDjvuProjectionActions({
            isDjvuMode: ref(true),
            currentPage: ref(1),
            documentViewerRef: ref(null),
            ensureProjection,
            saveAs: vi.fn(async () => true),
            exportDocx,
            isExportingDocx: ref(true),
            cancelExportDocx,
            handleDropdownOpen: vi.fn(),
            insertImageFromFile: vi.fn(),
            pasteImageFromClipboard: vi.fn(),
            createQuickNote: vi.fn(),
        });

        await actions.handleExportDocx();

        expect(cancelExportDocx).toHaveBeenCalledOnce();
        expect(ensureProjection).not.toHaveBeenCalled();
        expect(exportDocx).not.toHaveBeenCalled();
    });
});
