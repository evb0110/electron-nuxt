import type { Ref } from 'vue';
import type { TPdfSource } from '@app/types/pdfUi';
import type { IPdfViewerProps } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import type { TPdfDocumentSession } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { writeTrustedPdfOpenGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/pdfTrustedOpenGeometryCache';
import { commitPdfLoadedOpeningPageGeometry } from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfLoadedOpeningPageGeometry';

interface IUsePdfTrustedOpenGeometryLifecycleOptions {
    props: IPdfViewerProps;
    src: Readonly<Ref<TPdfSource | null>>;
    viewerCurrentPage: Ref<number>;
    chassisAuthority: IDocumentViewerChassisAuthority | null;
    pdfDocumentResult: TPdfDocumentSession;
}

export const usePdfTrustedOpenGeometryLifecycle = (
    options: IUsePdfTrustedOpenGeometryLifecycleOptions,
) => {
    const {
        props,
        src,
        viewerCurrentPage,
        chassisAuthority,
        pdfDocumentResult,
    } = options;
    const {
        numPages,
        pageMetrics,
        pageMetricsVersion,
    } = pdfDocumentResult;
    const trustedGeometryStat = shallowRef<{
        size: number;
        modifiedAt?: number;
    } | null>(null);

    watch(
        () => [
            props.originalPath,
            props.src,
        ] as const,
        ([
            documentId,
            sourceAtLookup,
        ]) => {
            trustedGeometryStat.value = null;
            if (!documentId || !chassisAuthority) {
                return;
            }

            const prevalidatedGeometry = chassisAuthority.openSurface.snapshot.value.openingPageGeometry;
            if (
                prevalidatedGeometry?.documentId === documentId
                && prevalidatedGeometry.pageNumber === viewerCurrentPage.value
            ) {
                if (
                    'size' in prevalidatedGeometry
                    && typeof prevalidatedGeometry.size === 'number'
                    && 'modifiedAt' in prevalidatedGeometry
                    && typeof prevalidatedGeometry.modifiedAt === 'number'
                ) {
                    trustedGeometryStat.value = {
                        size: prevalidatedGeometry.size,
                        modifiedAt: prevalidatedGeometry.modifiedAt,
                    };
                }
                pdfDocumentResult.seedTrustedPageGeometry({
                    pageNumber: prevalidatedGeometry.pageNumber,
                    pageCount: prevalidatedGeometry.pageCount,
                    width: prevalidatedGeometry.width,
                    height: prevalidatedGeometry.height,
                    rotation: prevalidatedGeometry.rotation,
                });
                // The main-process opening-geometry capability already
                // fingerprinted this exact original source. Do not issue a
                // second file:stat for the original path: renderer file I/O is
                // deliberately limited to its managed working copy, and a
                // close/reopen can retire that mapping while this watcher is
                // still awaiting IPC.
                if (trustedGeometryStat.value) {
                    return;
                }
            }

            if (
                sourceAtLookup
                && typeof sourceAtLookup === 'object'
                && 'kind' in sourceAtLookup
                && sourceAtLookup.kind === 'path'
            ) {
                // The adopted path source already carries its validated byte
                // length. It is safe for display and load decisions, but its
                // managed-copy mtime is not the original source revision, so
                // do not use it to validate a persistent original-path cache.
                trustedGeometryStat.value = {size: sourceAtLookup.size};
                return;
            }
            // An original path is identity/display metadata, not renderer file
            // authority. Without an authoritative prevalidated fingerprint or
            // an adopted path source, let PDF.js commit ephemeral geometry;
            // never validate the persistent cache by statting the original.
            return;
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );

    watch(
        [
            () => props.originalPath,
            viewerCurrentPage,
            numPages,
            pageMetricsVersion,
            trustedGeometryStat,
            pdfDocumentResult.acceptedSource,
            () => chassisAuthority?.openSurface.snapshot.value.generation ?? 0,
            () => chassisAuthority?.openSurface.snapshot.value.phase ?? 'idle',
            () => chassisAuthority?.openSurface.snapshot.value.identity?.documentId ?? null,
        ],
        ([
            documentId,
            pageNumber,
            pageCount,
        ]) => {
            const metric = pageMetrics.value[pageNumber - 1];
            if (!documentId || !metric || pageCount < 1) {
                return;
            }

            const snapshot = chassisAuthority?.openSurface.snapshot.value;
            if (chassisAuthority && snapshot?.identity) {
                commitPdfLoadedOpeningPageGeometry(chassisAuthority, {
                    expectedGeneration: snapshot.generation,
                    documentId: snapshot.identity.documentId,
                    metricSource: pdfDocumentResult.acceptedSource.value,
                    currentSource: src.value,
                    pageNumber,
                    currentPage: viewerCurrentPage.value,
                    pageCount,
                    metric,
                });
            }
            const stat = trustedGeometryStat.value;
            if (stat?.modifiedAt === undefined) {
                return;
            }
            writeTrustedPdfOpenGeometry({
                documentId,
                size: stat.size,
                modifiedAt: stat.modifiedAt,
                pageNumber,
                pageCount,
                width: metric.width,
                height: metric.height,
                rotation: metric.rotation ?? 0,
                savedAt: Date.now(),
            });
        },
        { flush: 'post' },
    );

};
