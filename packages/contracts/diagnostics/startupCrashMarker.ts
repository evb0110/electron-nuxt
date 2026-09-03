/* eslint-disable @typescript-eslint/naming-convention */

import {
    decodeCanonicalAppFrame,
    MAX_CANONICAL_APP_FRAMES,
    type CanonicalAppFrame,
} from '@contracts/diagnostics/canonicalAppFrames';
import {
    isDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import {
    isDesktopDiagnosticDist,
    type DesktopDiagnosticDist,
} from '@contracts/diagnostics/desktopDiagnosticDists.js';

export {DESKTOP_DIAGNOSTIC_DIST_IDENTITIES} from '@contracts/diagnostics/desktopDiagnosticDists.js';
export type {DesktopDiagnosticDist} from '@contracts/diagnostics/desktopDiagnosticDists.js';

export const STARTUP_CRASH_MARKER_SCHEMA_VERSION = 1;
export const STARTUP_CRASH_MARKER_MAX_RELEASE_LENGTH = 256;
export const STARTUP_CRASH_MARKER_MAX_DIST_LENGTH = 64;
export const STARTUP_CRASH_MARKER_MAX_FRAMES = MAX_CANONICAL_APP_FRAMES;

export interface StartupCrashMarkerRecord {
    schemaVersion: typeof STARTUP_CRASH_MARKER_SCHEMA_VERSION;
    eventId: DiagnosticEventId;
    code: 'MAIN_STARTUP_CRASH';
    frames: readonly CanonicalAppFrame[];
    timestamp: number;
    release: string;
    dist: DesktopDiagnosticDist;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function hasOnlyArrayIndices(value: readonly unknown[]) {
    try {
        return Reflect.ownKeys(value).every(key => (
            key === 'length'
            || typeof key === 'string'
            && /^(?:0|[1-9][0-9]*)$/u.test(key)
            && Number(key) < value.length
        ));
    } catch {
        return false;
    }
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]) {
    const allowed = new Set(allowedKeys);
    try {
        return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key));
    } catch {
        return false;
    }
}

function hasRequiredKeys(value: Record<string, unknown>, requiredKeys: readonly string[]) {
    return requiredKeys.every(key => Object.hasOwn(value, key));
}

function isSafeRelease(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= STARTUP_CRASH_MARKER_MAX_RELEASE_LENGTH
        && /^evb-viewer-desktop@[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/u.test(value);
}

function isSafeDist(value: unknown): value is DesktopDiagnosticDist {
    return typeof value === 'string'
        && value.length <= STARTUP_CRASH_MARKER_MAX_DIST_LENGTH
        && isDesktopDiagnosticDist(value);
}

function isSafeTimestamp(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

export function decodeStartupCrashMarkerRecord(
    value: unknown,
): StartupCrashMarkerRecord | null {
    if (
        !isPlainRecord(value)
        || !hasRequiredKeys(value, [
            'schemaVersion',
            'eventId',
            'code',
            'frames',
            'timestamp',
            'release',
            'dist',
        ])
        || !hasOnlyKeys(value, [
            'schemaVersion',
            'eventId',
            'code',
            'frames',
            'timestamp',
            'release',
            'dist',
        ])
    ) {
        return null;
    }

    try {
        if (
            value.schemaVersion !== STARTUP_CRASH_MARKER_SCHEMA_VERSION
            || !isDiagnosticEventId(value.eventId)
            || value.code !== 'MAIN_STARTUP_CRASH'
            || !isUnknownArray(value.frames)
            || value.frames.length > STARTUP_CRASH_MARKER_MAX_FRAMES
            || !hasOnlyArrayIndices(value.frames)
            || !isSafeTimestamp(value.timestamp)
            || !isSafeRelease(value.release)
            || !isSafeDist(value.dist)
        ) {
            return null;
        }

        const frames: CanonicalAppFrame[] = [];
        for (let index = 0; index < value.frames.length; index += 1) {
            if (!Object.hasOwn(value.frames, index)) {
                return null;
            }
            const frame = decodeCanonicalAppFrame(value.frames[index]);
            if (frame === null) {
                return null;
            }
            frames.push(frame);
        }

        return {
            schemaVersion: STARTUP_CRASH_MARKER_SCHEMA_VERSION,
            eventId: value.eventId,
            code: 'MAIN_STARTUP_CRASH',
            frames,
            timestamp: value.timestamp,
            release: value.release,
            dist: value.dist,
        };
    } catch {
        return null;
    }
}

export const decodeStartupCrashMarker = decodeStartupCrashMarkerRecord;

export function isStartupCrashMarkerRecord(
    value: unknown,
): value is StartupCrashMarkerRecord {
    return decodeStartupCrashMarkerRecord(value) !== null;
}

export function requireStartupCrashMarkerRecord(value: unknown): StartupCrashMarkerRecord {
    const decoded = decodeStartupCrashMarkerRecord(value);
    if (decoded === null) {
        throw new TypeError('Invalid startup crash marker record');
    }
    return decoded;
}
