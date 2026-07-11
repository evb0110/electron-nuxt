// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import { buildVisualMatchesWithCurrent } from '@app/modules/pdf-viewer/engine/search/buildVisualMatchesWithCurrent';
import {
    clearTextLayerTextMapping,
    getCachedTextLayerIndex,
    highlightTextRunInPdfjsStyle,
    registerTextLayerTextMapping,
} from '@app/modules/pdf-viewer/engine/search/pdfSearchHighlightDom';
import { requirePageIndex } from '@contracts/pageNumbers';

describe('usePdfSearchHighlight', () => {
    it('keeps backend identity instead of re-finding matches in the rendered layer', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'alpha',
            searchOptions: {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
            matches: [
                {
                    matchIndex: 0,
                    start: 6,
                    end: 11,
                },
                {
                    matchIndex: 1,
                    start: 0,
                    end: 5,
                },
            ],
        };
        const currentMatch: IPdfSearchMatch = {
            pageIndex: requirePageIndex(0),
            pageMatchIndex: 1,
            matchIndex: 1,
            startOffset: 0,
            endOffset: 5,
        };

        const result = buildVisualMatchesWithCurrent(pageMatches, currentMatch, 'alpha beta alpha');

        expect(result).toEqual([
            {
                start: 6,
                end: 11,
                isCurrent: false,
            },
            {
                start: 0,
                end: 5,
                isCurrent: true,
            },
        ]);
    });

    it('keeps compatible backend offsets instead of adding extra local matches', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'alpha',
            matches: [{
                matchIndex: 0,
                start: 0,
                end: 5,
            }],
        };

        const result = buildVisualMatchesWithCurrent(pageMatches, null, 'alpha beta alpha');

        expect(result).toEqual([{
            start: 0,
            end: 5,
            isCurrent: false,
        }]);
    });

    it('drops unmappable backend ranges without inventing layer-local matches', () => {
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: '',
            searchQuery: 'alpha',
            searchOptions: {
                matchCase: false,
                wholeWord: false,
                useRegex: false,
            },
            matches: [
                {
                    matchIndex: 10,
                    start: 100,
                    end: 105,
                },
                {
                    matchIndex: 11,
                    start: 12,
                    end: 17,
                },
            ],
        };
        const currentMatch: IPdfSearchMatch = {
            pageIndex: requirePageIndex(0),
            pageMatchIndex: 1,
            matchIndex: 11,
            startOffset: 12,
            endOffset: 17,
        };

        const result = buildVisualMatchesWithCurrent(pageMatches, currentMatch, 'alpha alpha alpha');

        expect(result).toEqual([{
            start: 12,
            end: 17,
            isCurrent: true,
        }]);
    });

    it('maps collapsed fake-bold text to one authoritative highlight set', () => {
        const segment = 'alpha beta gamma delta '.repeat(8);
        const pageMatches: IPdfPageMatches = {
            pageIndex: requirePageIndex(0),
            pageText: segment,
            searchQuery: 'alpha',
            matches: [{
                matchIndex: 0,
                start: 0,
                end: 5,
            }],
        };

        expect(buildVisualMatchesWithCurrent(pageMatches, null, segment.repeat(2))).toEqual([{
            start: 0,
            end: 5,
            isCurrent: false,
        }]);
    });
});

describe('pdfSearchHighlightDom text-layer mapping', () => {
    it('uses pdf.js text mapping instead of reconstructed span text', () => {
        const textLayer = document.createElement('div');
        const span = document.createElement('span');
        span.textContent = 'mutated';
        textLayer.append(span);

        registerTextLayerTextMapping(textLayer, {
            textDivs: [span],
            textContentItemsStr: ['canonical'],
        });

        const index = getCachedTextLayerIndex(textLayer);

        expect(index.text).toBe('canonical');
        expect(index.runs[0]).toMatchObject({
            kind: 'span',
            startOffset: 0,
            endOffset: 9,
        });

        clearTextLayerTextMapping(textLayer);
    });

    it('keeps text-layer line breaks in the search offset domain', () => {
        const textLayer = document.createElement('div');
        const first = document.createElement('span');
        const second = document.createElement('span');
        first.textContent = 'first';
        second.textContent = 'second';
        textLayer.append(first, document.createElement('br'), second);

        registerTextLayerTextMapping(textLayer, {
            textDivs: [
                first,
                second,
            ],
            textContentItemsStr: [
                'first',
                'second',
            ],
        });

        const index = getCachedTextLayerIndex(textLayer);

        expect(index.text).toBe('first\nsecond');
        expect(index.runs.map(run => ({
            kind: run.kind,
            startOffset: run.startOffset,
            endOffset: run.endOffset,
        }))).toEqual([
            {
                kind: 'span',
                startOffset: 0,
                endOffset: 5,
            },
            {
                kind: 'br',
                startOffset: 5,
                endOffset: 6,
            },
            {
                kind: 'span',
                startOffset: 6,
                endOffset: 12,
            },
        ]);

        clearTextLayerTextMapping(textLayer);
    });

    it('paints highlights as pdf.js-style inline spans inside mapped text divs', () => {
        const span = document.createElement('span');
        span.textContent = 'stale';
        const textNode = document.createTextNode('canonical');
        span.replaceChildren(textNode);

        const elements = highlightTextRunInPdfjsStyle(
            {
                kind: 'span',
                span,
                textNode,
                text: 'canonical',
                startOffset: 0,
                endOffset: 9,
            },
            [{
                start: 0,
                end: 5,
                isCurrent: true,
            }],
            'pdf-search-highlight',
            'pdf-search-highlight--current',
        );

        expect(elements).toHaveLength(1);
        expect(elements[0]?.tagName).toBe('SPAN');
        expect(elements[0]?.className).toBe('pdf-search-highlight appended pdf-search-highlight--current');
        expect(span.querySelector('mark')).toBeNull();
        expect(span.textContent).toBe('canonical');
    });

    it('marks multi-div highlights with pdf.js begin and end segment classes', () => {
        const first = document.createElement('span');
        const second = document.createElement('span');
        const firstTextNode = document.createTextNode('alpha');
        const secondTextNode = document.createTextNode('beta');
        first.append(firstTextNode);
        second.append(secondTextNode);
        const match = {
            start: 2,
            end: 8,
            isCurrent: false,
        };

        const firstHighlights = highlightTextRunInPdfjsStyle(
            {
                kind: 'span',
                span: first,
                textNode: firstTextNode,
                text: 'alpha',
                startOffset: 0,
                endOffset: 5,
            },
            [match],
            'pdf-search-highlight',
            'pdf-search-highlight--current',
        );
        const secondHighlights = highlightTextRunInPdfjsStyle(
            {
                kind: 'span',
                span: second,
                textNode: secondTextNode,
                text: 'beta',
                startOffset: 5,
                endOffset: 9,
            },
            [match],
            'pdf-search-highlight',
            'pdf-search-highlight--current',
        );

        expect(firstHighlights[0]?.className).toBe('pdf-search-highlight appended begin');
        expect(secondHighlights[0]?.className).toBe('pdf-search-highlight appended end');
    });
});
