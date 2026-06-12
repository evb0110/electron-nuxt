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

class FakeSpan {
    readonly childNodes: FakeTextNode[];

    constructor(text: string) {
        this.childNodes = [new FakeTextNode(text)];
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
