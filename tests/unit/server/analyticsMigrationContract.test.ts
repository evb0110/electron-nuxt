import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const rootMigration = readFileSync(
    resolve(process.cwd(), 'drizzle/0002_analytics_admission.sql'),
    'utf8',
);
const landingMigration = readFileSync(
    resolve(process.cwd(), 'landing/drizzle/0002_analytics_admission.sql'),
    'utf8',
);
const landingSchemaMigration = readFileSync(
    resolve(process.cwd(), 'landing/drizzle/0001_sparkling_gauntlet.sql'),
    'utf8',
);

function expectOrdered(source: string, fragments: string[]) {
    let previousIndex = -1;
    for (const fragment of fragments) {
        const nextIndex = source.indexOf(fragment);
        expect(nextIndex, fragment).toBeGreaterThan(previousIndex);
        previousIndex = nextIndex;
    }
}

describe('analytics SQL admission migrations', () => {
    it.each([
        [
            'root',
            rootMigration,
        ],
        [
            'landing',
            landingMigration,
        ],
    ])('%s uses rollback rejection without privileged or caught execution', (_name, migration) => {
        expect(migration).toContain('ERRCODE = \'EVB01\'');
        expect(migration).toContain('SET search_path = pg_catalog, public');
        expect(migration).not.toMatch(/SECURITY\s+DEFINER/iu);
        expect(migration).not.toMatch(/EXCEPTION\s+WHEN/iu);
    });

    it('locks root admission in dedupe, visitor, global, event order', () => {
        expectOrdered(rootMigration, [
            'INSERT INTO public.viewer_analytics_dedupe',
            'INSERT INTO public.viewer_analytics_visitor_quota',
            'INSERT INTO public.viewer_analytics_global_quota',
            'INSERT INTO public.viewer_analytics_event',
        ]);
        expect(rootMigration).toContain('WHERE v_requested <= p_visitor_limit');
        expect(rootMigration).toContain('WHERE v_requested <= p_global_limit');
        expect(rootMigration).toContain('client_occurred_at');
        expect(rootMigration).toMatch(/client_occurred_at,[\s\S]+occurred_at,[\s\S]+v_now,[\s\S]+v_now/iu);
    });

    it('locks landing admission in dedupe, visitor, global, event order', () => {
        expectOrdered(landingMigration, [
            'INSERT INTO public.landing_analytics_dedupe',
            'INSERT INTO public.landing_analytics_visitor_quota',
            'INSERT INTO public.landing_analytics_global_quota',
            'IF p_surface = \'page_view\' THEN',
        ]);
        expect(landingMigration).toContain('WHERE 1 <= p_visitor_limit');
        expect(landingMigration).toContain('WHERE 1 <= p_global_limit');
        expect(landingMigration).toContain('v_now');
    });

    it('preserves historical UTC timestamps during landing timestamptz conversion', () => {
        expect(landingSchemaMigration).toContain(
            'ALTER TABLE "landing_download" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE \'UTC\'',
        );
        expect(landingSchemaMigration).toContain(
            'ALTER TABLE "landing_page_view" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE \'UTC\'',
        );
    });

    it('keeps generated migration journals and custom snapshots aligned', () => {
        for (const directory of [
            'drizzle',
            'landing/drizzle',
        ]) {
            const journal = JSON.parse(readFileSync(
                resolve(process.cwd(), directory, 'meta/_journal.json'),
                'utf8',
            )) as {entries: Array<{
                idx: number;
                tag: string
            }>};
            expect(journal.entries.at(-1)).toEqual(expect.objectContaining({
                idx: 2,
                tag: '0002_analytics_admission',
            }));
            expect(() => readFileSync(
                resolve(process.cwd(), directory, 'meta/0002_snapshot.json'),
                'utf8',
            )).not.toThrow();
        }
    });
});
