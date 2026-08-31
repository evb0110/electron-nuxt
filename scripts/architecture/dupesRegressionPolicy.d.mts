export interface ICloneInstance {
    file: string;
    fragment: string;
    start_line?: number;
    end_line?: number;
}

export interface ICloneGroup {instances: ICloneInstance[];}

export interface IDupesReport {clone_groups: ICloneGroup[];}

export interface IDupesBaseline {
    schema_version: 1;
    clone_signatures: string[];
}

export const DUPES_BASELINE_SCHEMA_VERSION: 1;
export function createStableCloneSignature(group: ICloneGroup): string;
export function createDupesBaseline(report: IDupesReport): IDupesBaseline;
export function decodeDupesBaseline(value: unknown): IDupesBaseline;
export function findNewCloneGroups(report: IDupesReport, baseline: unknown): ICloneGroup[];
