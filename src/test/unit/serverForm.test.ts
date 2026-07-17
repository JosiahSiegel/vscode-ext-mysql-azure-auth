import * as assert from 'assert';
import { buildServerFormHtml, buildServerFormStyles, createServerFormNonce } from '../../forms/serverFormHtml';
import { makeConnectionConfig } from '../factories/connectionConfig';

const DOM_IDS = [
    'form',
    'name',
    'host',
    'port',
    'user',
    'ssl',
    'readOnly',
    'error',
    'cancel',
    'submit',
] as const;

suite('buildServerFormHtml', () => {
    test('preserves CSP and applies the supplied nonce', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        assert.ok(html.startsWith('<!DOCTYPE html>'));
        assert.ok(html.includes("default-src 'none'"));
        assert.ok(html.includes("script-src 'nonce-test-nonce'"));
        assert.ok(html.includes('<script nonce="test-nonce">'));
    });

    test('renders the registration heading in new mode', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        assert.ok(html.includes('Register a server'));
    });

    test('renders the edit heading in edit mode', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'edit' });

        assert.ok(html.includes('Edit server'));
    });

    test('escapes existing values before placing them in attributes', () => {
        const existing = makeConnectionConfig({ name: '<script>"alert(1)"</script>' });
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'edit', existing });

        assert.ok(html.includes('value="&lt;script&gt;&quot;alert(1)&quot;&lt;/script&gt;"'));
        assert.strictEqual(html.includes('value="<script>'), false);
    });

    test('preserves every server form DOM id', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        for (const id of DOM_IDS) assert.ok(html.includes(`id="${id}"`), `missing DOM id: ${id}`);
    });

    test('omits the default-database input entirely', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });
        const editHtml = buildServerFormHtml({
            nonce: 'test-nonce',
            mode: 'edit',
            existing: makeConnectionConfig(),
        });

        for (const markup of [html, editHtml]) {
            assert.strictEqual(markup.includes('name="database"'), false);
            assert.strictEqual(markup.includes('id="database"'), false);
        }
    });

    test('preserves the submit payload structure', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        assert.ok(html.includes("vscode.postMessage({ command: 'submit', values })"));
        for (const field of ['name', 'host', 'port', 'user']) {
            assert.ok(html.includes(`${field}: String(data.get('${field}') || '').trim()`));
        }
        assert.ok(html.includes("ssl: Boolean(data.get('ssl'))"));
    });

    test('uses truthful Entra-authenticated session copy', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        assert.ok(html.includes('Save an Azure Database for MySQL Flexible Server endpoint for Entra-authenticated sessions.'));
        assert.strictEqual(html.includes('$' + '{env:NAME}'), false);
    });

    test('creates a fresh nonce for each render', () => {
        const first = createServerFormNonce();
        const second = createServerFormNonce();

        assert.strictEqual(first.length, 32);
        assert.strictEqual(second.length, 32);
        assert.notStrictEqual(first, second);
    });

    test('endpoint row keeps host + port in a single side-by-side row', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        // The endpoint row uses its own grid; host and port must share it.
        assert.ok(html.includes('class="field-wide endpoint-row group-start"'));
        // The hint is a sibling paragraph (not nested inside <label>) so all
        // .field cells in the endpoint row have identical height — the
        // host input and port input land on the same baseline.
        assert.ok(html.includes('<p class="hint">e.g. myserver.mysql.database.azure.com</p>'));
        assert.ok(/<p class="hint">&nbsp;<\/p>/.test(html));
    });

    test('every .field that has a label-hint ships the hint as a sibling <p>, not nested in <label>', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        // Old bug: hint was nested inside the <label>, which made labels
        // two lines tall and pushed the host input 16px below the port input.
        assert.strictEqual(html.includes('<span class="hint">'), false);
        // All hints now appear as <p class="hint"> outside the label.
        const hintCount = (html.match(/<p class="hint">/g) ?? []).length;
        assert.ok(hintCount >= 3, `expected ≥3 hint paragraphs, got ${hintCount}`);
    });

    test('transport section is a sibling group, not a .field', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        // The transport row used to be <div class="field field-wide group-start">
        // which forced it into the form's 2-column grid alignment; it's now a
        // standalone .field-wide .group-start .transport that ignores .field.
        assert.ok(html.includes('class="field-wide group-start transport"'));
        assert.ok(html.includes('<span class="field-label">Transport</span>'));
    });

    test('endpoint-row CSS aligns stretched cells so inputs share a baseline', () => {
        const styles = buildServerFormStyles();

        // The endpoint row must stretch its cells so both columns have equal
        // height — that keeps the host input and the port input at the same
        // y-coordinate inside the form.
        assert.ok(styles.includes('.endpoint-row'));
        assert.ok(styles.includes('align-items: stretch'));
        // .field labels and hints have a minimum height so all cells share the
        // same vertical structure whether or not they ship a hint.
        assert.ok(styles.includes('.field > label { min-height: 16px; }'));
        assert.ok(styles.includes('.field > .hint { min-height: 14px; }'));
    });

    test('no keybinding chord hints are declared anywhere in the manifest', () => {
        // Regression: cmd+k cmd+c / cmd+k cmd+e in package.json caused VS Code
        // to render "Windows+K Windows+C" as an inline shortcut chip under the
        // Register button. The chords have been removed; this guards against
        // accidentally reintroducing them.
        const manifest = require('../../../package.json') as { contributes?: { keybindings?: unknown[] } };
        const keybindings = manifest.contributes?.keybindings ?? [];
        assert.ok(Array.isArray(keybindings), 'package.json contributes.keybindings should be an array (or absent)');
        assert.strictEqual(keybindings.length, 0, `expected zero keybindings, found ${keybindings.length}`);
    });

    test('read-only checkbox is rendered as an opt-in toggle', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        // Component C (Todo 5): the readOnly checkbox is back as an opt-in.
        // The default is unchecked; checking it surfaces the user's intent
        // on the wire so the catalog preserves the setting.
        assert.strictEqual(html.includes('id="readOnly"'), true);
        assert.strictEqual(html.includes('name="readOnly"'), true);
        assert.ok(html.includes('Open session in read-only mode (recommended for browsing)'));
        // The form still explains the read-only behaviour in the transport block.
        assert.ok(html.includes('SET SESSION TRANSACTION READ ONLY'));
    });

    test('read-only checkbox is rendered in new mode and in edit mode for both values', () => {
        const htmlNew = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });
        const htmlEditTrue = buildServerFormHtml({
            nonce: 'test-nonce',
            mode: 'edit',
            existing: makeConnectionConfig({ readOnly: true }),
        });
        const htmlEditFalse = buildServerFormHtml({
            nonce: 'test-nonce',
            mode: 'edit',
            existing: makeConnectionConfig({ readOnly: false }),
        });

        for (const html of [htmlNew, htmlEditTrue, htmlEditFalse]) {
            assert.strictEqual(html.includes('id="readOnly"'), true);
        }
        // Edit mode with readOnly: true should preserve the checked state;
        // edit mode with readOnly: false (or new mode with default) should not.
        assert.ok(/<input id="readOnly"[^>]*checked/.test(htmlEditTrue));
        assert.ok(!/<input id="readOnly"[^>]*checked/.test(htmlEditFalse));
        assert.ok(!/<input id="readOnly"[^>]*checked/.test(htmlNew));
    });

    test('readOnly value is included in the submit payload', () => {
        const html = buildServerFormHtml({ nonce: 'test-nonce', mode: 'new' });

        assert.ok(html.includes("readOnly: Boolean(data.get('readOnly'))"));
        assert.ok(html.includes("ssl: Boolean(data.get('ssl'))"));
    });
});
