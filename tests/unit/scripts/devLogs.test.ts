import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    filterDevLogText,
    parseDevLogsArgs,
} from '@scripts/devLogs';

describe('devLogs', () => {
    it('parses session, follow, tail, and relative since options', () => {
        expect(parseDevLogsArgs([
            '--session=pdf-test',
            '--follow',
            '--tail=40',
            '--since=15m',
        ], Date.parse('2026-08-10T18:00:00.000Z'))).toEqual({
            follow: true,
            sessionName: 'pdf-test',
            sinceMs: Date.parse('2026-08-10T17:45:00.000Z'),
            tailLines: 40,
        });
    });

    it('filters timestamped records before applying the tail limit', () => {
        const text = [
            '[2026-08-10T17:40:00.000Z nuxt stdout] old',
            '[2026-08-10T17:50:00.000Z electron stderr] first',
            'continued detail',
            '[2026-08-10T17:51:00.000Z renderer stderr] second',
        ].join('\n');

        expect(filterDevLogText(text, {
            sinceMs: Date.parse('2026-08-10T17:45:00.000Z'),
            tailLines: 3,
        })).toBe([
            '[2026-08-10T17:50:00.000Z electron stderr] first',
            'continued detail',
            '[2026-08-10T17:51:00.000Z renderer stderr] second',
        ].join('\n'));
    });
});
