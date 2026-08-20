CREATE OR REPLACE FUNCTION public.purge_landing_analytics_retention()
RETURNS TABLE (
    deleted_rows bigint,
    has_more boolean,
    page_views_deleted bigint,
    downloads_deleted bigint,
    dedupe_deleted bigint,
    visitor_quota_deleted bigint,
    global_quota_deleted bigint
)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_now timestamptz := clock_timestamp();
BEGIN
    DELETE FROM public.landing_page_view
    WHERE ctid IN (
        SELECT ctid
        FROM public.landing_page_view
        WHERE created_at < v_now - interval '90 days'
        ORDER BY created_at
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS page_views_deleted = ROW_COUNT;

    DELETE FROM public.landing_download
    WHERE ctid IN (
        SELECT ctid
        FROM public.landing_download
        WHERE created_at < v_now - interval '90 days'
        ORDER BY created_at
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS downloads_deleted = ROW_COUNT;

    DELETE FROM public.landing_analytics_dedupe
    WHERE ctid IN (
        SELECT ctid
        FROM public.landing_analytics_dedupe
        WHERE expires_at < v_now
        ORDER BY expires_at
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS dedupe_deleted = ROW_COUNT;

    DELETE FROM public.landing_analytics_visitor_quota
    WHERE ctid IN (
        SELECT ctid
        FROM public.landing_analytics_visitor_quota
        WHERE bucket_start < v_now - interval '1 day'
        ORDER BY bucket_start
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS visitor_quota_deleted = ROW_COUNT;

    DELETE FROM public.landing_analytics_global_quota
    WHERE ctid IN (
        SELECT ctid
        FROM public.landing_analytics_global_quota
        WHERE bucket_start < v_now - interval '1 day'
        ORDER BY bucket_start
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS global_quota_deleted = ROW_COUNT;

    deleted_rows := page_views_deleted
        + downloads_deleted
        + dedupe_deleted
        + visitor_quota_deleted
        + global_quota_deleted;
    has_more := EXISTS (
        SELECT 1 FROM public.landing_page_view
        WHERE created_at < v_now - interval '90 days'
    ) OR EXISTS (
        SELECT 1 FROM public.landing_download
        WHERE created_at < v_now - interval '90 days'
    ) OR EXISTS (
        SELECT 1 FROM public.landing_analytics_dedupe
        WHERE expires_at < v_now
    ) OR EXISTS (
        SELECT 1 FROM public.landing_analytics_visitor_quota
        WHERE bucket_start < v_now - interval '1 day'
    ) OR EXISTS (
        SELECT 1 FROM public.landing_analytics_global_quota
        WHERE bucket_start < v_now - interval '1 day'
    );
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_landing_analytics_daily_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_admitted integer;
    v_surface varchar;
    -- The microsecond offset keeps the daily row distinct from every
    -- whole-second rolling admission bucket in the same quota table.
    v_daily_bucket timestamptz := date_trunc('day', clock_timestamp()) - interval '1 microsecond';
BEGIN
    v_surface := CASE TG_TABLE_NAME
        WHEN 'landing_page_view' THEN 'page_view'
        WHEN 'landing_download' THEN 'download'
        ELSE NULL
    END;
    IF v_surface IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid analytics daily-cap surface';
    END IF;

    INSERT INTO public.landing_analytics_global_quota (surface, bucket_start, event_count)
    VALUES (v_surface, v_daily_bucket, 1)
    ON CONFLICT (surface, bucket_start) DO UPDATE
    SET event_count = public.landing_analytics_global_quota.event_count + 1
    WHERE public.landing_analytics_global_quota.event_count + 1 <= 20000
    RETURNING 1 INTO v_admitted;

    IF v_admitted IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EVB01', MESSAGE = 'daily analytics admission rejected';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_landing_page_view_daily_cap_on_insert
ON public.landing_page_view;
CREATE TRIGGER enforce_landing_page_view_daily_cap_on_insert
BEFORE INSERT ON public.landing_page_view
FOR EACH ROW
EXECUTE FUNCTION public.enforce_landing_analytics_daily_cap();

DROP TRIGGER IF EXISTS enforce_landing_download_daily_cap_on_insert
ON public.landing_download;
CREATE TRIGGER enforce_landing_download_daily_cap_on_insert
BEFORE INSERT ON public.landing_download
FOR EACH ROW
EXECUTE FUNCTION public.enforce_landing_analytics_daily_cap();

-- Seed both daily sentinels from rows admitted before the triggers existed.
-- The trigger DDL keeps both event tables locked against concurrent writes
-- until this migration commits.
WITH migration_clock AS (
    SELECT date_trunc('day', clock_timestamp()) AS day_start
), current_day AS (
    SELECT
        'page_view'::varchar AS surface,
        migration_clock.day_start,
        least(count(public.landing_page_view.id), 20000)::integer AS event_count
    FROM migration_clock
    LEFT JOIN public.landing_page_view
        ON public.landing_page_view.created_at >= migration_clock.day_start
        AND public.landing_page_view.created_at < migration_clock.day_start + interval '1 day'
    GROUP BY migration_clock.day_start
    UNION ALL
    SELECT
        'download'::varchar AS surface,
        migration_clock.day_start,
        least(count(public.landing_download.id), 20000)::integer AS event_count
    FROM migration_clock
    LEFT JOIN public.landing_download
        ON public.landing_download.created_at >= migration_clock.day_start
        AND public.landing_download.created_at < migration_clock.day_start + interval '1 day'
    GROUP BY migration_clock.day_start
)
INSERT INTO public.landing_analytics_global_quota (surface, bucket_start, event_count)
SELECT surface, day_start - interval '1 microsecond', event_count
FROM current_day
WHERE event_count > 0
ON CONFLICT (surface, bucket_start) DO UPDATE
SET event_count = greatest(
    public.landing_analytics_global_quota.event_count,
    EXCLUDED.event_count
);
