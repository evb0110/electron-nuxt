import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { buildRangeFromPageText } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPageText';

class FakeTextNode {
    readonly nodeType = 3;

    constructor(readonly textContent: string) {}
}

type TFakeChild = FakeTextNode | FakeElement;

class FakeElement {
    readonly nodeType = 1;
    parentElement: FakeElement | null = null;

    constructor(readonly childNodes: TFakeChild[]) {
        childNodes.forEach((child) => {
            if (child instanceof FakeElement) {
                child.parentElement = this;
            }
        });
    }

    closest(selector: string) {
        return selector === 'span' ? this : null;
    }
}

class FakeSpan extends FakeElement {

    constructor(...children: Array<string | FakeElement>) {
        super(children.map(child => typeof child === 'string' ? new FakeTextNode(child) : child));
    }
}

class FakePageContainer {
    constructor(readonly spans: FakeSpan[]) {}

    querySelectorAll(selector: string) {
        return selector === '.text-layer span, .textLayer span'
            ? this.spans
            : [];
    }
}

interface IFakeRange {
    setStart: ReturnType<typeof vi.fn>;
    setEnd: ReturnType<typeof vi.fn>;
}

const originalNode = Reflect.get(globalThis, 'Node');
const originalDocument = Reflect.get(globalThis, 'document');

function createFakeRange(): IFakeRange {
    return {
        setStart: vi.fn(),
        setEnd: vi.fn(),
    };
}

beforeEach(() => {
    Reflect.set(globalThis, 'Node', {TEXT_NODE: 3});
});

afterEach(() => {
    if (originalNode === undefined) {
        Reflect.deleteProperty(globalThis, 'Node');
    } else {
        Reflect.set(globalThis, 'Node', originalNode);
    }

    if (originalDocument === undefined) {
        Reflect.deleteProperty(globalThis, 'document');
    } else {
        Reflect.set(globalThis, 'document', originalDocument);
    }
});

describe('buildRangeFromPageText', () => {
    it('matches text across split text-layer spans', () => {
        const range = createFakeRange();
        Reflect.set(globalThis, 'document', {createRange: () => range});
        const page = new FakePageContainer([
            new FakeSpan('Broken'),
            new FakeSpan('plural patterns'),
        ]);

        const match = buildRangeFromPageText(page as never, {text: 'broken plural'});

        expect(match?.matchedText).toBe('Broken plural');
        expect(range.setStart).toHaveBeenCalledWith(page.spans[0]!.childNodes[0], 0);
        expect(range.setEnd).toHaveBeenCalledWith(page.spans[1]!.childNodes[0], 6);
    });

    it('uses a one-based occurrence when text repeats', () => {
        const range = createFakeRange();
        Reflect.set(globalThis, 'document', {createRange: () => range});
        const page = new FakePageContainer([new FakeSpan('plural plural')]);

        const match = buildRangeFromPageText(page as never, {
            text: 'plural',
            occurrence: 2,
        });

        expect(match?.occurrence).toBe(2);
        expect(match?.startOffset).toBe(7);
        expect(range.setStart).toHaveBeenCalledWith(page.spans[0]!.childNodes[0], 7);
        expect(range.setEnd).toHaveBeenCalledWith(page.spans[0]!.childNodes[0], 13);
    });

    it('maps a match across multiple text nodes in one span', () => {
        const range = createFakeRange();
        Reflect.set(globalThis, 'document', {createRange: () => range});
        const page = new FakePageContainer([new FakeSpan('split ', 'text')]);

        const match = buildRangeFromPageText(page as never, {text: 'split text'});

        expect(match?.matchedText).toBe('split text');
        expect(range.setStart).toHaveBeenCalledWith(page.spans[0]!.childNodes[0], 0);
        expect(range.setEnd).toHaveBeenCalledWith(page.spans[0]!.childNodes[1], 4);
    });

    it('does not duplicate text from nested text-layer spans', () => {
        const range = createFakeRange();
        Reflect.set(globalThis, 'document', {createRange: () => range});
        const nested = new FakeSpan('nested text');
        const outer = new FakeSpan(nested);
        const page = new FakePageContainer([
            outer,
            nested,
        ]);

        const match = buildRangeFromPageText(page as never, {text: 'nested text'});

        expect(match?.matchedText).toBe('nested text');
        expect(range.setStart).toHaveBeenCalledWith(nested.childNodes[0], 0);
        expect(range.setEnd).toHaveBeenCalledWith(nested.childNodes[0], 11);
    });

    it('does not add a word boundary between text nodes inside one span', () => {
        const range = createFakeRange();
        Reflect.set(globalThis, 'document', {createRange: () => range});
        const page = new FakePageContainer([new FakeSpan('joined', 'text')]);

        const match = buildRangeFromPageText(page as never, {text: 'joinedtext'});

        expect(match?.matchedText).toBe('joinedtext');
        expect(range.setStart).toHaveBeenCalledWith(page.spans[0]!.childNodes[0], 0);
        expect(range.setEnd).toHaveBeenCalledWith(page.spans[0]!.childNodes[1], 4);
    });

    it('honors whole-word matching', () => {
        const range = createFakeRange();
        Reflect.set(globalThis, 'document', {createRange: () => range});
        const page = new FakePageContainer([new FakeSpan('plurals plural')]);

        const match = buildRangeFromPageText(page as never, {
            text: 'plural',
            wholeWord: true,
        });

        expect(match?.startOffset).toBe(8);
        expect(range.setStart).toHaveBeenCalledWith(page.spans[0]!.childNodes[0], 8);
    });
});
