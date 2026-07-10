CREATE OR REPLACE FUNCTION public.admit_viewer_analytics_events(
    p_events jsonb,
    p_visitor_hash varchar,
    p_deployment_host varchar,
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
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_now timestamptz := clock_timestamp();
    v_bucket_start timestamptz;
    v_requested integer;
    v_admitted integer;
BEGIN
    IF jsonb_typeof(p_events) <> 'array' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'analytics events must be an array';
    END IF;
    v_requested := jsonb_array_length(p_events);
    IF v_requested < 1
        OR p_dedupe_seconds < 1
        OR p_visitor_limit < 1
        OR p_global_limit < 1
        OR p_bucket_seconds < 1
    THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid analytics admission policy';
    END IF;
    v_bucket_start := to_timestamp(
        floor(extract(epoch FROM v_now) / p_bucket_seconds) * p_bucket_seconds
    );

    v_admitted := NULL;
    INSERT INTO public.viewer_analytics_dedupe (dedupe_key, expires_at)
    VALUES (p_dedupe_key, v_now + make_interval(secs => p_dedupe_seconds))
    ON CONFLICT (dedupe_key) DO UPDATE
    SET expires_at = EXCLUDED.expires_at
    WHERE public.viewer_analytics_dedupe.expires_at <= v_now
    RETURNING 1 INTO v_admitted;
    IF v_admitted IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EVB01', MESSAGE = 'analytics admission rejected';
    END IF;

    v_admitted := NULL;
    INSERT INTO public.viewer_analytics_visitor_quota (
        visitor_hash,
        bucket_start,
        event_count
    )
    SELECT p_visitor_hash, v_bucket_start, v_requested
    WHERE v_requested <= p_visitor_limit
    ON CONFLICT (visitor_hash, bucket_start) DO UPDATE
    SET event_count = public.viewer_analytics_visitor_quota.event_count + EXCLUDED.event_count
    WHERE public.viewer_analytics_visitor_quota.event_count + EXCLUDED.event_count <= p_visitor_limit
    RETURNING 1 INTO v_admitted;
    IF v_admitted IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EVB01', MESSAGE = 'analytics admission rejected';
    END IF;

    v_admitted := NULL;
    INSERT INTO public.viewer_analytics_global_quota (bucket_start, event_count)
    SELECT v_bucket_start, v_requested
    WHERE v_requested <= p_global_limit
    ON CONFLICT (bucket_start) DO UPDATE
    SET event_count = public.viewer_analytics_global_quota.event_count + EXCLUDED.event_count
    WHERE public.viewer_analytics_global_quota.event_count + EXCLUDED.event_count <= p_global_limit
    RETURNING 1 INTO v_admitted;
    IF v_admitted IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'EVB01', MESSAGE = 'analytics admission rejected';
    END IF;

    INSERT INTO public.viewer_analytics_event (
        event_name,
        path,
        locale,
        screen_category,
        session_id,
        referrer,
        country,
        city,
        region,
        visitor_hash,
        deployment_host,
        user_agent,
        payload,
        client_occurred_at,
        occurred_at,
        created_at
    )
    SELECT
        entry ->> 'name',
        NULLIF(entry ->> 'path', ''),
        NULLIF(entry ->> 'locale', ''),
        NULLIF(entry ->> 'screenCategory', ''),
        NULLIF(entry ->> 'sessionId', ''),
        NULLIF(entry ->> 'referrer', ''),
        p_country,
        p_city,
        p_region,
        p_visitor_hash,
        p_deployment_host,
        p_user_agent,
        COALESCE(entry -> 'payload', '{}'::jsonb),
        NULLIF(entry ->> 'clientOccurredAt', '')::timestamptz,
        v_now,
        v_now
    FROM jsonb_array_elements(p_events) AS event_rows(entry);

    DELETE FROM public.viewer_analytics_dedupe
    WHERE dedupe_key IN (
        SELECT dedupe_key
        FROM public.viewer_analytics_dedupe
        WHERE expires_at < v_now - interval '1 minute'
        ORDER BY expires_at
        LIMIT 100
        FOR UPDATE SKIP LOCKED
    );
    DELETE FROM public.viewer_analytics_visitor_quota
    WHERE (visitor_hash, bucket_start) IN (
        SELECT visitor_hash, bucket_start
        FROM public.viewer_analytics_visitor_quota
        WHERE bucket_start < v_bucket_start - interval '1 day'
        ORDER BY bucket_start
        LIMIT 100
        FOR UPDATE SKIP LOCKED
    );
    DELETE FROM public.viewer_analytics_global_quota
    WHERE bucket_start IN (
        SELECT bucket_start
        FROM public.viewer_analytics_global_quota
        WHERE bucket_start < v_bucket_start - interval '1 day'
        ORDER BY bucket_start
        LIMIT 100
        FOR UPDATE SKIP LOCKED
    );

    RETURN v_requested;
END;
$$;
