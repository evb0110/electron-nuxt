import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    shallowRef,
} from 'vue';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {createPdfAnnotationEditorCompatibility} from '@app/modules/pdf-viewer/runtime/annotations/createPdfAnnotationEditorCompatibility';

describe('createPdfAnnotationEditorCompatibility', () => {
    it('forwards pending text draft commits to the canonical editor surface', () => {
        const commitPendingFreeTextDraftsForSave = vi.fn();
        const compatibility = createPdfAnnotationEditorCompatibility({
            annotationApplication: shallowRef(new AnnotationApplication('compatibility-test')),
            annotationSettings: computed(() => null),
            canonicalMarkupSubtypeHints: new Map(),
            commitPendingFreeTextDraftsForSave,
        });

        compatibility.editor.commitPendingFreeTextDraftsForSave();

        expect(commitPendingFreeTextDraftsForSave).toHaveBeenCalledOnce();
    });
});
