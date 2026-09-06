import { isRecord } from '@contracts/runtimeGuards';
import type {
    Except,
    LiteralUnion,
} from 'type-fest';

export type TPdfSaveMode = 'incremental' | 'rewrite' | 'save_as_rewrite';

export type TPdfaPart = '1' | '2' | '3' | '4';
export type TPdfaConformance = 'A' | 'B' | 'E' | 'F' | 'U';
export type TPdfaLevel = LiteralUnion<`PDF/A-${TPdfaPart}${TPdfaConformance}`, string>;

export interface IPdfConformanceProfile {
    isSigned: boolean;
    isEncrypted: boolean;
    isTagged: boolean;
    pdfaLevel: TPdfaLevel | null;
    hasAcroForm: boolean;
    hasXfa: boolean;
    canIncrementalSave: boolean;
    saveRestrictions: string[];
}

export interface IPdfConformanceAnalysisOptions {purpose?: 'full' | 'save-restrictions';}

export type TPdfConformanceProfileBase = Except<IPdfConformanceProfile, 'saveRestrictions'>;

export interface IPdfValidationResult {
    readonly isValid: boolean;
    readonly tool: 'qpdf' | 'browser' | 'native';
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}

export function isPdfValidationResult(value: unknown): value is IPdfValidationResult {
    return isRecord(value)
        && typeof value.isValid === 'boolean'
        && (value.tool === 'qpdf' || value.tool === 'browser' || value.tool === 'native')
        && Array.isArray(value.errors)
        && value.errors.every(error => typeof error === 'string')
        && Array.isArray(value.warnings)
        && value.warnings.every(warning => typeof warning === 'string');
}
