import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useDocumentWorkspaceVisualOpeningState } from '@app/modules/workspace-shell/composables/useDocumentWorkspaceVisualOpeningState';

describe('useDocumentWorkspaceVisualOpeningState', () => {
    it('keeps mutation surfaces busy while a native opening preview enables viewing controls', () => {
        const state = useDocumentWorkspaceVisualOpeningState({
            toolbarHasPdf: ref(true),
            isLoading: ref(true),
            initialDocumentVisualReady: ref(false),
            openingPreviewReady: ref(true),
            pdfError: ref(null),
            djvuError: ref(null),
            isOpeningDocumentForToolbar: ref(true),
            toolbarDocumentBusy: ref(true),
            canRepairSave: ref(false),
            canOptimizePdf: ref(false),
            statusZoomLabel: ref('376%'),
            totalPages: ref(882),
            pageLabels: ref(null),
            pageLabelsResolved: ref(false),
            isAnySaving: ref(false),
            t: () => 'Unknown zoom',
        });

        expect(state.toolbarDocumentBusyForDisplay.value).toBe(true);
        expect(state.documentMetadataReady.value).toBe(true);
        expect(state.toolbarControlsDisabled.value).toBe(false);
        expect(state.statusZoomLabelForDisplay.value).toBe('376%');
    });

    it('keeps all document controls disabled before an opening preview paints', () => {
        const state = useDocumentWorkspaceVisualOpeningState({
            toolbarHasPdf: ref(true),
            isLoading: ref(true),
            initialDocumentVisualReady: ref(false),
            openingPreviewReady: ref(false),
            pdfError: ref(null),
            djvuError: ref(null),
            isOpeningDocumentForToolbar: ref(true),
            toolbarDocumentBusy: ref(true),
            canRepairSave: ref(false),
            canOptimizePdf: ref(false),
            statusZoomLabel: ref('376%'),
            totalPages: ref(882),
            pageLabels: ref(null),
            pageLabelsResolved: ref(false),
            isAnySaving: ref(false),
            t: () => 'Unknown zoom',
        });

        expect(state.documentMetadataReady.value).toBe(false);
        expect(state.toolbarControlsDisabled.value).toBe(true);
    });
});
