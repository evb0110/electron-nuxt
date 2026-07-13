import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { commitPdfPageSkeletonGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfInitialPageSkeletonGeometry';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { IDocumentOpenSurfaceSnapshot } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { cast } from '@tests/helpers/cast';

describe('commitPdfPageSkeletonGeometry', () => {
    it('keeps the previous surface until the expected virtual extent is mounted', () => {
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
        const commitGeometry = vi.fn(() => true);
        const pageSkeleton = cast<HTMLElement>({ isConnected: true });
        const pageContainer = cast<HTMLElement>({
            isConnected: true,
            querySelector: vi.fn(() => pageSkeleton),
            getBoundingClientRect: vi.fn(() => ({
                width: 760,
                height: 1224,
            })),
        });
        const viewerContainer = cast<HTMLElement>({
            scrollHeight: 1245,
            querySelector: vi.fn(() => pageContainer),
        });
        const chassisAuthority = cast<IDocumentViewerChassisAuthority>({ openSurface: {
            snapshot,
            commitGeometry,
        } });
        vi.stubGlobal('window', { getComputedStyle: vi.fn(() => ({
            display: 'block',
            visibility: 'visible',
        })) });

        const unresolvedOptions = {
            expectedGeneration: 4,
            minimumScrollHeight: null,
        };
        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            1,
            unresolvedOptions,
        )).toBe(false);
        expect(commitGeometry).not.toHaveBeenCalled();

        const options = {
            expectedGeneration: 4,
            minimumScrollHeight: 534900,
        };
        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            1,
            options,
        )).toBe(false);
        expect(commitGeometry).not.toHaveBeenCalled();

        Object.defineProperty(viewerContainer, 'scrollHeight', { value: 536245 });
        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            1,
            options,
        )).toBe(true);
        expect(commitGeometry).toHaveBeenCalledExactlyOnceWith(4, {
            width: 760,
            height: 1224,
            margin: 20,
        });
    });

    it('recovers geometry for the surface-authoritative page after its skeleton is removed', () => {
        const snapshot = ref<IDocumentOpenSurfaceSnapshot>({
            generation: 7,
            identity: {
                documentId: '/tmp/large-scan.pdf',
                documentRevision: 'open:7',
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
        const commitGeometry = vi.fn(() => true);
        const canvas = cast<HTMLCanvasElement>({
            isConnected: true,
            width: 1390,
            height: 1798,
            getBoundingClientRect: vi.fn(() => ({
                width: 860,
                height: 1112.94,
            })),
        });
        const pageContainer = cast<HTMLElement>({
            isConnected: true,
            querySelector: vi.fn((selector: string) => selector === '.page_canvas canvas' ? canvas : null),
            getBoundingClientRect: vi.fn(() => ({
                width: 860,
                height: 1112.94,
            })),
        });
        const viewerContainer = cast<HTMLElement>({
            scrollHeight: 478942,
            querySelector: vi.fn(() => pageContainer),
        });
        const chassisAuthority = cast<IDocumentViewerChassisAuthority>({ openSurface: {
            snapshot,
            commitGeometry,
        } });

        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            // The local page projection may still lag an early navigation.
            ref(1),
            ref(20),
            6,
            {
                authoritativePageNumber: 6,
                expectedGeneration: 7,
                minimumScrollHeight: null,
                requireVisibleSkeleton: false,
            },
        )).toBe(true);
        expect(commitGeometry).toHaveBeenCalledExactlyOnceWith(7, {
            width: 860,
            height: 1112.94,
            margin: 20,
        });
    });

    it('rejects canvas recovery for a stale open-surface generation', () => {
        const snapshot = ref<IDocumentOpenSurfaceSnapshot>({
            generation: 9,
            identity: {
                documentId: '/tmp/replacement.pdf',
                documentRevision: 'open:9',
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
        const commitGeometry = vi.fn(() => true);
        const canvas = cast<HTMLCanvasElement>({
            isConnected: true,
            width: 1390,
            height: 1798,
            getBoundingClientRect: vi.fn(() => ({
                width: 860,
                height: 1112.94,
            })),
        });
        const pageContainer = cast<HTMLElement>({
            isConnected: true,
            querySelector: vi.fn((selector: string) => selector === '.page_canvas canvas' ? canvas : null),
            getBoundingClientRect: vi.fn(() => ({
                width: 860,
                height: 1112.94,
            })),
        });
        const viewerContainer = cast<HTMLElement>({
            scrollHeight: 478942,
            querySelector: vi.fn(() => pageContainer),
        });
        const chassisAuthority = cast<IDocumentViewerChassisAuthority>({ openSurface: {
            snapshot,
            commitGeometry,
        } });

        expect(commitPdfPageSkeletonGeometry(
            chassisAuthority,
            ref(viewerContainer),
            ref(1),
            ref(20),
            1,
            {
                expectedGeneration: 8,
                minimumScrollHeight: 478000,
                requireVisibleSkeleton: false,
            },
        )).toBe(false);
        expect(commitGeometry).not.toHaveBeenCalled();
    });
});
