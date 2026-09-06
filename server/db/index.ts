import { neon } from '@neondatabase/serverless';
import {
    drizzle,
    type NeonHttpDatabase,
} from 'drizzle-orm/neon-http';
import {
    firstNonEmptyStringPreservingWhitespace,
    getRuntimeEnv,
} from '@server/utils/getRuntimeEnv';
import * as schema from '@server/db/viewerAnalyticsEvent';

let dbInstance: NeonHttpDatabase<typeof schema> | null = null;

function resolveDatabaseUrl() {
    const env = getRuntimeEnv();

    return firstNonEmptyStringPreservingWhitespace([
        env.NUXT_ANALYTICS_DATABASE_URL,
        env.ANALYTICS_DATABASE_URL,
        env.DATABASE_URL,
    ]);
}

export function getAnalyticsDb(): NeonHttpDatabase<typeof schema> {
    const db = getOptionalAnalyticsDb();
    if (!db) {
        throw new Error('Analytics database URL is not configured');
    }

    return db;
}

export function getOptionalAnalyticsDb(): NeonHttpDatabase<typeof schema> | null {
    if (!dbInstance) {
        const url = resolveDatabaseUrl();
        if (!url) {
            return null;
        }

        dbInstance = drizzle(neon(url), { schema });
    }

    return dbInstance;
}
