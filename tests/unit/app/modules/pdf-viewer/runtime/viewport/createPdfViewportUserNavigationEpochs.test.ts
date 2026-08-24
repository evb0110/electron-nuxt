import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfViewportUserNavigationEpochs } from '@app/modules/pdf-viewer/runtime/viewport/createPdfViewportUserNavigationEpochs';

describe('createPdfViewportUserNavigationEpochs', () => {
    it('treats an ordinary scroll as physical navigation', () => {
        const epochs = createPdfViewportUserNavigationEpochs();

        epochs.markScrollInteraction();

        expect(epochs.userViewportInteractionEpoch.value).toBe(1);
        expect(epochs.userPhysicalNavigationEpoch.value).toBe(1);
    });

    it('attributes scroll emitted by a geometry replacement to the viewer, not the user', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        const endReplacement = epochs.beginLayoutGeometryReplacement();

        epochs.markScrollInteraction();
        epochs.markScrollInteraction();

        expect(epochs.userViewportInteractionEpoch.value).toBe(2);
        expect(epochs.userPhysicalNavigationEpoch.value).toBe(0);

        endReplacement();
        epochs.markScrollInteraction();

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(1);
    });

    it('keeps trusted wheel and pointer input authoritative during a geometry replacement', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        const endReplacement = epochs.beginLayoutGeometryReplacement();

        epochs.markPhysicalNavigation();

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(1);
        endReplacement();
    });

    it('only reopens scroll attribution once every nested replacement has closed', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        const endOuter = epochs.beginLayoutGeometryReplacement();
        const endInner = epochs.beginLayoutGeometryReplacement();

        endInner();
        // A double close must not leak a negative depth that reopens the
        // window while the outer replacement is still running.
        endInner();
        epochs.markScrollInteraction();

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(0);

        endOuter();
        epochs.markScrollInteraction();

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(1);
    });
});
