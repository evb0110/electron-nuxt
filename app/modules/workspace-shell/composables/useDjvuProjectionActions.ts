import type { Ref } from 'vue';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import type { IWorkspaceViewerAdapter } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';
import type { IDocumentSourceCapabilities } from '@app/utils/document-viewer/source/documentPageSource';

const PDF_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: true,
    directImageExport: true,
    outline: true,
    pageEdits: true,
    search: true,
    text: true,
};

const EMPTY_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: false,
    directImageExport: false,
    outline: false,
    pageEdits: false,
    search: false,
    text: false,
};

export const useWorkspaceSourceCapabilityProjection = (
    activeViewerAdapter: Ref<IWorkspaceViewerAdapter | null>,
    capabilities: Ref<IDocumentSourceCapabilities>,
) => {
    watch(activeViewerAdapter, (adapter) => {
        if (!adapter) {
            capabilities.value = EMPTY_SOURCE_CAPABILITIES;
        } else if (adapter.id === 'pdf') {
            capabilities.value = PDF_SOURCE_CAPABILITIES;
        }
    }, {immediate: true});
};

interface IDjvuProjectionActionOptions {
    isDjvuMode: Ref<boolean>;
    currentPage: Ref<number>;
    documentViewerRef: Ref<IDocumentViewerExpose | null>;
    ensureProjection: (reason: 'edit' | 'ocr' | 'save-as-pdf') => Promise<boolean>;
    saveAs: () => Promise<boolean>;
    exportDocx: (selectedLanguages?: string[]) => Promise<void>;
    handleDropdownOpen: (
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) => void;
    insertImageFromFile: () => unknown;
    pasteImageFromClipboard: () => unknown;
    createQuickNote: () => unknown;
}

export const useDjvuProjectionActions = (options: IDjvuProjectionActionOptions) => {
    async function ensureProjection(reason: 'edit' | 'ocr' | 'save-as-pdf') {
        if (!options.isDjvuMode.value) {
            return true;
        }
        const viewer = options.documentViewerRef.value;
        const fallbackPage = viewer?.getCurrentPage?.() ?? options.currentPage.value;
        if (!await options.ensureProjection(reason)) {
            return false;
        }
        await nextTick();
        await options.documentViewerRef.value?.waitForViewerLoadSettled?.();
        options.documentViewerRef.value?.scrollToPage(fallbackPage);
        return true;
    }

    async function runEdit(action: () => unknown) {
        if (await ensureProjection('edit')) await action();
    }

    async function ensureDropdownProjection(
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) {
        if (dropdown !== 'ocr' || !isOpen || await ensureProjection('ocr')) {
            options.handleDropdownOpen(dropdown, isOpen);
        }
    }

    return {
        ensureEditProjection: () => ensureProjection('edit'),
        handleSaveAs: () => options.isDjvuMode.value
            ? ensureProjection('save-as-pdf')
            : options.saveAs(),
        async handleExportDocx(selectedLanguages?: string[]) {
            if (await ensureProjection('ocr')) await options.exportDocx(selectedLanguages);
        },
        handleDropdownOpen(
            dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
            isOpen: boolean,
        ) {
            void ensureDropdownProjection(dropdown, isOpen);
        },
        runEdit,
        handleInsertImageFromFile: () => runEdit(options.insertImageFromFile),
        handlePasteImageFromClipboard: () => runEdit(options.pasteImageFromClipboard),
        handleQuickNoteAction: () => runEdit(options.createQuickNote),
    };
};
