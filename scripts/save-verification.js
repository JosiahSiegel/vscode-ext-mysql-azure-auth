const { execFileSync, execSync, spawnSync } = require('child_process');
const { writeFileSync } = require('fs');
const path = require('path');

const OUTPUT_PATH = path.resolve(__dirname, '..', 'LIVE_VERIFICATION.txt');
const SAFE_LINE = /^(?:STEP [A-Za-z0-9 .()/-]+ \| (?:SELECT|SHOW|DESCRIBE|DISCONNECT) \| rows=\d+ \| PASS(?: \(skipped\))?|LIVE VERIFICATION: (?:PASSED|FAILED(?: \([A-Za-z]+Error\))?))$/;

function getAccessToken() {
    if (process.platform === 'win32') {
        return execSync(
            'az account get-access-token --resource "https://ossrdbms-aad.database.windows.net" --query "accessToken" -o tsv',
            { encoding: 'utf8', windowsHide: true }
        ).trim();
    }
    return execFileSync(
        'az',
        [
            'account',
            'get-access-token',
            '--resource',
            'https://ossrdbms-aad.database.windows.net',
            '--query',
            'accessToken',
            '-o',
            'tsv',
        ],
        { encoding: 'utf8', windowsHide: true }
    ).trim();
}

function safeLines(output) {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => SAFE_LINE.test(line));
}

function main() {
    const token = getAccessToken();
    const result = spawnSync(process.execPath, [path.join(__dirname, 'verify-live.js')], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, MYSQL_ACCESS_TOKEN: token },
    });
    const lines = safeLines(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    const status = result.status === 0 && lines.includes('LIVE VERIFICATION: PASSED')
        ? 'LIVE VERIFICATION: PASSED'
        : 'LIVE VERIFICATION: FAILED';
    const summaries = lines.filter((line) => line.startsWith('STEP '));
    const artifact = [status, ...summaries].join('\n') + '\n';
    writeFileSync(OUTPUT_PATH, artifact, { encoding: 'utf8' });
    process.stdout.write(artifact);
    if (status !== 'LIVE VERIFICATION: PASSED') process.exitCode = 1;
}

try {
    main();
} catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const artifact = `LIVE VERIFICATION: FAILED (${errorName})\n`;
    writeFileSync(OUTPUT_PATH, artifact, { encoding: 'utf8' });
    process.stdout.write(artifact);
    process.exitCode = 1;
}
