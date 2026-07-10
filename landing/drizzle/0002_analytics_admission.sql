CREATE OR REPLACE FUNCTION public.admit_landing_analytics_event(
    p_surface varchar,
    p_event jsonb,
    p_visitor_hash varchar,
    p_user_agent text,
    p_country varchar,
    p_city varchar,
    p_region varchar,
    p_dedupe_key varchar,
    p_dedupe_seconds integer,
    p_visitor_limit integer,
    p_global_limit integer,
    p_bucket_seconds integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_now timestamptz := clock_timestamp();
    v_bucket_start timestamptz;
    v_admitted integer;
BEGIN
    IF p_surface NOT IN ('download', 'page_view')
        OR jsonb_typeof(p_event) <> 'object'
        OR p_dedupe_seconds < 1
        OR p_visitor_limit < 1
        OR p_global_limit < 1
        OR p_bucket_seconds < 1
    THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid landing analytics admission input';
    END IF;
    v_bucket_start := to_timestamp(
        floor(extract(epoch FROM v_now) / p_bucket_seconds) * p_bucket_seconds
    );

    v_admitted := NULL;
    INSERT INTO public.landing_analytics_dedupe (surface, dedupe_key, expires_at)
    VALUES (p_surface, p_dedupe_key, v_now + make_interval(secs => p_dedupe_seconds))
    ON CONFLICT (surface, dedupe_key) DO UPDATE
    SET expires_at = EXCLUDED.expires_at
    WHERE public.landing_analytics_dedupe.expires_at <= v_now
    RETURNING 1 INTO v_admitted;
    IF v_admitted IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EVB01', MESSAGE = 'analytics admission rejected';
    END IF;

    v_admitted := NULL;
    INSERT INTO public.landing_analytics_visitor_quota (
        surface,
        visitor_hash,
        bucket_start,
        event_count
    )
    SELECT p_surface, p_visitor_hash, v_bucket_start, 1
    WHERE 1 <= p_visitor_limit
    ON CONFLICT (surface, visitor_hash, bucket_start) DO UPDATE
    SET event_count = public.landing_analytics_visitor_quota.event_count + EXCLUDED.event_count
    WHERE public.landing_analytics_visitor_quota.event_count + EXCLUDED.event_count <= p_visitor_limit
    RETURNING 1 INTO v_admitted;
    IF v_admitted IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EVB01', MESSAGE = 'analytics admission rejected';
    END IF;

    v_admitted := NULL;
    INSERT INTO public.landing_analytics_global_quota (surface, bucket_start, event_count)
    SELECT p_surface, v_bucket_start, 1
    WHERE 1 <= p_global_limit
    ON CONFLICT (surface, bucket_start) DO UPDATE
    SET event_count = public.landing_analytics_global_quota.event_count + EXCLUDED.event_count
    WHERE public.landing_analytics_global_quota.event_count + EXCLUDED.event_count <= p_global_limit
    RETURNING 1 INTO v_admitted;
    IF v_admitted IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EVB01', MESSAGE = 'analytics admission rejected';
    END IF;

    IF p_surface = 'page_view' THEN
        INSERT INTO public.landing_page_view (
            path,
            referrer,
            country,
            city,
            region,
            visitor_hash,
            user_agent,
            created_at
        ) VALUES (
            p_event ->> 'path',
            NULLIF(p_event ->> 'referrer', ''),
            p_country,
            p_city,
            p_region,
            p_visitor_hash,
            p_user_agent,
            v_now
        );
    ELSE
        INSERT INTO public.landing_download (
            platform,
            arch,
            version,
            file_name,
            country,
            city,
            region,
            visitor_hash,
            user_agent,
            created_at
        ) VALUES (
            p_event ->> 'platform',
            p_event ->> 'arch',
            p_event ->> 'version',
            p_event ->> 'fileName',
            p_country,
            p_city,
            p_region,
            p_visitor_hash,
            p_user_agent,
            v_now
        );
    END IF;

    DELETE FROM public.landing_analytics_dedupe
    WHERE (surface, dedupe_key) IN (
        SELECT surface, dedupe_key
        FROM public.landing_analytics_dedupe
        WHERE expires_at < v_now - interval '1 minute'
        ORDER BY expires_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
    );
    DELETE FROM public.landing_analytics_visitor_quota
    WHERE (surface, visitor_hash, bucket_start) IN (
        SELECT surface, visitor_hash, bucket_start
        FROM public.landing_analytics_visitor_quota
        WHERE bucket_start < v_bucket_start - interval '1 day'
        ORDER BY bucket_start
        LIMIT 100
        FOR UPDATE SKIP LOCKED
    );
    DELETE FROM public.landing_analytics_global_quota
    WHERE (surface, bucket_start) IN (
        SELECT surface, bucket_start
        FROM public.landing_analytics_global_quota
        WHERE bucket_start < v_bucket_start - interval '1 day'
        ORDER BY bucket_start
        LIMIT 100
        FOR UPDATE SKIP LOCKED
    );
END;
$$;
