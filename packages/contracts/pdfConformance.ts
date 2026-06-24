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

export type TPdfConformanceProfileBase = Except<IPdfConformanceProfile, 'saveRestrictions'>;

export interface IPdfValidationResult {
    isValid: boolean;
    tool: 'qpdf' | 'browser' | 'native';
    errors: string[];
    warnings: string[];
}
