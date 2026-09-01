import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computed,
    effectScope,
    shallowRef,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {
    asAnnotationId,
    type AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {usePdfAnnotationEditorSurface} from '@app/modules/pdf-viewer/runtime/annotations/usePdfAnnotationEditorSurface';
import type {
    IAnnotationMarkerRect,
    TAnnotationTool,
} from '@app/types/annotations';

const rect: IAnnotationMarkerRect = {
    left: 0.1,
    top: 0.2,
    width: 0.2,
    height: 0.05,
};

function baseEntity(id: string, pageIndex = 0) {
    return {
        identity: {id: asAnnotationId(id)},
        pageIndex,
        revision: 0,
        persistedRevision: -1,
        deleted: false as const,
        createdAt: null,
        modifiedAt: null,
        author: null,
    };
}

function createSurfaceHarness() {
    const annotationApplication = shallowRef(new AnnotationApplication('surface-test'));
    const scope = effectScope();
    const surface = scope.run(() => usePdfAnnotationEditorSurface({
        annotationApplication,
        activeTool: computed<TAnnotationTool>(() => 'select'),
        settings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
    }))!;
    return {
        annotationApplication,
        surface,
        stop: () => scope.stop(),
    };
}

describe('usePdfAnnotationEditorSurface', () => {
    it('projects every authored kind from the store and preserves markup subtypes and geometry', () => {
        const harness = createSurfaceHarness();
        const { store } = harness.annotationApplication.value;
        const entities: AnnotationEntity[] = [
            {
                kind: 'text-box',
                ...baseEntity('text-box'),
                text: 'text box',
                rect,
                rotation: 0,
                fontSize: 18,
                color: '#111827',
            },
            {
                kind: 'note',
                ...baseEntity('note'),
                contents: 'note',
                position: {
                    ...rect,
                    width: 0.018,
                    height: 0.018,
                },
                color: '#f59e0b',
                open: false,
            },
            {
                kind: 'placed-image',
                ...baseEntity('placed-image'),
                rect,
                rotation: 0,
                image: {
                    objectNumber: 10,
                    generationNumber: 0,
                    byteLength: 4,
                    sha256: 'a'.repeat(64),
                },
            },
            {
                kind: 'text-markup',
                ...baseEntity('text-markup'),
                subtype: 'Underline',
                contents: 'markup note',
                quadPoints: [
                    rect,
                    {
                        ...rect,
                        top: 0.3,
                    },
                ],
                color: '#2563eb',
                opacity: 0.8,
                selectedText: 'underlined text',
            },
            {
                kind: 'shape',
                ...baseEntity('shape'),
                tool: 'rectangle',
                rect,
                strokeColor: '#dc2626',
                strokeWidth: 2,
                fill: null,
                opacity: 1,
            },
        ];

        entities.forEach((entity) => {
            switch (entity.kind) {
                case 'text-box':
                    store.createTextBox(entity);
                    break;
                case 'note':
                    store.createNote(entity);
                    break;
                case 'placed-image':
                    store.createPlacedImage(entity);
                    break;
                case 'text-markup':
                    store.createTextMarkup(entity);
                    break;
                case 'shape':
                    store.createShape(entity);
                    break;
            }
        });

        const projected = harness.surface.getEntitiesForPage(0);
        expect(projected.map(entity => entity.kind)).toEqual([
            'text-box',
            'note',
            'placed-image',
            'text-markup',
            'shape',
        ]);
        const markup = projected.find((entity) => entity.kind === 'text-markup');
        expect(markup).toMatchObject({
            kind: 'text-markup',
            subtype: 'Underline',
            quadPoints: [
                rect,
                {
                    ...rect,
                    top: 0.3,
                },
            ],
            selectedText: 'underlined text',
        });

        harness.surface.select([asAnnotationId('text-markup')]);
        harness.surface.select([asAnnotationId('shape')], {additive: true});
        expect(store.selectedIds).toEqual(new Set([
            asAnnotationId('text-markup'),
            asAnnotationId('shape'),
        ]));

        harness.stop();
    });

    it('removes tombstoned entities from the page projection', () => {
        const harness = createSurfaceHarness();
        const entity = {
            kind: 'note' as const,
            ...baseEntity('deleted-note'),
            contents: '',
            position: rect,
            color: null,
            open: false,
        };
        harness.annotationApplication.value.store.createNote(entity);
        expect(harness.surface.getEntitiesForPage(0)).toHaveLength(1);

        harness.annotationApplication.value.store.delete(entity.identity.id);

        expect(harness.surface.getEntitiesForPage(0)).toEqual([]);
        harness.stop();
    });
});
