export const oracleStatuses = [
    'passed',
    'failed',
    'inconclusive',
] as const;

export type TOracleStatus = typeof oracleStatuses[number];

export interface IOracleResult {
    oracleId: string;
    oracleVersion: string;
    status: TOracleStatus;
    detail: string;
    observations: Record<string, unknown>;
}

export interface ICreateOracleResultInput {
    oracleId: string;
    oracleVersion: string;
    status: TOracleStatus;
    detail: string;
    observations?: Record<string, unknown>;
}

export function createOracleResult(input: ICreateOracleResultInput): IOracleResult {
    return {
        oracleId: input.oracleId,
        oracleVersion: input.oracleVersion,
        status: input.status,
        detail: input.detail,
        observations: input.observations ?? {},
    };
}

/**
 * An inconclusive oracle never becomes a pass: a missing renderer or a missing
 * Python dependency is an investigation, not evidence that the product worked.
 */
export function combineOracleStatuses(statuses: readonly TOracleStatus[]): TOracleStatus {
    if (statuses.includes('failed')) {
        return 'failed';
    }
    if (statuses.includes('inconclusive') || statuses.length === 0) {
        return 'inconclusive';
    }
    return 'passed';
}

export { getErrorMessage as describeError } from '@contracts/getErrorMessage';
