import {createHash} from 'node:crypto';

export const DUPES_BASELINE_SCHEMA_VERSION = 1;

/** @typedef {{file: string, fragment: string}} ICloneInstance */
/** @typedef {{instances: ICloneInstance[]}} ICloneGroup */
/** @typedef {{clone_groups: ICloneGroup[]}} IDupesReport */
/** @typedef {{schema_version: number, clone_signatures: string[]}} IDupesBaseline */

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function requireRecord(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/** @param {string} fragment @returns {string} */
function normalizeFragment(fragment) {
    if (typeof fragment !== 'string' || fragment.length === 0) {
        throw new TypeError('clone instance fragment must be a non-empty string');
    }
    return fragment.replace(/\r\n?/gu, '\n').trim();
}

/** @param {string} value @returns {string} */
function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

/** @param {ICloneGroup} group @returns {string} */
export function createStableCloneSignature(group) {
    const record = /** @type {ICloneGroup} */ (requireRecord(group, 'clone group'));
    if (!Array.isArray(record.instances) || record.instances.length < 2) {
        throw new TypeError('clone group instances must contain at least two entries');
    }

    const instanceSignatures = record.instances.map((instance, index) => {
        const instanceRecord = /** @type {ICloneInstance} */ (requireRecord(instance, `clone group instance ${index}`));
        if (typeof instanceRecord.file !== 'string' || instanceRecord.file.length === 0) {
            throw new TypeError(`clone group instance ${index} file must be a non-empty string`);
        }
        return `${instanceRecord.file}\0${digest(normalizeFragment(instanceRecord.fragment))}`;
    }).sort();

    return `clone:v${DUPES_BASELINE_SCHEMA_VERSION}:${digest(instanceSignatures.join('\0'))}`;
}

/** @param {IDupesReport} report @returns {IDupesBaseline} */
export function createDupesBaseline(report) {
    const record = /** @type {IDupesReport} */ (requireRecord(report, 'duplication report'));
    if (!Array.isArray(record.clone_groups)) {
        throw new TypeError('duplication report clone_groups must be an array');
    }
    return {
        schema_version: DUPES_BASELINE_SCHEMA_VERSION,
        clone_signatures: [...new Set(record.clone_groups.map(createStableCloneSignature))].sort(),
    };
}

/** @param {IDupesBaseline} value @returns {IDupesBaseline} */
export function decodeDupesBaseline(value) {
    const record = /** @type {IDupesBaseline} */ (requireRecord(value, 'duplication baseline'));
    if (record.schema_version !== DUPES_BASELINE_SCHEMA_VERSION) {
        throw new TypeError(`duplication baseline schema_version must be ${DUPES_BASELINE_SCHEMA_VERSION}`);
    }
    if (
        !Array.isArray(record.clone_signatures)
        || record.clone_signatures.some(signature => (
            typeof signature !== 'string'
            || !/^clone:v1:[0-9a-f]{64}$/u.test(signature)
        ))
    ) {
        throw new TypeError('duplication baseline clone_signatures must contain stable clone signatures');
    }
    if (new Set(record.clone_signatures).size !== record.clone_signatures.length) {
        throw new TypeError('duplication baseline clone_signatures must be unique');
    }
    return {
        schema_version: DUPES_BASELINE_SCHEMA_VERSION,
        clone_signatures: [...record.clone_signatures],
    };
}

/** @param {IDupesReport} report @param {IDupesBaseline} baseline @returns {ICloneGroup[]} */
export function findNewCloneGroups(report, baseline) {
    const reportRecord = /** @type {IDupesReport} */ (requireRecord(report, 'duplication report'));
    if (!Array.isArray(reportRecord.clone_groups)) {
        throw new TypeError('duplication report clone_groups must be an array');
    }
    const acceptedSignatures = new Set(decodeDupesBaseline(baseline).clone_signatures);
    return reportRecord.clone_groups.filter(group => !acceptedSignatures.has(createStableCloneSignature(group)));
}
