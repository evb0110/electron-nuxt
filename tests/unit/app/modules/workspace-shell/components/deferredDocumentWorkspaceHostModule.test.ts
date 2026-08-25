// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    type App,
} from 'vue';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/modules/workspace-shell/composables/useWorkspaceSplitCache', () => ({useWorkspaceSplitCache: () => ({has: () => false})}));
vi.mock('@app/composables/useRecentFiles', async () => {
    const { ref } = await import('vue');
    return {useRecentFiles: () => ({
        clearRecentFiles: vi.fn(),
        isResolved: ref(true),
        loadRecentFiles: vi.fn(async () => undefined),
        recentFiles: ref([]),
        removeRecentFile: vi.fn(async () => undefined),
        removeRecentFileIfMissing: vi.fn(async () => false),
    })};
});
vi.mock('@app/modules/pdf-viewer/public/component-exports/pdfEmptyState', async () => {
    const {
        defineComponent,
        h,
    } = await import('vue');
    return {PdfEmptyState: defineComponent({
        name: 'PdfEmptyStateStub',
        setup() {
            return () => h('div', {class: 'pdf-empty-state-stub'});
        },
    })};
});

let mountedApp: App | null = null;
let mountedHost: HTMLElement | null = null;

afterEach(() => {
    mountedApp?.unmount();
    mountedApp = null;
    mountedHost?.remove();
    mountedHost = null;
});

describe('DeferredDocumentWorkspaceHost module', () => {
    it('executes the compiled host setup in the unit-app runtime', async () => {
        const { default: DeferredDocumentWorkspaceHost } = await import(
            '@app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue'
        );
        const documentSession = createWorkspaceDocumentController({tabId: 'tab-1'});
        const app = createApp(defineComponent({setup() {
            return () => h(cast<never>(DeferredDocumentWorkspaceHost), {
                documentSession,
                fullscreenSupported: false,
                isActive: false,
                isFullscreen: false,
                isRenderActive: false,
                isStartupOpenClaimPending: false,
                isTabTransitionBusy: false,
                tabId: 'tab-1',
            });
        }}));
        const host = document.createElement('div');
        document.body.append(host);
        app.mount(host);
        mountedApp = app;
        mountedHost = host;
        await nextTick();

        expect(host.querySelector('[data-workspace-tab-id="tab-1"]')).not.toBeNull();
    });
});
