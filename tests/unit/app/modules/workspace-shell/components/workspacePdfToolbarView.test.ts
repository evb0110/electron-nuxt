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
import { workspacePdfToolbarCommands } from '@app/modules/workspace-shell/toolbar/workspacePdfToolbarCommands';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function readWorkspaceFile(path: string) {
    return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('workspace PDF toolbar wiring', () => {
    it('keeps direct PdfToolbar usage centralized in the workspace presenter', () => {
        const documentWorkspace = readWorkspaceFile('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const shellToolbar = readWorkspaceFile('app/modules/workspace-shell/components/ShellWorkspaceToolbar.vue');
        const presenter = readWorkspaceFile('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue');

        expect(documentWorkspace).toContain('<WorkspacePdfToolbarView');
        expect(shellToolbar).toContain('<WorkspacePdfToolbarView');
        expect(documentWorkspace).not.toContain('<PdfToolbar');
        expect(shellToolbar).not.toContain('<PdfToolbar');
        expect(presenter).toContain('<PdfToolbar');
    });

    it('wires every shared toolbar command in real and shell handoff modes', () => {
        const documentWorkspace = readWorkspaceFile('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const shellToolbar = readWorkspaceFile('app/modules/workspace-shell/components/ShellWorkspaceToolbar.vue');

        for (const command of workspacePdfToolbarCommands) {
            expect(documentWorkspace, `DocumentWorkspace missing @${command}`).toContain(`@${command}=`);
            expect(shellToolbar, `ShellWorkspaceToolbar missing @${command}`).toContain(`@${command}=`);
        }
    });

    it('routes pre-mount shell page commands into the host viewport session', () => {
        const appShell = readWorkspaceFile('app/modules/workspace-shell/components/AppShellRoot.vue');
        const shellToolbar = readWorkspaceFile('app/modules/workspace-shell/components/ShellWorkspaceToolbar.vue');
        const deferredHost = readWorkspaceFile('app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue');

        expect(appShell).toContain('v-on="fallbackToolbarCommandListeners"');
        expect(shellToolbar).toContain('@go-to-page="handleGoToPage"');
        expect(deferredHost).toContain('handleGoToPage: page => {');
        expect(deferredHost).toContain('documentOpenSurface.requestNavigation(page);');
    });

    it('uses the same opening-document state for live and shell toolbar snapshots', () => {
        const documentWorkspace = readWorkspaceFile('app/modules/workspace-shell/components/DocumentWorkspace.vue');

        expect(documentWorkspace).toContain('isOpeningDocument: isOpeningDocumentForToolbarDisplay.value');
        expect(documentWorkspace).not.toContain('isOpeningDocument: pendingDocumentOpen.value');
    });

    it('keeps page-step navigation command-capable while opening metadata is unknown', () => {
        const presenter = readWorkspaceFile('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue');
        const pageDropdown = readWorkspaceFile('app/modules/pdf-viewer/components/PdfPageDropdown.vue');

        expect(presenter).toContain(':disabled="pageNavigationDisabled"');
        expect(presenter).toContain('toolbarDocumentBusy.value ? false : toolbarControlsDisabled.value');
        expect(pageDropdown).toContain('totalPages > 0 && commandPage >= totalPages');
        expect(pageDropdown).toContain('totalPages <= 0 || commandPage.value < totalPages');
        expect(pageDropdown).toContain(':disabled="disabled || totalPages === 0 || commandPage >= totalPages"');
    });

    it('routes inline, app-menu, and overflow print commands through the shared busy predicate', () => {
        const presenter = readWorkspaceFile('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue');
        const toolbar = readWorkspaceFile('app/modules/pdf-viewer/components/PdfToolbar.vue');
        const appMenu = readWorkspaceFile('app/components/toolbar/ToolbarAppMenu.vue');
        const overflowMenu = readWorkspaceFile('app/components/toolbar/ToolbarOverflowMenu.vue');

        expect(presenter).toContain(':is-any-saving="snapshot.isAnySaving"');
        expect(presenter).toContain(':is-history-busy="snapshot.isHistoryBusy"');
        for (const source of [
            toolbar,
            appMenu,
            overflowMenu,
        ]) {
            expect(source).toContain('isReaderPrintCommandDisabled');
        }
        expect(overflowMenu).toContain('disabled: isPrintCommandDisabled.value');
    });

    it('has a compact, scroll-safe terminal toolbar tier', () => {
        const toolbar = readWorkspaceFile('app/modules/pdf-viewer/components/PdfToolbar.vue');

        expect(toolbar).toContain('const pageCompactLevel = computed');
        expect(toolbar).toContain('const zoomCompactLevel = computed');
        expect(toolbar).toContain('.toolbar[data-collapse-tier=\'5\'] .toolbar-section');
        expect(toolbar).toContain('overflow-x: auto');
        expect(toolbar).toContain('isCommandInline(\'settings\') && !isCollapsed(5)');
        expect(toolbar).toContain('<AssistantToolbarToggle v-if="!isCollapsed(5)"');
    });
});
