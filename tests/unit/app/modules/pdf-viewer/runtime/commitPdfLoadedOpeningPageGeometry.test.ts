import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { commitPdfLoadedOpeningPageGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfLoadedOpeningPageGeometry';
import type { IDocumentOpenSurfaceSnapshot } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { cast } from '@tests/helpers/cast';

function createHarness() {
    const source = {
        kind: 'path',
        path: '/tmp/scan.pdf',
        size: 28_000_000,
    } as const;
    const snapshot = ref<IDocumentOpenSurfaceSnapshot>({
        generation: 4,
        identity: {
            documentId: '/tmp/scan.pdf',
            documentRevision: 'open:4',
        },
        phase: 'pending',
        presentation: 'idle',
        geometry: null,
        openingPageGeometry: null,
        openingPageFrame: null,
        committedRender: null,
        committedViewport: null,
        failure: null,
    });
    const commitOpeningPageGeometry = vi.fn(() => true);
    const authority = cast<IDocumentViewerChassisAuthority>({openSurface: {
        snapshot,
        commitOpeningPageGeometry,
    }});
    const input = {
        expectedGeneration: 4,
        documentId: '/tmp/scan.pdf',
        metricSource: source,
        currentSource: source,
        pageNumber: 1,
        currentPage: 1,
        pageCount: 431,
        metric: {
            width: 860,
            height: 1112.94,
            rotation: 0,
        },
    };
    return {
        authority,
        commitOpeningPageGeometry,
        input,
        snapshot,
        source,
    };
}

describe('commitPdfLoadedOpeningPageGeometry', () => {
    it('commits authoritative loaded PDF geometry to the current empty-surface generation', () => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, harness.input)).toBe(true);
        expect(harness.commitOpeningPageGeometry).toHaveBeenCalledExactlyOnceWith(4, {
            documentId: '/tmp/scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 860,
            height: 1112.94,
            rotation: 0,
        });
    });

    it('accepts an equivalent reconstructed path descriptor', () => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            currentSource: {...harness.source},
        })).toBe(true);
        expect(harness.commitOpeningPageGeometry).toHaveBeenCalledOnce();
    });

    it('commits under the session identity when the accepted native source uses an alias path', () => {
        const harness = createHarness();
        harness.snapshot.value = {
            ...harness.snapshot.value,
            identity: {
                documentId: '/var/tmp/scan.pdf',
                documentRevision: 'open:4',
            },
        };
        const aliasedSource = {
            kind: 'path',
            path: '/private/var/tmp/scan.pdf',
            size: 28_000_000,
        } as const;

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            documentId: '/var/tmp/scan.pdf',
            metricSource: aliasedSource,
            currentSource: {...aliasedSource},
        })).toBe(true);
        expect(harness.commitOpeningPageGeometry).toHaveBeenCalledWith(4, expect.objectContaining({documentId: '/var/tmp/scan.pdf'}));
    });

    it('rejects a path descriptor whose size revision changed', () => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            currentSource: {
                ...harness.source,
                size: harness.source.size + 1,
            },
        })).toBe(false);
        expect(harness.commitOpeningPageGeometry).not.toHaveBeenCalled();
    });

    it.each([
        [
            'wrong document',
            {documentId: '/tmp/replacement.pdf'},
        ],
        [
            'wrong generation',
            {expectedGeneration: 5},
        ],
        [
            'wrong page',
            {currentPage: 2},
        ],
        [
            'missing metric',
            {metric: undefined},
        ],
    ])('rejects %s evidence', (_label, override) => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            ...override,
        })).toBe(false);
        expect(harness.commitOpeningPageGeometry).not.toHaveBeenCalled();
    });

    it('rejects metrics captured for a stale source', () => {
        const harness = createHarness();

        expect(commitPdfLoadedOpeningPageGeometry(harness.authority, {
            ...harness.input,
            metricSource: {
                kind: 'path',
                path: '/tmp/older-copy.pdf',
                size: 28_000_000,
            },
        })).toBe(false);
        expect(harness.commitOpeningPageGeometry).not.toHaveBeenCalled();
    });
});
