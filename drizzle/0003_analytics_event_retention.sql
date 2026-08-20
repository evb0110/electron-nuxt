CREATE OR REPLACE FUNCTION public.purge_viewer_analytics_retention()
RETURNS TABLE (
    deleted_rows bigint,
    has_more boolean,
    events_deleted bigint,
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
    DELETE FROM public.viewer_analytics_event
    WHERE ctid IN (
        SELECT ctid
        FROM public.viewer_analytics_event
        WHERE occurred_at < v_now - interval '90 days'
        ORDER BY occurred_at
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS events_deleted = ROW_COUNT;

    DELETE FROM public.viewer_analytics_dedupe
    WHERE ctid IN (
        SELECT ctid
        FROM public.viewer_analytics_dedupe
        WHERE expires_at < v_now
        ORDER BY expires_at
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS dedupe_deleted = ROW_COUNT;

    DELETE FROM public.viewer_analytics_visitor_quota
    WHERE ctid IN (
        SELECT ctid
        FROM public.viewer_analytics_visitor_quota
        WHERE bucket_start < v_now - interval '1 day'
        ORDER BY bucket_start
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS visitor_quota_deleted = ROW_COUNT;

    DELETE FROM public.viewer_analytics_global_quota
    WHERE ctid IN (
        SELECT ctid
        FROM public.viewer_analytics_global_quota
        WHERE bucket_start < v_now - interval '1 day'
        ORDER BY bucket_start
        LIMIT 5000
        FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS global_quota_deleted = ROW_COUNT;

    deleted_rows := events_deleted
        + dedupe_deleted
        + visitor_quota_deleted
        + global_quota_deleted;
    has_more := EXISTS (
        SELECT 1 FROM public.viewer_analytics_event
        WHERE occurred_at < v_now - interval '90 days'
    ) OR EXISTS (
        SELECT 1 FROM public.viewer_analytics_dedupe
        WHERE expires_at < v_now
    ) OR EXISTS (
        SELECT 1 FROM public.viewer_analytics_visitor_quota
        WHERE bucket_start < v_now - interval '1 day'
    ) OR EXISTS (
        SELECT 1 FROM public.viewer_analytics_global_quota
        WHERE bucket_start < v_now - interval '1 day'
    );
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_viewer_analytics_daily_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_admitted integer;
    -- The microsecond offset keeps the daily row distinct from every
    -- whole-second rolling admission bucket in the same quota table.
    v_daily_bucket timestamptz := date_trunc('day', clock_timestamp()) - interval '1 microsecond';
BEGIN
    INSERT INTO public.viewer_analytics_global_quota (bucket_start, event_count)
    VALUES (v_daily_bucket, 1)
    ON CONFLICT (bucket_start) DO UPDATE
    SET event_count = public.viewer_analytics_global_quota.event_count + 1
    WHERE public.viewer_analytics_global_quota.event_count + 1 <= 40000
    RETURNING 1 INTO v_admitted;

    IF v_admitted IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EVB01', MESSAGE = 'daily analytics admission rejected';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_viewer_analytics_daily_cap_on_insert
ON public.viewer_analytics_event;
CREATE TRIGGER enforce_viewer_analytics_daily_cap_on_insert
BEFORE INSERT ON public.viewer_analytics_event
FOR EACH ROW
EXECUTE FUNCTION public.enforce_viewer_analytics_daily_cap();

-- Preserve the cap on the migration day by accounting for rows that were
-- admitted before this trigger existed. CREATE TRIGGER holds the event-table
-- lock until this migration commits, so concurrent inserts cannot slip
-- between this count and trigger enforcement.
WITH migration_clock AS (
    SELECT date_trunc('day', clock_timestamp()) AS day_start
), current_day AS (
    SELECT
        migration_clock.day_start,
        least(count(public.viewer_analytics_event.id), 40000)::integer AS event_count
    FROM migration_clock
    LEFT JOIN public.viewer_analytics_event
        ON public.viewer_analytics_event.occurred_at >= migration_clock.day_start
        AND public.viewer_analytics_event.occurred_at < migration_clock.day_start + interval '1 day'
    GROUP BY migration_clock.day_start
)
INSERT INTO public.viewer_analytics_global_quota (bucket_start, event_count)
SELECT day_start - interval '1 microsecond', event_count
FROM current_day
WHERE event_count > 0
ON CONFLICT (bucket_start) DO UPDATE
SET event_count = greatest(
    public.viewer_analytics_global_quota.event_count,
    EXCLUDED.event_count
);
