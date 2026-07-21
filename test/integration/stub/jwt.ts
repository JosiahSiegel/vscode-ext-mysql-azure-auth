/**
 * Stub JWT generator for the Entra auth integration test.
 *
 * Produces a real RSA-signed JWT that the stub MySQL server can verify
 * with the matching public key. The shape mirrors what Azure Entra ID
 * actually issues for the MySQL scope:
 *   aud = https://ossrdbms-aad.database.windows.net
 *   iss = https://sts.windows.net/<tenant-id>/
 *   sub / oid = the principal being authenticated
 *   exp / iat / nbf = standard 1-hour validity
 *
 * The test owns a single key pair for the whole run. The private key
 * is used only by the test's stub credential; the public key is the
 * only thing the stub MySQL server trusts.
 */

import * as crypto from 'crypto';

export interface StubKeyPair {
    privateKey: crypto.KeyObject;
    publicKey: crypto.KeyObject;
    /** PEM-encoded public key (JWK-friendly format). */
    publicKeyPem: string;
    /** PEM-encoded private key. */
    privateKeyPem: string;
    /** Stable random kid for the JWKS. */
    kid: string;
}

export function generateStubKeyPair(): StubKeyPair {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // When encoding options are passed, generateKeyPairSync returns strings
    // (not KeyObjects). We then need to import them back as KeyObjects so
    // we can both sign and verify.
    const priv = typeof privateKey === 'string'
        ? crypto.createPrivateKey(privateKey)
        : privateKey;
    const pub = typeof publicKey === 'string'
        ? crypto.createPublicKey(publicKey)
        : publicKey;
    return {
        privateKey: priv,
        publicKey: pub,
        publicKeyPem: typeof publicKey === 'string' ? publicKey : publicKey.export({ type: 'spki', format: 'pem' }) as string,
        privateKeyPem: typeof privateKey === 'string' ? privateKey : privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        kid: crypto.randomBytes(8).toString('hex'),
    };
}

export interface StubJwtOptions {
    /** Entra tenant id. Lands in `iss` and `aud.tid` (real Entra includes both). */
    tenantId: string;
    /** Principal object id (oid). */
    oid: string;
    /** Upn / email-style identifier. */
    upn: string;
    /** Audience - the MySQL AAD resource. */
    audience?: string;
    /** Validity window in seconds. Default 1 hour. */
    expiresInSec?: number;
    /** Override `now` for deterministic tests. */
    now?: number;
}

/** Real Azure Entra audience for the MySQL AAD flow. */
export const AZURE_MYSQL_ENTRA_AUDIENCE = 'https://ossrdbms-aad.database.windows.net';
export const STUB_TENANT_ID = '11111111-2222-3333-4444-555555555555';
export const STUB_OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const STUB_UPN = 'test-user@stub-tenant.example.com';
export const STUB_USER = 'test-user@stub-tenant.example.com';
export const STUB_AUDIENCE_WRONG = 'https://management.azure.com/.default';


/**
 * Sign a JWT body with the given key. Returns the dot-separated JWT string
 * the stub MySQL server will receive in the mysql_clear_password slot.
 */
export function signStubJwt(
    key: StubKeyPair,
    options: StubJwtOptions
): { jwt: string; expiresAt: number } {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const expiresIn = options.expiresInSec ?? 3600;
    const aud = options.audience ?? AZURE_MYSQL_ENTRA_AUDIENCE;
    const header = {
        alg: 'RS256',
        typ: 'JWT',
        kid: key.kid,
    };
    const payload = {
        aud,
        iss: `https://sts.windows.net/${options.tenantId}/`,
        iat: now,
        nbf: now,
        exp: now + expiresIn,
        oid: options.oid,
        sub: options.oid,
        upn: options.upn,
        tid: options.tenantId,
        ver: '1.0',
    };
    const headerB64 = b64urlEncode(Buffer.from(JSON.stringify(header)));
    const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = crypto.sign(
        'RSA-SHA256',
        Buffer.from(signingInput),
        key.privateKey
    );
    return {
        jwt: `${signingInput}.${b64urlEncode(signature)}`,
        expiresAt: now + expiresIn,
    };
}

function b64urlEncode(buf: Buffer): string {
    return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Decode a JWT and verify its signature against the given public key. */
export function verifyStubJwt(
    jwt: string,
    publicKey: crypto.KeyObject
): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string } {
    const parts = jwt.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed: not 3 parts' };
    const [headerB64, payloadB64, signatureB64] = parts;
    let signature: Buffer;
    try {
        signature = Buffer.from(signatureB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(signatureB64.length + (4 - signatureB64.length % 4) % 4, '='), 'base64');
    } catch {
        return { ok: false, reason: 'malformed: bad signature encoding' };
    }
    const signingInput = `${headerB64}.${payloadB64}`;
    const ok = crypto.verify(
        'RSA-SHA256',
        Buffer.from(signingInput),
        publicKey,
        signature
    );
    if (!ok) return { ok: false, reason: 'signature mismatch' };
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(
            Buffer.from(
                payloadB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(payloadB64.length + (4 - payloadB64.length % 4) % 4, '='),
                'base64'
            ).toString('utf8')
        );
    } catch {
        return { ok: false, reason: 'malformed: bad payload json' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) {
        return { ok: false, reason: 'expired' };
    }
    if (typeof payload.nbf === 'number' && payload.nbf > now) {
        return { ok: false, reason: 'not yet valid' };
    }
    return { ok: true, payload };
}
