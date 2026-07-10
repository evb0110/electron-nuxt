export const RUNTIME_TOOL_BOUNDARY_RULES = [
    {
        sourceRoot: 'app',
        targetRoot: 'scripts',
        rule: 'app-to-scripts',
        message: 'App runtime code must not import scripts/** tooling; move shared contracts into packages/**.',
    },
    {
        sourceRoot: 'electron',
        targetRoot: 'scripts',
        rule: 'electron-to-scripts',
        message: 'Electron runtime code must not import scripts/** tooling; move shared contracts into packages/**.',
    },
    {
        sourceRoot: 'packages',
        targetRoot: 'scripts',
        rule: 'packages-to-scripts',
        message: 'Shared runtime packages must not import scripts/** tooling; keep shared contracts inside packages/**.',
    },
    {
        sourceRoot: 'server',
        targetRoot: 'electron',
        rule: 'server-to-electron',
        message: 'server/** must not import electron runtime code.',
    },
    {
        sourceRoot: 'server',
        targetRoot: 'landing',
        rule: 'server-to-landing',
        message: 'server/** must not import landing runtime code.',
    },
    {
        sourceRoot: 'app',
        targetRoot: 'server',
        rule: 'app-to-server',
        message: 'app/** must not import server runtime code.',
    },
    {
        sourceRoot: 'electron',
        targetRoot: 'server',
        rule: 'electron-to-server',
        message: 'electron/** must not import server runtime code.',
    },
    {
        sourceRoot: 'landing',
        targetRoot: 'server',
        rule: 'landing-to-server',
        message: 'landing/** must not import server runtime code.',
    },
    {
        sourceRoot: 'packages',
        targetRoot: 'server',
        rule: 'packages-to-server',
        message: 'Shared packages must not import server runtime code.',
    },
];
