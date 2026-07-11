import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfPageLayerRevisionGraph } from '@app/modules/pdf-viewer/runtime/rendering/createPdfPageLayerRevisionGraph';

describe('createPdfPageLayerRevisionGraph', () => {
    it('invalidates only the requested page and dependent thumbnail layer', () => {
        const graph = createPdfPageLayerRevisionGraph();
        graph.bump(2, 'annotations');
        expect(graph.get(2)).toMatchObject({
            annotations: 1,
            thumbnail: 1,
            base: 0,
        });
        expect(graph.get(3)).toMatchObject({
            annotations: 0,
            thumbnail: 0,
            base: 0,
        });
    });
});
