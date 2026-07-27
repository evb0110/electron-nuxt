import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('scan cleanup cold entry', () => {
    it('keeps a reserved workspace visible while the feature chunk loads', () => {
        const workspace = read('app/modules/workspace-shell/components/DocumentWorkspace.vue');
        const loadingSurface = read(
            'app/modules/workspace-shell/components/ScanCleanupWorkspaceLoading.vue',
        );

        expect(workspace).toContain('loadingComponent: ScanCleanupWorkspaceLoading');
        expect(workspace).toContain('delay: 0');
        expect(workspace).toContain('surfaceMode === \'reader\' || !scanCleanupWorkspaceMounted');
        expect(workspace).toContain('@ready="scanCleanupWorkspaceMounted = true"');
        expect(workspace).toContain('class="scan-cleanup-workspace-boundary"');
        expect(loadingSurface).toContain('class="scan-cleanup-loading-surface"');
        expect(loadingSurface).toContain('aria-busy="true"');
        expect(loadingSurface).toContain('class="scan-cleanup-loading-preview-stage"');
    });
});
