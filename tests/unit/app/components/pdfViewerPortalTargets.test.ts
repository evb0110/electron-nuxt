import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolvePageTargets } from '@app/components/pdf/pdfViewerPortalTargets';

function toElement<T extends object>(value: T) {
    return value as HTMLElement;
}

describe('resolvePageTargets', () => {
    it('resolves only mounted page targets', () => {
        const pageOne = toElement({ id: 'page-1' });
        const pageThree = toElement({ id: 'page-3' });
        const targetsBySelector = new Map<string, HTMLElement>([
            [
                '.page_container[data-page="1"]',
                pageOne,
            ],
            [
                '.page_container[data-page="3"]',
                pageThree,
            ],
        ]);
        const viewerContainer = toElement({ querySelector: (selector: string) => targetsBySelector.get(selector) ?? null });

        const targets = resolvePageTargets(viewerContainer, [
            1,
            2,
            3,
        ]);

        expect(targets.get(1)).toBe(pageOne);
        expect(targets.has(2)).toBe(false);
        expect(targets.get(3)).toBe(pageThree);
    });

    it('returns an empty map when the viewer container is missing', () => {
        expect(resolvePageTargets(null, [
            1,
            2,
        ])).toEqual(new Map());
    });
});
