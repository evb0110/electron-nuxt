import {
    mainJobBroker,
    type IJobResourceVector,
} from '@electron/resources/jobBroker';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const PDF_PRINT_LAYOUT_PREFERRED_RESIDENT_BYTES = 7 * GIB;
const PDF_PRINT_LAYOUT_CHILD_OVERHEAD_BYTES = GIB;
const PDF_PRINT_LAYOUT_CHILD_MIN_OLD_SPACE_MIB = 1024;
const PDF_PRINT_LAYOUT_MIN_RESIDENT_BYTES = PDF_PRINT_LAYOUT_CHILD_OVERHEAD_BYTES
    + PDF_PRINT_LAYOUT_CHILD_MIN_OLD_SPACE_MIB * MIB;

export interface IPdfPrintLayoutAdmission {
    estimatedResidentBytes: number;
    childMaxOldSpaceMib: number;
}

// A fixed 7 GiB request is rejected outright by the broker on hosts with less
// than about 8 GiB of RAM, so the request and the child's heap both follow
// what the host can admit; large hosts keep the full budget.
export function resolvePdfPrintLayoutAdmission(
    capacity: IJobResourceVector = mainJobBroker.getSnapshot().capacity,
): IPdfPrintLayoutAdmission {
    const estimatedResidentBytes = Math.min(
        PDF_PRINT_LAYOUT_PREFERRED_RESIDENT_BYTES,
        capacity.estimatedResidentBytes,
    );
    if (estimatedResidentBytes < PDF_PRINT_LAYOUT_MIN_RESIDENT_BYTES) {
        throw new RangeError(
            'PDF print layout requires at least 2 GiB of available processing memory',
        );
    }
    const childMaxOldSpaceMib = Math.floor(
        (estimatedResidentBytes - PDF_PRINT_LAYOUT_CHILD_OVERHEAD_BYTES) / MIB,
    );
    return {
        estimatedResidentBytes,
        childMaxOldSpaceMib,
    };
}
