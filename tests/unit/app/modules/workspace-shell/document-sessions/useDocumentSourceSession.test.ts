import {
    describe,
    expect,
    it,
} from 'vitest';
import { effectScope } from 'vue';
import { useDocumentSourceSession } from '@app/modules/workspace-shell/document-sessions/useDocumentSourceSession';

describe('useDocumentSourceSession', () => {
    it('owns source identity and capabilities without a format mode flag', () => {
        const scope = effectScope();
        const session = scope.run(() => useDocumentSourceSession());
        if (!session) {
            throw new Error('Failed to create document source session');
        }

        session.activateDocumentSource('djvu', '/books/source.djvu');

        expect(session.sourceKind.value).toBe('djvu');
        expect(session.sourceRef.value).toBe('/books/source.djvu');
        expect(session.isDjvuSource.value).toBe(true);
        expect(session.capabilities.value).toMatchObject({
            directImageExport: true,
            pageEdits: false,
        });

        session.clearDocumentSource();
        expect(session.sourceKind.value).toBeNull();
        expect(session.sourceRef.value).toBeNull();
        expect(session.isDjvuSource.value).toBe(false);
        scope.stop();
    });
});
