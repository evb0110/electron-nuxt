import {
    computed,
    markRaw,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFJS_NATIVE_PREVIEW_MIN_BYTES } from '@app/modules/pdf-viewer/runtime/pdfNativePreviewRouting';
import {
    createWorkspaceDocumentDriverForAdapter,
    useWorkspaceDocumentDriver,
    useWorkspaceDocumentDriverBinding,
    type IWorkspaceDocumentDriverBindingOptions,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import {
    WORKSPACE_VIEWER_ADAPTERS,
    getWorkspaceViewerAdapter,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

function selectPendingDocument(path: string, size: number | null) {
    return useWorkspaceDocumentDriver({
        djvuSourcePath: ref(null),
        isDjvuMode: ref(false),
        pdfSrc: ref(null),
        workingCopyPath: ref(null),
        pendingDocumentPath: ref(path),
        pendingDocumentSize: ref(size),
    });
}

function createBindingHarness() {
    const sources = {
        djvuSourcePath: ref<string | null>('/tmp/source.djvu'),
        nativePdfSourcePath: ref<string | null>(null),
        workingCopyPath: ref<string | null>(null),
    };
    const createDriver = (id: 'pdf' | 'native-pdf' | 'djvu') => (
        createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter(id), sources)
    );
    const activeDocumentDriver = ref(createDriver('pdf'));
    const pdfViewerRef = ref<unknown>(null);
    const nativePdfViewerRef = ref<unknown>(null);
    const djvuViewerRef = ref<unknown>(null);
    const isRenderActive = ref(false);
    const isWorkspaceLayoutResizing = ref(false);
    const onPageSourceUpdate = vi.fn();
    const onSourceCapabilitiesUpdate = vi.fn();
    const fallbacks = new Map<PropertyKey, unknown>();
    const options = new Proxy({
        activeDocumentDriver: computed(() => activeDocumentDriver.value),
        djvuViewerRef,
        isRenderActive,
        isWorkspaceLayoutResizing,
        nativePdfViewerRef,
        onPageSourceUpdate,
        onSourceCapabilitiesUpdate,
        pdfSrc: ref({
            kind: 'path' as const,
            path: '/tmp/source.pdf',
            size: 1,
        }),
        pdfViewerRef,
        workingCopyPath: sources.workingCopyPath,
    } as Partial<IWorkspaceDocumentDriverBindingOptions>, {get(target, property) {
        if (property in target) {
            return target[property as keyof typeof target];
        }
        if (!fallbacks.has(property)) {
            fallbacks.set(property, ref(null));
        }
        return fallbacks.get(property);
    }}) as IWorkspaceDocumentDriverBindingOptions;
    return {
        activeDocumentDriver,
        binding: useWorkspaceDocumentDriverBinding(options),
        createDriver,
        djvuViewerRef,
        isRenderActive,
        isWorkspaceLayoutResizing,
        nativePdfViewerRef,
        onPageSourceUpdate,
        onSourceCapabilitiesUpdate,
        pdfViewerRef,
    };
}

describe('WorkspaceDocumentDriver', () => {
    it('preserves pending native-PDF threshold routing', () => {
        const native = selectPendingDocument(
            '/managed/document.pdf',
            PDFJS_NATIVE_PREVIEW_MIN_BYTES,
        ).activeDocumentDriver.value;
        expect(native).toMatchObject({
            id: 'native-pdf',
            view: {startupVisualSource: 'native-pdf-src'},
        });
        expect(selectPendingDocument(
            '/managed/document.pdf',
            PDFJS_NATIVE_PREVIEW_MIN_BYTES - 1,
        ).activeDocumentDriver.value?.id).toBe('pdfjs');
        expect(selectPendingDocument(
            '/managed/document.pdf',
            null,
        ).activeDocumentDriver.value?.id).toBe('pdfjs');
    });

    it('selects DjVu source behavior and returns typed unavailable commands for PDF.js', async () => {
        const djvu = useWorkspaceDocumentDriver({
            djvuSourcePath: ref('/managed/source.djvu'),
            isDjvuMode: ref(true),
            pdfSrc: ref(null),
            workingCopyPath: ref(null),
        }).activeDocumentDriver.value;
        expect(djvu).toMatchObject({
            id: 'djvu',
            source: {
                kind: 'djvu',
                path: '/managed/source.djvu',
            },
            view: {showDjvuSource: true},
        });

        await expect(selectPendingDocument('/managed/document.pdf', 1).activeDocumentDriver.value?.run({
            kind: 'prepare-print',
            request: {
                orientation: 'portrait',
                viewMode: 'single',
            },
            fileName: null,
            sourceCapabilities: djvu!.view.defaultSourceCapabilities ?? {
                annotations: false,
                directImageExport: false,
                outline: false,
                pageEdits: false,
                search: false,
                text: false,
            },
        })).resolves.toEqual({
            status: 'unavailable',
            capability: 'print',
        });
    });

    it('keeps the compatibility registry complete with capability and lifecycle parity', () => {
        const documentTypes = new Set(WORKSPACE_VIEWER_ADAPTERS.flatMap(adapter => adapter.documentTypes));
        expect(documentTypes).toEqual(new Set([
            'pdf',
            'image',
            'djvu',
        ]));
        expect(getWorkspaceViewerAdapter('pdf').capabilities).toMatchObject({
            repairSave: true,
            save: true,
            sidebar: true,
        });
        expect(getWorkspaceViewerAdapter('native-pdf').capabilities.sidebar).toBe(false);
        expect(getWorkspaceViewerAdapter('djvu')).toMatchObject({
            capabilities: {
                conversionDialog: true,
                saveAs: true,
            },
            createLifecycleHooks: expect.any(Function),
        });
    });
    it('owns viewer bindings, source listeners, and reactive presentation behind the driver', () => {
        const harness = createBindingHarness();
        expect(harness.binding.activeViewerProps.value.isActive).toBe(false);
        harness.isRenderActive.value = true;
        harness.isWorkspaceLayoutResizing.value = true;
        expect(harness.binding.activeViewerProps.value).toMatchObject({
            isActive: true,
            isResizing: true,
        });
        const pdfViewer = markRaw({});
        harness.binding.bindActiveViewerRef(pdfViewer);
        expect(harness.pdfViewerRef.value).toBe(pdfViewer);
        harness.activeDocumentDriver.value = harness.createDriver('djvu');
        const djvuViewer = markRaw({});
        harness.binding.bindActiveViewerRef(djvuViewer);
        expect(harness.pdfViewerRef.value).toBeNull();
        expect(harness.nativePdfViewerRef.value).toBeNull();
        expect(harness.djvuViewerRef.value).toBe(djvuViewer);
        expect(harness.binding.activeViewerProps.value).toHaveProperty('searchResults');
        expect(harness.binding.activeViewerListeners.value['update:pageSource']).toBe(harness.onPageSourceUpdate);
        expect(harness.binding.activeViewerListeners.value['update:sourceCapabilities']).toBe(harness.onSourceCapabilitiesUpdate);
    });
});
