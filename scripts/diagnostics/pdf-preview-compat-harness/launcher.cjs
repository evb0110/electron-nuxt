import('./main.mjs').catch((error) => {
    console.error(error);
    process.exitCode = 1;
    setImmediate(() => process.exit());
});
