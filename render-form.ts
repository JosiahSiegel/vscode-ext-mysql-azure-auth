import { buildServerFormHtml, createServerFormNonce } from './src/forms/serverFormHtml';

const html = buildServerFormHtml({
  nonce: createServerFormNonce(),
  mode: 'new',
});

console.log(html);