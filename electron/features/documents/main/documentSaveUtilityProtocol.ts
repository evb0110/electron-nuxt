import {
    isAbsolute,
    dirname,
} from 'node:path';
import { isRecord } from '@contracts/runtimeGuards';

export interface IDocumentSaveUtilityRequest {
    type: 'commit';
    sourcePath: string;
    targetPath: string;
    expectedBytes: number;
    validationBinary?: string;
    changedObjectRefs?: string[];
}

const PDF_OBJECT_REF_PATTERN = /^\d+ \d+ R$/u;
const MAX_CHANGED_OBJECT_REFS = 128;

export type TDocumentSaveUtilityResult =
    | {
        type: 'result';
        ok: true;
        bytes: number;
        sha256: string
    }
    | {
        type: 'result';
        ok: false;
        error: string
    };

export function decodeDocumentSaveUtilityRequest(value: unknown): IDocumentSaveUtilityRequest | null {
    if (!isRecord(value)
        || value.type !== 'commit'
        || typeof value.sourcePath !== 'string'
        || typeof value.targetPath !== 'string'
        || !isAbsolute(value.sourcePath)
        || !isAbsolute(value.targetPath)
        || dirname(value.sourcePath) !== dirname(value.targetPath)
        || value.sourcePath === value.targetPath
        || (value.validationBinary !== undefined && (typeof value.validationBinary !== 'string' || !isAbsolute(value.validationBinary)))
        || (value.changedObjectRefs !== undefined && (
            !Array.isArray(value.changedObjectRefs)
            || value.changedObjectRefs.length > MAX_CHANGED_OBJECT_REFS
            || !value.changedObjectRefs.every(ref => typeof ref === 'string' && PDF_OBJECT_REF_PATTERN.test(ref))
        ))
        || typeof value.expectedBytes !== 'number'
        || !Number.isSafeInteger(value.expectedBytes)
        || value.expectedBytes <= 0) {
        return null;
    }
    return {
        type: 'commit',
        sourcePath: value.sourcePath,
        targetPath: value.targetPath,
        expectedBytes: value.expectedBytes,
        ...(typeof value.validationBinary === 'string' ? {validationBinary: value.validationBinary} : {}),
        ...(Array.isArray(value.changedObjectRefs)
            && value.changedObjectRefs.every((entry): entry is string => typeof entry === 'string')
            ? {changedObjectRefs: [...value.changedObjectRefs]}
            : {}),
    };
}

export function decodeDocumentSaveUtilityResult(value: unknown): TDocumentSaveUtilityResult | null {
    if (!isRecord(value) || value.type !== 'result' || typeof value.ok !== 'boolean') {
        return null;
    }
    if (value.ok) {
        if (typeof value.bytes !== 'number'
            || !Number.isSafeInteger(value.bytes)
            || value.bytes <= 0
            || typeof value.sha256 !== 'string'
            || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
            return null;
        }
        return {
            type: 'result',
            ok: true,
            bytes: value.bytes,
            sha256: value.sha256,
        };
    }
    return typeof value.error === 'string'
        ? {
            type: 'result',
            ok: false,
            error: value.error,
        }
        : null;
}
