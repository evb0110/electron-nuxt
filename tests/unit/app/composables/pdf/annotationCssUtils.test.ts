import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    commentPreviewFromRawText,
    commentPreviewText,
    toCssColor,
} from '@app/composables/pdf/annotationCssUtils';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

function createComment(text: string): IAnnotationCommentSummary {
    return {
        id: 'id',
        stableKey: 'key',
        pageIndex: 0,
        pageNumber: 1,
        text,
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'editor',
    };
}

describe('commentPreviewText', () => {
    it('returns the raw text when it fits within the preview length limit', () => {
        const result = commentPreviewText(createComment('Hello world'), '(empty)');
        expect(result).toBe('Hello world');
    });

    it('trims leading and trailing whitespace before evaluating length', () => {
        const result = commentPreviewText(createComment('   short note   '), '(empty)');
        expect(result).toBe('short note');
    });

    it('returns the empty-note label for whitespace-only text', () => {
        const result = commentPreviewText(createComment('   \n\t  '), '(empty)');
        expect(result).toBe('(empty)');
    });

    it('returns the empty-note label for an entirely empty string', () => {
        const result = commentPreviewText(createComment(''), 'No note');
        expect(result).toBe('No note');
    });

    it('truncates long text to 117 chars plus ellipsis', () => {
        const longText = 'a'.repeat(200);
        const result = commentPreviewText(createComment(longText), '(empty)');
        expect(result).toHaveLength(120);
        expect(result.endsWith('...')).toBe(true);
        expect(result.slice(0, 117)).toBe('a'.repeat(117));
    });

    it('returns the raw text untruncated at exactly the 120-char boundary', () => {
        const exact = 'b'.repeat(120);
        const result = commentPreviewText(createComment(exact), '(empty)');
        expect(result).toBe(exact);
    });
});

describe('toCssColor', () => {
    it('applies opacity to hex color strings', () => {
        expect(toCssColor('#00bcd4', 0.7)).toBe('rgba(0, 188, 212, 0.7)');
    });

    it('preserves rgba strings that already carry alpha', () => {
        expect(toCssColor('rgba(0, 188, 212, 0.7)', 0.7)).toBe('rgba(0, 188, 212, 0.7)');
    });

    it('clamps opacity for array colors', () => {
        expect(toCssColor([
            0,
            188,
            212,
        ], 1.4)).toBe('rgba(0, 188, 212, 1)');
    });
});

describe('commentPreviewFromRawText', () => {
    it('returns the trimmed text for typical input', () => {
        expect(commentPreviewFromRawText('  hello  ', '(empty)')).toBe('hello');
    });

    it('returns the empty-note label when text is empty', () => {
        expect(commentPreviewFromRawText('', 'fallback')).toBe('fallback');
    });

    it('returns the empty-note label when text is whitespace only', () => {
        expect(commentPreviewFromRawText('\n\n\t', 'fallback')).toBe('fallback');
    });

    it('truncates text longer than 120 characters with an ellipsis suffix', () => {
        const longText = 'x'.repeat(150);
        const result = commentPreviewFromRawText(longText, '(empty)');
        expect(result).toBe(`${'x'.repeat(117)}...`);
    });

    it('returns input unchanged at boundary length 120', () => {
        const exact = 'y'.repeat(120);
        expect(commentPreviewFromRawText(exact, '(empty)')).toBe(exact);
    });

    it('truncates a string of exactly 121 characters', () => {
        const text = 'z'.repeat(121);
        const result = commentPreviewFromRawText(text, '(empty)');
        expect(result).toHaveLength(120);
        expect(result).toBe(`${'z'.repeat(117)}...`);
    });
});
