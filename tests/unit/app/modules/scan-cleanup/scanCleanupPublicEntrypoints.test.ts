import {readFileSync} from 'node:fs';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('scan cleanup public entrypoints', () => {
    it('keeps toolbar runtime imports outside the async workspace boundary', () => {
        const runtime = readFileSync('app/modules/scan-cleanup/public/runtime.ts', 'utf8');
        const workspace = readFileSync('app/modules/scan-cleanup/public/workspace.ts', 'utf8');
        const toolbar = readFileSync('app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue', 'utf8');
        const documentWorkspace = readFileSync('app/modules/workspace-shell/components/DocumentWorkspace.vue', 'utf8');

        expect(runtime).not.toContain('ScanCleanupWorkspace');
        expect(workspace).toContain('ScanCleanupWorkspace');
        expect(toolbar).toContain('from \'@app/modules/scan-cleanup/public/runtime\'');
        expect(toolbar).not.toContain('public/workspace');
        expect(documentWorkspace).toContain('import(\'@app/modules/scan-cleanup/public/workspace\')');
        expect(documentWorkspace).not.toContain('import(\'@app/modules/scan-cleanup/public\')');
    });
});
