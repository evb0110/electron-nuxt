import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { ITextBoxEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { IAnnotationEditorSurface } from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import { useAnnotationCreationTools } from '@app/modules/pdf-viewer/annotations/editor/useAnnotationCreationTools';

const entity = {
    kind: 'text-box',
    identity: {id: 'text-box' as ITextBoxEntity['identity']['id']},
    pageIndex: 2,
    revision: 0,
    persistedRevision: -1,
    deleted: false,
    createdAt: null,
    modifiedAt: null,
    author: null,
    text: '',
    rect: {
        left: 0.2,
        top: 0.3,
        width: 0.4,
        height: 0.2,
    },
    rotation: 0,
    fontSize: 14,
    color: '#111827',
} satisfies ITextBoxEntity;

describe('useAnnotationCreationTools', () => {
    it('creates and selects only the text tool entity', () => {
        const createTextBoxAt = vi.fn(() => entity);
        const select = vi.fn();
        const surfaceMethods: Pick<IAnnotationEditorSurface, 'createTextBoxAt' | 'select'> = {
            createTextBoxAt,
            select,
        };
        const tools = useAnnotationCreationTools({surface: {...surfaceMethods} as IAnnotationEditorSurface});

        expect(tools.create('text', 2, entity.rect)).toBe(entity);
        expect(createTextBoxAt).toHaveBeenCalledWith(2, entity.rect);
        expect(select).toHaveBeenCalledWith([entity.identity.id]);
        expect(tools.create('highlight', 2, entity.rect)).toBeNull();
        expect(createTextBoxAt).toHaveBeenCalledOnce();
    });
});
