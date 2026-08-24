// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TAgentTextMarkupKind } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import type { TAnnotationCreationOutcome } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import { cast } from '@tests/helpers/cast';
import { createTextMarkupFromTextRunner } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/createTextMarkupFromTextRunner';

function createRunnerHarness() {
    const viewer = document.createElement('div');
    const page = document.createElement('div');
    page.className = 'page_container';
    page.dataset.page = '1';
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const span = document.createElement('span');
    span.append(document.createTextNode('Page 1 text'));
    textLayer.append(span);
    page.append(textLayer);
    viewer.append(page);
    document.body.append(viewer);

    const applySelectionMarkup = vi.fn(async (): Promise<TAnnotationCreationOutcome> => ({
        status: 'created',
        annotationId: 'annotation-1',
    }));
    return {
        applySelectionMarkup,
        createTextMarkupFromText: createTextMarkupFromTextRunner({
            viewerContainer: ref(viewer),
            currentPage: ref(1),
            numPages: ref(1),
            applySelectionMarkup,
        }),
    };
}

describe('createTextMarkupFromTextRunner subtype resolution', () => {
    it.each([
        [
            'highlight',
            'Highlight',
        ],
        [
            'underline',
            'Underline',
        ],
        [
            'strikethrough',
            'StrikeOut',
        ],
        [
            'squiggly',
            'Squiggly',
        ],
    ] as const)('maps the %s kind to %s', async (markup, expected) => {
        const harness = createRunnerHarness();

        const result = await harness.createTextMarkupFromText({
            pageNumber: 1,
            text: 'Page 1 text',
            markup,
        });

        expect(result.subtype).toBe(expected);
        expect(harness.applySelectionMarkup).toHaveBeenCalledWith(false, expect.anything(), expected);
    });

    it('falls back to Highlight for a kind the type system was told could not arrive', async () => {
        // The kind crosses an automation boundary as a plain string, so the
        // declared union is a claim about callers, not a runtime guarantee. An
        // exhaustive switch answered `undefined` here and wrote it into a field
        // declared `TMarkupSubtype`, which then reached pdf.js as a subtype.
        const harness = createRunnerHarness();

        const result = await harness.createTextMarkupFromText({
            pageNumber: 1,
            text: 'Page 1 text',
            markup: cast<TAgentTextMarkupKind>('scribble'),
        });

        expect(result.subtype).toBe('Highlight');
        expect(harness.applySelectionMarkup).toHaveBeenCalledWith(false, expect.anything(), 'Highlight');
        expect(result.created).toBe(true);
    });

    it('falls back to Highlight when no kind is given at all', async () => {
        const harness = createRunnerHarness();

        const result = await harness.createTextMarkupFromText({
            pageNumber: 1,
            text: 'Page 1 text',
        });

        expect(result.subtype).toBe('Highlight');
    });
});
