import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('PdfEmptyState Recent eligibility contract', () => {
    it('keeps command readiness independent from picker progress and exact-frame readiness', async () => {
        const source = await readFile(
            join(process.cwd(), 'app/modules/pdf-viewer/components/PdfEmptyState.vue'),
            'utf8',
        );
        const disabledStart = source.indexOf('function isRecentRowDisabled');
        const disabledEnd = source.indexOf('\n}', disabledStart);
        const disabledSource = source.slice(disabledStart, disabledEnd);

        expect(source).toContain(':data-recent-open-ready="isRecentOpenReady(file) ? \'true\' : \'false\'"');
        expect(source).toContain(':data-recent-open-exact-frame-ready="isRecentOpenExactFrameReady(file) ? \'true\' : \'false\'"');
        expect(source).toContain(':data-recent-source="String(file.originalPath)"');
        expect(disabledSource).toContain('return !isRecentOpenReady(file)');
        expect(disabledSource).not.toContain('return openInProgress');
        expect(disabledSource).not.toContain('isRecentOpenExactFrameReady');
    });
});
