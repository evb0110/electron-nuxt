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
});
