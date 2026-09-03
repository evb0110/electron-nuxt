import { readFileSync } from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function readWorkspaceFile(path: string) {
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('shared sidebar shell integration', () => {
    it('routes PDF and document-source navigation through the same shell', () => {
        const pdfSidebar = readWorkspaceFile('app/modules/pdf-viewer/components/PdfSidebar.vue');
        const documentSourceSidebar = readWorkspaceFile('app/modules/workspace-shell/components/DocumentSourceSidebar.vue');

        for (const source of [
            pdfSidebar,
            documentSourceSidebar,
        ]) {
            expect(source).toContain('import AppSidebarShell from \'@app/components/sidebar/AppSidebarShell.vue\'');
            expect(source).toContain('<AppSidebarShell');
        }
        expect(documentSourceSidebar).not.toContain('document-source-sidebar__tabs');
        expect(documentSourceSidebar).not.toContain('<nav');
    });

    it('gates sidebar presentation on the open generation that owns the visual surface', () => {
        const workspace = readWorkspaceFile('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const visibility = readWorkspaceFile(
            'app/modules/workspace-shell/composables/useWorkspaceViewerVisibility.ts',
        );

        const editorPane = readWorkspaceFile('app/modules/workspace-shell/components/EditorPaneView.vue');

        expect(workspace).toContain(':show-sidebar="toolbarShowSidebarForDisplay"');
        // The outgoing tab keeps overlaying its centre pixels during a new-tab
        // open, so its sidebar has to stop being presented there too.
        expect(editorPane).toContain('.editor-pane-content > .is-presentation-fallback :deep(.sidebar-wrapper)');
        expect(editorPane).toContain('visibility: hidden;');
        expect(workspace).toContain('useWorkspaceSidebarOpenGeneration({');
        // Driver capability plus the persisted preference only decide whether a
        // sidebar may exist, never which document it belongs to.
        expect(visibility).not.toContain('toolbarShowSidebar');
        expect(visibility).toContain('sidebarPresentationEnabled');
    });

    it('keeps fit measurement and shared scroll policy inside the shell', () => {
        const shell = readWorkspaceFile('app/components/sidebar/AppSidebarShell.vue');

        expect(shell).toContain('useResizeObserver(shellRef, updateTabFitMode)');
        expect(shell).toContain('app-scrollbar app-panel-scroll');
        expect(shell).toContain('app-sidebar-tab-trigger-fluid');

        const sharedStyles = readWorkspaceFile('app/assets/css/main.css');
        expect(sharedStyles).toContain('.app-sidebar-tab-trigger-fluid');
        expect(sharedStyles).toContain('flex: 0 1 auto;');
    });

    it('keeps sidebar panel controls outside one bounded scroll rail', () => {
        const searchPanel = readWorkspaceFile('app/components/document-viewer/DocumentSearchPanel.vue');
        const searchResults = readWorkspaceFile('app/components/document-viewer/DocumentSearchResults.vue');
        const emptyState = readWorkspaceFile('app/components/document-viewer/DocumentPanelEmptyState.vue');

        expect(searchPanel).toMatch(
            /\.document-search-panel__header\s*\{[^}]*flex: 0 0 auto;/su,
        );
        expect(searchPanel).not.toMatch(
            /\.document-search-panel__header\s*\{[^}]*position: sticky;/su,
        );
        expect(searchResults).toMatch(
            /\.document-search-results\s*\{[^}]*flex: 1 1 0;[^}]*min-height: 0;[^}]*overflow: hidden;/su,
        );
        expect(emptyState).toMatch(
            /\.document-panel-empty-state\s*\{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/su,
        );
        for (const source of [
            searchResults,
            emptyState,
        ]) {
            expect(source).not.toContain('min-height: 100%');
        }
    });

    it('keeps compact tab labels available to assistive technology', () => {
        const shell = readWorkspaceFile('app/components/sidebar/AppSidebarShell.vue');

        expect(shell).toContain('label: item.label');
        expect(shell).not.toContain('label: isCompact.value ? \'\' : item.label');
        expect(shell).toContain('label: isCompact.value ? \'sr-only\'');
    });

    it('shares the editor sash hit area and visual states with the sidebar resizer', () => {
        const tokens = readWorkspaceFile('app/assets/css/main.css');
        const sidebarHost = readWorkspaceFile(
            'app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue',
        );
        const editorGrid = readWorkspaceFile(
            'app/modules/workspace-shell/components/EditorPanesGrid.vue',
        );

        expect(tokens).toContain('--app-editor-sash-width: var(--app-editor-sash-size);');
        for (const source of [
            sidebarHost,
            editorGrid,
        ]) {
            expect(source).toContain('background: var(--app-editor-sash-bg);');
            expect(source).toContain('background: var(--app-editor-sash-bg-hover);');
        }
        expect(sidebarHost).toContain('width: var(--app-editor-sash-width);');
        expect(sidebarHost).toMatch(
            /\.sidebar-wrapper\s*\{[^}]*background: var\(--app-sidebar-bg\);/su,
        );
        expect(sidebarHost).toMatch(
            /\.sidebar-wrapper\s*\{[^}]*max-width: 100%;[^}]*flex-shrink: 0;/su,
        );
        expect(sidebarHost).toMatch(
            /\.sidebar-resizer\s*\{[^}]*margin-inline-start: auto;/su,
        );
        expect(sidebarHost).not.toMatch(/\.sidebar-resizer\s*\{[^}]*border-left:/su);

        const shell = readWorkspaceFile('app/components/sidebar/AppSidebarShell.vue');
        expect(shell).toMatch(/\.app-sidebar-shell\s*\{[^}]*flex: 1;/su);
        expect(shell).not.toMatch(/\.app-sidebar-shell\s*\{[^}]*border-inline-end:/su);
    });

    it('defers the panel collapse until the closing slide has finished', () => {
        const sidebarHost = readWorkspaceFile(
            'app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue',
        );
        const tokens = readWorkspaceFile('app/assets/css/main.css');

        expect(tokens).toContain('--app-transition-reorder-duration: 0.2s;');
        expect(tokens).toContain('--app-transition-reorder: var(--app-transition-reorder-duration) ease;');
        expect(sidebarHost).toMatch(
            /\.sidebar-wrapper\.is-closed \.sidebar-wrapper__content\s*\{[^}]*transition: width 0s var\(--app-transition-reorder-duration\);/su,
        );
        expect(sidebarHost).toMatch(
            /\.sidebar-wrapper__content\s*\{[^}]*flex: 0 0 auto;/su,
        );
    });

});
