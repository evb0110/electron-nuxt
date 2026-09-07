import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    asAnnotationId,
    type INoteEntity,
    type ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {AnnotationStore} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import {
    buildSerializationPlan,
    verifyAnnotationSave,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import {requirePageIndex} from '@contracts/pageNumbers';

function note(id = 'note'): INoteEntity {
    return {
        kind: 'note',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        contents: 'note contents',
        position: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
        color: '#ffcc00',
        open: false,
    };
}

function markup(id = 'markup'): ITextMarkupEntity {
    return {
        kind: 'text-markup',
        identity: {id: asAnnotationId(id)},
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: null,
        modifiedAt: null,
        author: null,
        subtype: 'Highlight',
        contents: '',
        quadPoints: [{
            left: 0.1,
            top: 0.2,
            width: 0.2,
            height: 0.04,
        }],
        color: '#ffff00',
        opacity: 0.6,
    };
}

function planFor(entity: INoteEntity | ITextMarkupEntity) {
    const store = new AnnotationStore();
    if (entity.kind === 'note') {
        store.createNote(entity);
    } else {
        store.createTextMarkup(entity);
    }
    const frontier = store.beginSave();
    return buildSerializationPlan(
        frontier,
        store.dirtyEntities(),
        store.list({includeDeleted: true}),
    );
}

function expectedMarkup(plan: ReturnType<typeof planFor>): ITextMarkupEntity {
    const expected = plan.expected[0];
    if (!expected || expected.kind !== 'text-markup') {
        throw new Error('Expected a text markup save plan');
    }
    return expected;
}

describe('annotation save reopen verification', () => {
    it('rejects a note whose persisted color differs from the canonical entity', async () => {
        const plan = planFor(note());
        const reopened = {
            ...plan.expected[0]!,
            color: '#00ccff',
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).rejects.toThrow('note: note color mismatch');
    });

    it('rejects a note whose persisted open state differs from the canonical entity', async () => {
        const plan = planFor({
            ...note(),
            open: true,
        });
        const reopened = {
            ...plan.expected[0]!,
            open: false,
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).rejects.toThrow('note: note open state mismatch');
    });

    it('rejects a markup whose persisted color differs from the canonical entity', async () => {
        const plan = planFor(markup());
        const reopened = {
            ...expectedMarkup(plan),
            color: '#00ccff',
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).rejects.toThrow('markup: markup color mismatch');
    });

    it('accepts color casing and Float32 opacity round-trip quantization', async () => {
        const plan = planFor(markup());
        const reopened = {
            ...expectedMarkup(plan),
            color: '#FFFF00',
            opacity: new Float32Array([0.6]).at(0) ?? 0.6,
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).resolves.toBeUndefined();
    });

    it('rejects a markup whose persisted opacity differs from the canonical entity', async () => {
        const plan = planFor(markup());
        const reopened = {
            ...expectedMarkup(plan),
            opacity: 0.2,
        };

        await expect(verifyAnnotationSave(
            Uint8Array.of(1),
            plan,
            {reopen: async () => [reopened]},
        )).rejects.toThrow('markup: markup opacity mismatch');
    });
});
