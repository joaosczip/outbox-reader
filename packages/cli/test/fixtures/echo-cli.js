// Stand-in for dist/src/cli/index.js used by test/outy-bin.test.ts:
// prints the received argv as JSON and exits with $ECHO_CLI_EXIT_CODE.
console.log(JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.ECHO_CLI_EXIT_CODE ?? 0));
