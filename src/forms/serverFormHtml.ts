import type { ConnectionConfig } from '../domain';

type ServerFormHtmlOptions = {
    readonly nonce: string;
    readonly mode: 'new' | 'edit';
    readonly existing?: ConnectionConfig;
};

type ServerFormMarkupOptions = Omit<ServerFormHtmlOptions, 'nonce'>;

export function buildServerFormHtml(options: ServerFormHtmlOptions): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${options.nonce}';">
<title>${options.mode === 'edit' ? 'Edit server' : 'Register a server'}</title>
<style>${buildServerFormStyles()}</style>
</head>
<body>
${buildServerFormMarkup(options)}
<script nonce="${options.nonce}">${buildServerFormScript()}</script>
</body>
</html>`;
}

export function buildServerFormStyles(): string {
    // (exported for unit-test alignment invariants)
    return `* { box-sizing: border-box; }
body {
  min-height: 100%;
  margin: 0;
  padding: 20px;
  font: 13px var(--vscode-font-family);
  color: var(--vscode-foreground);
  background: radial-gradient(circle at 18% 0, var(--vscode-editor-lineHighlightBackground), transparent 38%), var(--vscode-sideBar-background);
}
.profile-shell {
  width: min(680px, 100%);
  margin: 0 auto;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  background: var(--vscode-editor-background);
  box-shadow: 0 12px 32px var(--vscode-widget-shadow);
  overflow: hidden;
}
.profile-head { padding: 16px 18px 14px; border-top: 2px solid var(--vscode-charts-purple); border-bottom: 1px solid var(--vscode-panel-border); }
.eyebrow { margin: 0 0 5px; color: var(--vscode-charts-blue); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; letter-spacing: -.01em; }
p.subhead { max-width: 62ch; margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.5; }
form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 14px; row-gap: 14px; padding: 14px 18px 16px; }
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.field > label { min-height: 16px; }
.field > .hint { min-height: 14px; }
.field-wide { grid-column: 1 / -1; }
.group-start { border-top: 1px solid var(--vscode-panel-border); padding-top: 14px; margin-top: 4px; }
label, .field-label { color: var(--vscode-foreground); font-size: 12px; font-weight: 600; line-height: 1.35; }
.hint { margin: 0; min-height: 14px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 400; line-height: 1.35; }
input[type="text"] {
  width: 100%;
  min-height: 30px;
  padding: 6px 8px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 2px;
  outline: none;
  font: 13px var(--vscode-font-family);
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
}
input:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.endpoint-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px;
  column-gap: 14px;
  align-items: stretch;
}
.transport { display: flex; flex-direction: column; gap: 8px; }
.tls-row { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 7px 9px; border: 1px solid var(--vscode-panel-border); border-radius: 2px; background: var(--vscode-editor-lineHighlightBackground); }
.tls-row input { margin: 0; accent-color: var(--vscode-charts-purple); }
.tls-row label { font-weight: 500; }
.readonly-row { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 7px 9px; border: 1px solid var(--vscode-panel-border); border-radius: 2px; background: var(--vscode-editor-lineHighlightBackground); }
.readonly-row input { margin: 0; accent-color: var(--vscode-charts-purple); }
.readonly-row label { font-weight: 500; }
.tls-hint { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 400; }
.error { grid-column: 1 / -1; display: none; margin-top: 4px; padding: 9px 10px; border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 2px; color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); }
.error.visible { display: block; }
.actions { grid-column: 1 / -1; display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; padding-top: 14px; border-top: 1px solid var(--vscode-panel-border); }
button { min-height: 30px; padding: 5px 13px; border: 1px solid transparent; border-radius: 2px; cursor: pointer; font: 13px var(--vscode-font-family); transition: background-color 120ms ease, border-color 120ms ease; }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button.primary { border-color: var(--vscode-charts-purple); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { border-color: var(--vscode-panel-border); color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
@media (max-width: 540px) {
  body { padding: 8px; }
  .profile-shell { border-radius: 2px; }
  form { grid-template-columns: minmax(0, 1fr); padding-inline: 14px; }
  .field-wide { grid-column: 1; }
  .endpoint-row { grid-template-columns: minmax(0, 1fr); }
  .actions { flex-direction: column; }
  button { width: 100%; }
}`;
}

export function buildServerFormMarkup(options: ServerFormMarkupOptions): string {
    const existing = options.existing;
    const values = {
        name: existing?.name ?? '',
        host: existing?.host ?? '',
        port: existing ? String(existing.port) : '3306',
        user: existing?.user ?? '',
        ssl: existing?.ssl ?? true,
        readOnly: existing?.readOnly ?? false,
    };
    const isEdit = options.mode === 'edit';
    const heading = isEdit ? 'Edit server' : 'Register a server';
    const subhead = isEdit
        ? 'Update connection details. Changes apply to new sessions only.'
        : 'Save an Azure Database for MySQL Flexible Server endpoint for Entra-authenticated sessions.';

    // The read-only checkbox is rendered as an opt-in toggle. Sessions are
    // read-only by default at the server-side (`SET SESSION TRANSACTION
    // READ ONLY` runs at checkout), so leaving this unchecked is the safe
    // default; checking it surfaces the user's intent on the wire so the
    // catalog preserves the setting.

    return `<main class="profile-shell">
<header class="profile-head">
  <p class="eyebrow">Connection profile</p>
  <h1>${heading}</h1>
  <p class="subhead">${escapeServerFormHtml(subhead)}</p>
</header>
<form id="form" autocomplete="off" novalidate>
  <div class="field field-wide">
    <label for="name">Display label</label>
    <input id="name" name="name" type="text" placeholder="analytics-prod" value="${escapeServerFormAttribute(values.name)}" autofocus>
  </div>

  <div class="field-wide endpoint-row group-start">
    <div class="field">
      <label for="host">Hostname</label>
      <p class="hint">e.g. myserver.mysql.database.azure.com</p>
      <input id="host" name="host" type="text" placeholder="myserver.mysql.database.azure.com" value="${escapeServerFormAttribute(values.host)}">
    </div>
    <div class="field">
      <label for="port">TCP port</label>
      <p class="hint">&nbsp;</p>
      <input id="port" name="port" type="text" inputmode="numeric" value="${escapeServerFormAttribute(values.port)}">
    </div>
  </div>

  <div class="field">
    <label for="user">Entra principal</label>
    <p class="hint">name@your-tenant.onmicrosoft.com</p>
    <input id="user" name="user" type="text" placeholder="name@your-tenant.onmicrosoft.com" value="${escapeServerFormAttribute(values.user)}">
  </div>

  <div class="field-wide group-start transport">
    <span class="field-label">Transport</span>
    <div class="tls-row">
      <input id="ssl" name="ssl" type="checkbox" ${values.ssl ? 'checked' : ''}>
      <label for="ssl">Encrypt connection (recommended)</label>
    </div>
    <div class="readonly-row">
      <input id="readOnly" name="readOnly" type="checkbox" ${values.readOnly ? 'checked' : ''}>
      <label for="readOnly">Open session in read-only mode (recommended for browsing)</label>
    </div>
    <p class="tls-hint">Sessions are read-only by design — every connection runs <code>SET SESSION TRANSACTION READ ONLY</code> at checkout, so the server rejects writes even if your account has permission to make them.</p>
  </div>

  <div id="error" class="error" role="alert"></div>
  <div class="actions">
    <button type="button" id="cancel" class="secondary">Cancel</button>
    <button type="submit" id="submit" class="primary">${isEdit ? 'Save changes' : 'Register'}</button>
  </div>
</form>
</main>`;
}

export function buildServerFormScript(): string {
    return `const vscode = acquireVsCodeApi();
const form = document.getElementById('form');
const errorBox = document.getElementById('error');
function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.add('visible');
}
function clearError() {
  errorBox.textContent = '';
  errorBox.classList.remove('visible');
}
function readValues() {
  const data = new FormData(form);
  return {
    name: String(data.get('name') || '').trim(),
    host: String(data.get('host') || '').trim(),
    port: String(data.get('port') || '').trim(),
    user: String(data.get('user') || '').trim(),
    ssl: Boolean(data.get('ssl')),
    readOnly: Boolean(data.get('readOnly')),
  };
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearError();
  const values = readValues();
  vscode.postMessage({ command: 'submit', values });
});
document.getElementById('cancel').addEventListener('click', () => {
  vscode.postMessage({ command: 'cancel' });
});
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message && message.type === 'error') showError(message.message || 'Validation failed');
});
const firstEmpty = ['name', 'host', 'user'].find((key) => {
  const element = document.getElementById(key);
  return element && !element.value;
});
if (firstEmpty) document.getElementById(firstEmpty).focus();`;
}

export function createServerFormNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export function escapeServerFormHtml(text: string): string {
    return text.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character] ?? character));
}

export function escapeServerFormAttribute(value: string): string {
    return escapeServerFormHtml(value).replace(/`/g, '&#96;');
}
