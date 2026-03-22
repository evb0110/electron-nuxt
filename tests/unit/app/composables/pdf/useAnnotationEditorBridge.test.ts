import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { shouldIgnoreEditorEvent } from '@app/composables/pdf/annotations/annotationEditorEventGuards';

class FakeElement {
    tagName: string;
    isContentEditable = false;
    private readonly selectors = new Set<string>();

    constructor(tagName: string, selectors: string[] = []) {
        this.tagName = tagName.toUpperCase();
        selectors.forEach(selector => this.selectors.add(selector));
    }

    closest(selector: string) {
        return this.selectors.has(selector) ? this : null;
    }
}

describe('shouldIgnoreEditorEvent', () => {
    beforeEach(() => {
        vi.stubGlobal('HTMLElement', FakeElement);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('ignores note-window key events when the active element is a textarea', () => {
        const activeTextarea = new FakeElement('textarea', ['.note-window, .pdf-annotation-note-window']);
        vi.stubGlobal('document', {
            activeElement: activeTextarea,
            getSelection: () => null,
        });

        const event = new Event('keydown');
        Object.defineProperty(event, 'target', {
            configurable: true,
            value: new FakeElement('body'),
        });

        expect(shouldIgnoreEditorEvent(event)).toBe(true);
    });

    it('does not ignore non-editing key events outside text entry surfaces', () => {
        const activeButton = new FakeElement('button');
        vi.stubGlobal('document', {
            activeElement: activeButton,
            getSelection: () => null,
        });

        const event = new Event('keydown');
        Object.defineProperty(event, 'target', {
            configurable: true,
            value: activeButton,
        });

        expect(shouldIgnoreEditorEvent(event)).toBe(false);
    });
});
