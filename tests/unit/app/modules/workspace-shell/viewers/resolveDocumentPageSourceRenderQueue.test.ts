import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveDocumentPageSourceRenderQueue } from '@app/modules/workspace-shell/viewers/resolveDocumentPageSourceRenderQueue';

describe('resolveDocumentPageSourceRenderQueue', () => {
    it('keeps navigation first and fills the forward runway farthest-first', () => {
        expect(resolveDocumentPageSourceRenderQueue({
            bufferPages: [
                8,
                9,
                11,
                12,
            ],
            concurrency: 2,
            currentPage: 10,
            guardRadius: 12,
            inFlightPages: [],
            mountedPages: [
                8,
                9,
                10,
                11,
                12,
            ],
            needsRender: () => true,
            preferredDirection: 1,
            residentPages: [
                8,
                9,
                10,
                11,
                12,
            ],
            visiblePages: [10],
        })).toEqual({
            pagesToAbort: [],
            pagesToRender: [
                10,
                12,
            ],
        });
    });

    it('cancels work behind monotonic scrolling without overbooking worker lanes', () => {
        expect(resolveDocumentPageSourceRenderQueue({
            bufferPages: [
                9,
                11,
            ],
            concurrency: 2,
            currentPage: 10,
            guardRadius: 12,
            inFlightPages: [
                9,
                11,
            ],
            mountedPages: [
                9,
                10,
                11,
            ],
            needsRender: () => true,
            preferredDirection: 1,
            residentPages: [
                9,
                10,
                11,
            ],
            visiblePages: [10],
        })).toEqual({
            pagesToAbort: [9],
            pagesToRender: [],
        });
    });
});
