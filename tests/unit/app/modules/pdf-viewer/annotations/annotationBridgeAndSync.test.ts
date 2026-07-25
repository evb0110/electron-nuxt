import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {PdfjsAnnotationFacade} from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

describe('annotation bridge leases and sync protocol', () => {
    it('rejects editor continuations after any lease generation changes', () => {
        const generations = {
            document: 1,
            manager: 1,
            page: 1,
        };
        const facade = new PdfjsAnnotationFacade({
            get document() { return generations.document; },
            get manager() { return generations.manager; },
            page: () => generations.page,
        });
        const editor = {};
        const lease = facade.bindEditor(editor, asAnnotationId('anno_lease'), 'editor-1', 0);
        const action = vi.fn(() => 'ok');
        expect(facade.withEditor(lease, 0, () => editor, action)).toEqual({
            status: 'ok',
            value: 'ok',
        });
        generations.page += 1;
        expect(facade.withEditor(lease, 0, () => editor, action)).toEqual({status: 'stale'});
        expect(action).toHaveBeenCalledOnce();
    });

    it('does not retain an editor when a lease continuation cannot resolve it synchronously', () => {
        const facade = new PdfjsAnnotationFacade({
            document: 1,
            manager: 1,
            page: () => 1,
        });
        const editor = {};
        const lease = facade.bindEditor(editor, asAnnotationId('anno_ephemeral'), 'editor-ephemeral', 0);
        const action = vi.fn();

        expect(facade.withEditor(lease, 0, () => null, action)).toEqual({status: 'stale'});
        expect(action).not.toHaveBeenCalled();
    });

    it('reports named versioned manager capabilities without exposing the manager', () => {
        const facade = new PdfjsAnnotationFacade({
            document: 1,
            manager: 1,
            page: () => 1,
        });
        const capabilities = facade.capabilities({
            undo() {},
            updateParams() {},
        }, '5.7.284');
        expect(capabilities.version).toBe('5.7.284');
        expect(capabilities.manager).toMatchObject({
            undo: true,
            updateParams: true,
            redo: false,
        });
        expect(Object.isFrozen(capabilities)).toBe(true);
        expect(Object.isFrozen(capabilities.manager)).toBe(true);
    });
});
