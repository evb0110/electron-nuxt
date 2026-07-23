import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFile } from 'node:fs/promises';

describe('DeferredDocumentWorkspaceHost Recent geometry policy', () => {
    it('does not prewarm cold Recent entries from the deferred workspace host', async () => {
        const source = await readFile(
            new URL('../../../../../../app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue', import.meta.url),
            'utf8',
        );

        expect(source).not.toContain('prepareRecentGeometry');
        expect(source).not.toContain('beginRecentOpenGeometryPrewarm');
        expect(source).not.toContain('settleRecentOpenGeometryPrewarm');
        expect(source).not.toContain('prewarmRecentDjvuOpeningGeometry');
        expect(source).not.toContain('readRecentOpenGeometryState');
    });
});
