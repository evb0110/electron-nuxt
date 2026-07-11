import { defineConfig } from 'vitest/config';
import {
    electronE2ETeardownTimeoutMs,
    unitSlowTestThresholdMs,
    vitestProjects,
} from './vitest.shared.config';

export default defineConfig({ test: {
    projects: vitestProjects,
    slowTestThreshold: unitSlowTestThresholdMs,
    teardownTimeout: electronE2ETeardownTimeoutMs,
    coverage: {
        provider: 'v8',
        include: [
            'electron/platform-ipc/**/*.ts',
            'packages/contracts/**/*.ts',
            'app/**/*.worker.ts',
            'electron/**/*.worker.ts',
            'electron/**/*Worker.ts',
            'electron/**/worker.ts',
            'electron/**/worker/main.ts',
        ],
        reporter: [
            'text',
            'json-summary',
            'lcov',
        ],
        thresholds: {
            statements: 65,
            branches: 66,
            functions: 76,
            lines: 66,
        },
    },
} });
