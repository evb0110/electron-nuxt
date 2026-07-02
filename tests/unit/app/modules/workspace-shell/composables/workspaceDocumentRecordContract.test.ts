import {
    existsSync,
    readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

function readProjectFile(path: string) {
    return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('workspace document record ownership contract', () => {
    it('keeps shell toolbar state free of workspace snapshot mirror polling', () => {
        const source = readProjectFile('app/modules/workspace-shell/composables/useShellWorkspaceToolbar.ts');

        expect(source).not.toContain('getToolbarSnapshot');
        expect(source).not.toContain('shellToolbarHandoffWarningDelayMs');
        expect(source).not.toContain('hasTeleportedToolbarContent');
    });

    it('does not carry transient tab metadata suppression heuristics', () => {
        const lifecycle = readProjectFile('app/modules/workspace-shell/composables/useAppShellTabLifecycle.ts');
        const deferredHost = readProjectFile('app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue');

        expect(lifecycle).not.toContain('isTransientDocumentClearDuringRemount');
        expect(lifecycle).not.toContain('Suppressing transient placeholder');
        expect(deferredHost).not.toContain('isEmptyTabDocumentUpdate');
        expect(deferredHost).not.toContain('Suppressing empty workspace tab update');
    });

    it('removes the ghost toolbar teleport bridge module', () => {
        expect(existsSync(join(
            process.cwd(),
            'app/modules/workspace-shell/composables/useToolbarTeleportBridge.ts',
        ))).toBe(false);
    });
});
