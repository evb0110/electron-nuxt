import type { H3Event } from 'h3';
import { neon } from '@neondatabase/serverless';
import {
    drizzle,
    type NeonHttpDatabase,
} from 'drizzle-orm/neon-http';
import { getRuntimeEnv } from '@server/utils/runtimeEnv';
import * as schema from '@server/db/schema';

let dbInstance: NeonHttpDatabase<typeof schema> | null = null;

function resolveDatabaseUrl(event?: H3Event) {
    void event;
    const env = getRuntimeEnv();

    return env.NUXT_ANALYTICS_DATABASE_URL
        || env.ANALYTICS_DATABASE_URL
        || env.DATABASE_URL
        || '';
}

export function getAnalyticsDb(event?: H3Event): NeonHttpDatabase<typeof schema> {
    if (!dbInstance) {
        const url = resolveDatabaseUrl(event);
        if (!url) {
            throw new Error('Analytics database URL is not configured');
        }

        dbInstance = drizzle(neon(url), { schema });
    }

    return dbInstance;
}
