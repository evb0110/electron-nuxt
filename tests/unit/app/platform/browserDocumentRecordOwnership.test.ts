import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const read = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

/**
 * The record store and the mutation half share one object through inheritance,
 * so the only thing keeping their state slices apart is the record store's
 * surface. These assertions pin that surface: containers stay private and the
 * mutation half reaches them exclusively through owner-run operations.
 */
describe('browser document record ownership', () => {
    it('keeps every record-store container private to its owner', () => {
        const recordStore = read('app/platform/browser/browserDocumentRecordStore.ts');

        for (const container of [
            'entries',
            'mutationQueue',
            'revisionListeners',
            'recentFilesStore',
        ]) {
            expect(recordStore).toContain(`private readonly ${container}`);
        }
        expect(recordStore).not.toMatch(/^\s*protected\s+(readonly\s+)?\w+\s*[:=]/mu);
    });

    it('grants the mutation half operations instead of the record map', () => {
        const mutationHalf = read('app/platform/browser/browserDocumentRepository.ts');

        expect(mutationHalf).not.toContain('.entries');
        expect(mutationHalf).toContain('this.attachEntry(');
        expect(mutationHalf).toContain('this.dropLoadedEntry(');
        expect(mutationHalf).toContain('this.hasLoadedEntry(');
    });
});
