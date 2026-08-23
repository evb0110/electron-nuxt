// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDocumentThumbnailSourceHarness,
    installDocumentThumbnailListEnvironment,
    mountDocumentThumbnailList,
    restoreDocumentThumbnailListEnvironment,
    settleDocumentThumbnailList,
} from '@tests/helpers/document-viewer/documentThumbnailListHarness';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

beforeEach(installDocumentThumbnailListEnvironment);
afterEach(restoreDocumentThumbnailListEnvironment);

describe('DocumentThumbnailList virtualization', () => {
    it('keeps a 500-page source to a bounded mounted row count', async () => {
        const harness = createDocumentThumbnailSourceHarness(500, '/large.pdf');
        const {host} = mountDocumentThumbnailList(harness.source);
        await settleDocumentThumbnailList();

        const rows = host.querySelectorAll('[data-document-thumbnail-item]');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(30);
        expect(host.querySelectorAll('[data-thumbnail-page]').length).toBe(rows.length);

        // Every raster came from the thumbnail provider. A rail that fell back
        // to full-page renders would rasterize at viewer resolution, which is
        // the cost this bounded row count exists to avoid.
        expect(harness.renderCalls.length).toBeGreaterThan(0);
        expect(harness.pageRenderCalls).toEqual([]);
    });
});
