import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildPdfCommittedOpenVirtualSpacerStyle,
    resolvePdfCommittedOpenVirtualExtentMinimumScrollHeight,
} from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/buildPdfCommittedOpenVirtualSpacerStyle';
import type { IDocumentOpenSurfaceSnapshot } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

function createSnapshot(): IDocumentOpenSurfaceSnapshot {
    return {
        generation: 3,
        identity: {
            documentId: '/tmp/scan.pdf',
            documentRevision: 'open:3',
        },
        phase: 'geometry-committed',
        presentation: 'page-shell',
        geometry: {
            width: 760,
            height: 1224,
            margin: 20,
        },
        openingPageGeometry: {
            documentId: '/tmp/scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 364.2,
            height: 586.8,
            rotation: 0,
        },
        openingPageFrame: {
            generation: 3,
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '760px',
                height: '1224px',
            },
        },
        committedRender: null,
        committedViewport: null,
        failure: null,
    };
}

describe('buildPdfCommittedOpenVirtualSpacerStyle', () => {
    it('reserves the trusted full-document extent with the opening page frame', () => {
        expect(buildPdfCommittedOpenVirtualSpacerStyle({
            snapshot: createSnapshot(),
            continuousScroll: true,
            viewMode: 'single',
            gap: 20,
            lastMountedPage: 7,
        })).toEqual({
            height: '527436px',
            minHeight: '527436px',
            flexBasis: '527436px',
        });
    });

    it('does not reserve an extent after the opening generation is ready', () => {
        expect(buildPdfCommittedOpenVirtualSpacerStyle({
            snapshot: {
                ...createSnapshot(),
                phase: 'ready',
            },
            continuousScroll: true,
            viewMode: 'single',
            gap: 20,
            lastMountedPage: 7,
        })).toBeNull();
    });

    it('derives the presentation gate from the immutable opening snapshot', () => {
        expect(resolvePdfCommittedOpenVirtualExtentMinimumScrollHeight({
            snapshot: createSnapshot(),
            continuousScroll: true,
            viewMode: 'single',
            gap: 20,
        })).toBe(534900);

        expect(resolvePdfCommittedOpenVirtualExtentMinimumScrollHeight({
            snapshot: {
                ...createSnapshot(),
                openingPageFrame: {
                    ...createSnapshot().openingPageFrame!,
                    style: {},
                },
            },
            continuousScroll: true,
            viewMode: 'single',
            gap: 20,
        })).toBeNull();
    });

    it('rejects a framed multi-page handoff until late trusted geometry joins', () => {
        const pendingSnapshot: IDocumentOpenSurfaceSnapshot = {
            ...createSnapshot(),
            phase: 'pending',
            presentation: 'idle',
            geometry: null,
            openingPageGeometry: null,
        };
        expect(resolvePdfCommittedOpenVirtualExtentMinimumScrollHeight({
            snapshot: pendingSnapshot,
            continuousScroll: true,
            viewMode: 'single',
            gap: 20,
        })).toBeNull();

        expect(resolvePdfCommittedOpenVirtualExtentMinimumScrollHeight({
            snapshot: {
                ...pendingSnapshot,
                openingPageGeometry: createSnapshot().openingPageGeometry,
            },
            continuousScroll: true,
            viewMode: 'single',
            gap: 20,
        })).toBe(534900);
    });
});
