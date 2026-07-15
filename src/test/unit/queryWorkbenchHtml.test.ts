import * as assert from 'assert';
import { buildQueryWorkbenchHtml, escapeHtml } from '../../views/queryWorkbenchHtml';

function extractInlineScript(html: string): string {
    const match = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html);
    if (!match) throw new Error('expected an inline <script nonce> in the workbench HTML');
    // The script body itself contains a template literal that references
    // ${INITIAL_ROW_LIMIT} and ${MAX_RENDER_ROWS} for run-time substitution
    // by the extension's TS template literal. For parsing-as-JS purposes
    // we substitute those with the same numeric values the extension uses.
    return (match[1] ?? '')
        .replace(/\$\{INITIAL_ROW_LIMIT\}/g, '200')
        .replace(/\$\{MAX_RENDER_ROWS\}/g, '10000');
}

const DOM_IDS = [
    'app',
    'editor',
    'autocomplete',
    'run',
    'explain',
    'export',
    'database',
    'last-time',
    'last-rows',
    'cards',
    'history-tab',
    'detail-tab',
    'history',
    'detail-panel',
    'detail-title',
    'detail',
    'history-list',
    'history-more',
] as const;

suite('buildQueryWorkbenchHtml', () => {
    test('preserves the CSP and script nonce without unsafe eval', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });

        assert.ok(html.includes("default-src 'none'"));
        assert.ok(html.includes("script-src 'nonce-test-nonce'"));
        assert.ok(html.includes('<script nonce="test-nonce">'));
        assert.strictEqual(html.includes('unsafe-eval'), false);
    });

    test('renders an escaped server name', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: escapeHtml('<production & "primary">') });

        assert.ok(html.includes('&lt;production &amp; &quot;primary&quot;&gt;'));
        assert.strictEqual(html.includes('<production & "primary">'), false);
    });

    test('preserves every workbench DOM id', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });

        for (const id of DOM_IDS) assert.ok(html.includes(`id="${id}"`), `missing DOM id: ${id}`);
    });

    test('omits the experimental Vim navigation clutter', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });

        assert.strictEqual(html.includes('Experimental Vim navigation'), false);
        assert.strictEqual(html.includes('vim-control'), false);
        assert.strictEqual(html.includes('vim-help'), false);
    });

    test('uses restrained chart accents in the studio styles', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });

        assert.ok(html.includes('--vscode-charts-purple'));
        assert.ok(html.includes('--vscode-charts-blue'));
    });

    test('sends full editor SQL and caret to the host without an inline SQL scanner', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });

        assert.ok(html.includes("command:'executeQuery',sql:editor.value"));
        assert.ok(html.includes("command:'runFocusedQuery',sql:editor.value,caret:editor.selectionStart"));
        assert.strictEqual(html.includes('splitSqlStatementsInternal'), false);
        assert.strictEqual(html.includes('focusedSql'), false);
    });

    test('initializes the VS Code API and host handshake', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });

        assert.ok(html.includes('acquireVsCodeApi()'));
        assert.ok(html.includes("command:'ready'"));
        assert.ok(html.includes("command:'loadHistory'"));
    });

    test('inline webview script is syntactically valid JavaScript', () => {
        // Regression: an unmatched `}` in the message-listener switch used to make the entire
        // webview script fail to parse with "missing ) after argument list", which disabled
        // every click handler (Run, Explain, history, cell detail) and left the Run button
        // permanently disabled. The build now closes exactly two braces around the listener
        // callback (not three). This test catches that and any future bracket drift.
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });
        const script = extractInlineScript(html);
        assert.doesNotThrow(() => {
            new Function(script);
        }, 'inline webview script must parse as valid JavaScript');
    });

    test('pre-populates the editor with a safe default query so Run is enabled on open', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });

        // The default SELECT * LIMIT 10 must live inside the <textarea id="editor"> tag,
        // NOT in a placeholder attribute, so the Run button enables from the very first render.
        const editorTag = html.match(/<textarea[^>]*id="editor"[^>]*>([\s\S]*?)<\/textarea>/);
        assert.ok(editorTag, 'expected a textarea#editor element');
        const body = editorTag![1] ?? '';
        assert.ok(
            body.includes('SELECT * FROM information_schema.tables LIMIT 10'),
            'textarea body must contain the default seed SQL, got: ' + body
        );
        assert.ok(
            !/<textarea[^>]*id="editor"[^>]*placeholder=/.test(html),
            'placeholder attribute must be removed so the default SQL is the actual value'
        );
    });

    test('loading placeholder has an id so it can be removed when results arrive', () => {
        // Regression: previously the "Executing statements…" div had no id, so appending
        // a result card left the placeholder visible forever (Run button worked but the
        // placeholder never disappeared). The placeholder now carries id="loading-placeholder"
        // and the result-render path removes it.
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });

        assert.ok(
            html.includes('id="loading-placeholder"'),
            'loading message must have id="loading-placeholder" so result rendering can remove it'
        );
        assert.ok(
            html.includes('getElementById(\'loading-placeholder\')'),
            'showCard must look up and remove the loading-placeholder before appending the result card'
        );
    });

    test('read-only state is invisible when not requested', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });

        assert.ok(!html.includes('class="ro-badge"'), 'RO badge must not appear when readOnly is omitted');
        assert.ok(!/aria-label="[^"]*read-only/.test(html), 'aria-label must not claim read-only when not requested');
    });

    test('read-only state surfaces an RO badge next to the server name when requested', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production', readOnly: true });

        assert.ok(html.includes('class="ro-badge"'), 'RO badge must appear in the connection-context pill');
        assert.ok(html.includes('>RO</span>'), 'RO badge must contain the literal "RO" text');
        assert.ok(
            /aria-label="[^"]*read-only[^"]*"/.test(html),
            'aria-label must mention read-only for assistive tech'
        );
        assert.ok(
            html.includes('Server: production · RO'),
            'status bar must show RO suffix next to the server name'
        );
    });

    test('inline webview script still parses as valid JavaScript when readOnly is enabled', () => {
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production', readOnly: true });

        const script = extractInlineScript(html);
        assert.doesNotThrow(() => {
            new Function(script);
        }, 'inline webview script must parse as valid JavaScript in read-only mode');
    });
});
