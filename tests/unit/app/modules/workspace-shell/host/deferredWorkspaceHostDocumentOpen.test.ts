import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    canBeginDocumentOpenSynchronously,
    resolveDocumentOpenRunResult,
    resolveOpenSurfaceDocumentId,
    resolvePreparedPdfOpeningGeometry,
    shouldWaitForPreparedOpeningOwner,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen';

describe('deferredWorkspaceHostDocumentOpen', () => {
    it('commits document opens only after a terminal state is reached', () => {
        expect(resolveDocumentOpenRunResult('opened', true)).toBe('opened');
        expect(resolveDocumentOpenRunResult('opened', false)).toBe(false);
        expect(resolveDocumentOpenRunResult(false, true)).toBe(false);
    });

    it('uses the geometry/viewer original path instead of a differing transaction ref', () => {
        expect(resolveOpenSurfaceDocumentId(
            {originalPath: '/documents/original.pdf'},
            '/managed/working-copy.pdf',
            'tab-1',
        )).toBe('/documents/original.pdf');
        expect(resolveOpenSurfaceDocumentId(null, '/managed/working-copy.pdf', 'tab-1'))
            .toBe('/managed/working-copy.pdf');
        expect(resolveOpenSurfaceDocumentId(null, null, 'tab-1')).toBe('tab-1');
    });

    it('binds authoritative main-process PDF geometry to the host document identity', () => {
        const geometry = resolvePreparedPdfOpeningGeometry('/documents/scan.pdf', {
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
            size: 538_000_000,
            modifiedAt: 1_720_000_000_000,
        });

        expect(geometry).toEqual({
            documentId: '/documents/scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
            size: 538_000_000,
            modifiedAt: 1_720_000_000_000,
        });
        expect(Object.isFrozen(geometry)).toBe(true);
        expect(resolvePreparedPdfOpeningGeometry('', geometry)).toBeNull();
        expect(resolvePreparedPdfOpeningGeometry('/documents/scan.pdf', null)).toBeNull();
    });

    it('waits only when a prepared frame still lacks its canonical viewer owner', () => {
        expect(shouldWaitForPreparedOpeningOwner(true, false)).toBe(true);
        expect(shouldWaitForPreparedOpeningOwner(true, true)).toBe(false);
        expect(shouldWaitForPreparedOpeningOwner(false, false)).toBe(false);
        expect(shouldWaitForPreparedOpeningOwner(false, true)).toBe(false);
    });

    it('permits synchronous ownership only for an exact premounted Recent frame', () => {
        expect(canBeginDocumentOpenSynchronously('openRecentFromPlaceholder', true, true)).toBe(true);
        expect(canBeginDocumentOpenSynchronously('openRecentFromPlaceholder', false, true)).toBe(false);
        expect(canBeginDocumentOpenSynchronously('openRecentFromPlaceholder', true, false)).toBe(false);
        expect(canBeginDocumentOpenSynchronously('handleOpenFileWithResultFromUi', true, true)).toBe(false);
        expect(canBeginDocumentOpenSynchronously('restoreColdDocument', true, true)).toBe(false);
    });

    it('starts a ready Recent transaction without yielding the click call stack', () => {
        const hostSource = readFileSync(join(
            process.cwd(),
            'app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue',
        ), 'utf8');
        const runStart = hostSource.indexOf('async function runWithDocumentOpenInFlight');
        const runEnd = hostSource.indexOf('\nasync function enqueueDocumentOpen', runStart);
        const runSource = hostSource.slice(runStart, runEnd);

        expect(runSource).toContain('canBeginDocumentOpenSynchronously(');
        expect(runSource).toContain('&& !await ensurePreparedOpeningOwnerReady(');
        expect(runSource.indexOf('canBeginDocumentOpenSynchronously(')).toBeLessThan(
            runSource.indexOf('const transaction = beginDocumentOpenTransaction(intent);'),
        );
    });
});
