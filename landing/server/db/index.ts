import { neon } from '@neondatabase/serverless';
import {
    drizzle,
    type NeonHttpDatabase,
} from 'drizzle-orm/neon-http';

let dbInstance: NeonHttpDatabase | null = null;
let dbInstanceUrl: string | null = null;

export function getDb(databaseUrl: string | undefined) {
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is not configured');
    }

    if (!dbInstance || dbInstanceUrl !== databaseUrl) {
        const sql = neon(databaseUrl);
        dbInstance = drizzle(sql);
        dbInstanceUrl = databaseUrl;
    }
    return dbInstance;
}

export function getOptionalDb(databaseUrl: string | undefined) {
    if (!databaseUrl) {
        return null;
    }

    return getDb(databaseUrl);
}
