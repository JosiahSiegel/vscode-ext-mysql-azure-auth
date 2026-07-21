/**
 * Stub MySQL server that accepts only Entra-issued JWTs over the
 * `mysql_clear_password` plugin.
 *
 * This is a minimal MySQL wire-protocol server. It implements exactly
 * the slice the extension exercises:
 *
 *   - Initial handshake (10.x) with `mysql_clear_password` as the
 *     default auth plugin. Advertises CLIENT_PROTOCOL_41 +
 *     CLIENT_SECURE_CONNECTION + CLIENT_PLUGIN_AUTH so the client knows
 *     to send its plugin name in the handshake response.
 *   - Parse the auth response, extract the JWT, verify it against the
 *     test's public key. Reject anything else with `ER_ACCESS_DENIED`.
 *   - After successful auth, accept COM_QUERY and dispatch a small set
 *     of well-known queries:
 *
 *         "SELECT 1"                       -> single column, single row
 *         "SELECT 1+1 AS sum"              -> single column "sum" = "2"
 *         "SHOW DATABASES"                 -> three-row result
 *         "SELECT DATABASE()"              -> NULL row
 *         "SELECT @@version_comment"       -> stub-mysql string
 *         "SET SESSION TRANSACTION READ ONLY" -> OK
 *
 *     Anything else returns `ER_NOT_SUPPORTED_YET`. This keeps the
 *     stub honest: tests must drive the extension only with the
 *     classifier-allowed verbs.
 *   - COM_PING -> OK.
 *   - COM_QUIT -> close.
 *
 * The server is bound to a random localhost port. The `port` field on
 * the handle returns the bound port so the test can connect to it.
 */

import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { StubKeyPair, verifyStubJwt, AZURE_MYSQL_ENTRA_AUDIENCE } from './jwt';

// Capability flags we advertise.
const CAPABILITY_FLAGS =
    0x00000001 | // CLIENT_LONG_PASSWORD
    0x00000008 | // CLIENT_CONNECT_WITH_DB
    0x00000200 | // CLIENT_PROTOCOL_41
    0x00008000 | // CLIENT_SECURE_CONNECTION
    0x00020000 | // CLIENT_MULTI_RESULTS
    0x00080000;  // CLIENT_PLUGIN_AUTH

const AUTH_PLUGIN_NAME = 'mysql_clear_password';
const SERVER_VERSION = '8.0.0-stub';

const ER_ACCESS_DENIED = 1045;
const ER_NOT_SUPPORTED_YET = 1235;

export interface StubMysqlOptions {
    keyPair: StubKeyPair;
    /** Expected tenant id (matched against JWT `tid` claim). */
    tenantId: string;
    /** The "database" the client asked for (if any). */
    database?: string;
    /** How long to wait for the client auth response before giving up. */
    authTimeoutMs?: number;
    /**
     * If set, the server accepts TLS connections using this pair of
     * PEM-encoded self-signed certs. Required for the direct
     * mysql_clear_password path because mysql2 refuses to send a
     * cleartext password over an unencrypted connection.
     */
    tls?: { cert: string; key: string };
}

export interface StubMysqlHandle {
    host: string;
    port: number;
    /** Resolves when the server has finished listening. */
    listening: Promise<void>;
    /** Close all sockets and stop listening. */
    close(): Promise<void>;
    /** Number of completed handshakes (successful or otherwise). */
    authAttempts(): number;
    /** Number of handshakes that passed JWT verification. */
    authSuccesses(): number;
    /** Last username seen (for assertions). */
    lastUsername(): string | undefined;
    /** Last JWT seen in the auth slot (for assertions). */
    lastJwt(): string | undefined;
    /** Last reason string from a failed auth. */
    lastRejectReason(): string | undefined;
}

export function startStubMysql(options: StubMysqlOptions): Promise<StubMysqlHandle> {
    return new Promise((resolve, reject) => {
        const authTimeoutMs = options.authTimeoutMs ?? 5000;
        const stats = {
            attempts: 0,
            successes: 0,
            lastUsername: undefined as string | undefined,
            lastJwt: undefined as string | undefined,
            lastRejectReason: undefined as string | undefined,
        };
        const sockets = new Set<net.Socket>();
        let server: net.Server | tls.Server;
        const onConnection = (socket: net.Socket | tls.TLSSocket) => {
            sockets.add(socket);
            socket.on('error', () => sockets.delete(socket));
            socket.on('close', () => sockets.delete(socket));
            handleConnection(socket as net.Socket, options, stats, authTimeoutMs).catch((err) => {
                try {
                    socket.destroy();
                } catch {
                    /* ignore */
                }
                // eslint-disable-next-line no-console
                console.error('[stub-mysql] connection error:', err);
            });
        };
        if (options.tls) {
            server = tls.createServer(
                { cert: options.tls.cert, key: options.tls.key, rejectUnauthorized: false },
                onConnection
            );
        } else {
            server = net.createServer(onConnection);
        }
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (typeof addr === 'string' || addr === null) {
                reject(new Error('stub mysql failed to bind'));
                return;
            }
            const handle: StubMysqlHandle = {
                host: addr.address,
                port: addr.port,
                listening: Promise.resolve(),
                async close() {
                    for (const s of sockets) {
                        try { s.destroy(); } catch { /* ignore */ }
                    }
                    await new Promise<void>((res) => server.close(() => res()));
                },
                authAttempts: () => stats.attempts,
                authSuccesses: () => stats.successes,
                lastUsername: () => stats.lastUsername,
                lastJwt: () => stats.lastJwt,
                lastRejectReason: () => stats.lastRejectReason,
            };
            resolve(handle);
        });
    });
}

async function handleConnection(
    socket: net.Socket,
    options: StubMysqlOptions,
    stats: {
        attempts: number;
        successes: number;
        lastUsername: string | undefined;
        lastJwt: string | undefined;
        lastRejectReason: string | undefined;
    },
    authTimeoutMs: number
): Promise<void> {
    stats.attempts += 1;
    const connId = crypto.randomBytes(4).readUInt32LE(0);
    const authData = crypto.randomBytes(20);

    // --- Send server greeting (handshake v10). ---
    socket.write(buildGreeting(connId, authData));

    // --- Read client handshake response. ---
    const handshakeResponse = await readPacket(socket, authTimeoutMs);
    if (!handshakeResponse) {
        sendErrorPacket(socket, 2, ER_ACCESS_DENIED, 'client did not respond to handshake');
        stats.lastRejectReason = 'handshake timeout';
        socket.end();
        return;
    }
    const parsed = parseHandshakeResponse(handshakeResponse);
    if (process.env['STUB_MYSQL_DEBUG']) {
        const fullHex = handshakeResponse.toString('hex');
        console.log('[stub-mysql] raw handshake response hex:', fullHex);
        console.log('[stub-mysql] parsed:', JSON.stringify({
            username: parsed.username,
            authResponseLen: parsed.authResponse.length,
            authResponseBytes: Buffer.from(parsed.authResponse, 'binary').toString('hex'),
            authPluginName: parsed.authPluginName,
            database: parsed.database,
        }));
    }
    if (parsed.error) {
        sendErrorPacket(socket, 2, ER_ACCESS_DENIED, parsed.error);
        stats.lastRejectReason = parsed.error;
        socket.end();
        return;
    }
    stats.lastUsername = parsed.username;
    stats.lastJwt = parsed.authResponse;
    // eslint-disable-next-line no-console
    if (process.env['STUB_MYSQL_DEBUG']) {
        const hex = Buffer.from(parsed.authResponse, 'binary').toString('hex');
        console.log('[stub-mysql] username=', parsed.username, 'authPlugin=', parsed.authPluginName, 'database=', parsed.database, 'responseLen=', parsed.authResponse.length, 'responseHex=', hex.slice(0, 80));
    }

    // The production `defaultPoolFactory` registers a custom
    // `authPlugins.mysql_clear_password` closure, which forces mysql2
    // to fall back to the auth-switch dance:
    //   1. Client sends initial handshake with mysql_native_password-style data
    //   2. Server sends auth-switch request to mysql_clear_password
    //   3. Client invokes the custom plugin and sends the JWT
    //   4. Server validates and replies OK
    const needsAuthSwitch =
        parsed.authPluginName !== AUTH_PLUGIN_NAME &&
        (parsed.authPluginName === undefined ||
            parsed.authPluginName === 'mysql_native_password' ||
            parsed.authPluginName === 'caching_sha2_password');
    let jwt = '';
    if (needsAuthSwitch) {
        // Send auth switch request: 0xfe + plugin_name\0
        // For mysql_clear_password, no scramble data follows the NUL.
        const switchBody = Buffer.concat([
            Buffer.from([0xfe]),
            Buffer.from(AUTH_PLUGIN_NAME + '\0', 'utf8'),
        ]);
        socket.write(wrapPacket(2, switchBody));

        // Read the new auth response from the client.
        const switchResponse = await readPacket(socket, authTimeoutMs);
        if (!switchResponse) {
            sendErrorPacket(socket, 2, ER_ACCESS_DENIED, 'no response to auth switch');
            stats.lastRejectReason = 'auth switch timeout';
            socket.end();
            return;
        }
        // The response is the JWT followed by NUL (per mysql_clear_password).
        jwt = switchResponse.toString('binary').replace(/\0$/, '');
        stats.lastJwt = jwt;
    } else {
        // Direct path (when client uses `enableCleartextPlugin: true`).
        jwt = parsed.authResponse.replace(/\0$/, '');
    }
    if (!jwt) {
        sendErrorPacket(socket, 2, ER_ACCESS_DENIED, 'mysql_clear_password expects JWT');
        stats.lastRejectReason = 'no auth response';
        socket.end();
        return;
    }
    const verified = verifyStubJwt(jwt, options.keyPair.publicKey);
    if (!verified.ok) {
        stats.lastRejectReason = verified.reason;
        sendErrorPacket(socket, 2, ER_ACCESS_DENIED, `JWT verification failed: ${verified.reason}`);
        socket.end();
        return;
    }
    if (verified.payload.aud !== AZURE_MYSQL_ENTRA_AUDIENCE) {
        stats.lastRejectReason = 'audience mismatch';
        sendErrorPacket(socket, 2, ER_ACCESS_DENIED,
            `JWT audience is ${String(verified.payload.aud)}, expected ${AZURE_MYSQL_ENTRA_AUDIENCE}`);
        socket.end();
        return;
    }
    if (verified.payload.tid !== options.tenantId) {
        stats.lastRejectReason = 'tenant mismatch';
        sendErrorPacket(socket, 2, ER_ACCESS_DENIED,
            `JWT tenant is ${String(verified.payload.tid)}, expected ${options.tenantId}`);
        socket.end();
        return;
    }
    stats.successes += 1;

    // --- Auth OK packet. After the auth switch dance the sequence is
    //     greeting=0, client handshake=1, server auth switch req=2,
    //     client auth switch response=3, server auth OK=4. When the
    //     client took the direct path there's no auth switch, so the
    //     OK is at seq 2. ---
    const authOkSeq = needsAuthSwitch ? 4 : 2;
    const okPacket = buildOkPacket(authOkSeq, 0, 0);
    if (process.env['STUB_MYSQL_DEBUG']) {
        console.log('[stub-mysql] sending auth OK, seq=', authOkSeq);
    }
    socket.write(okPacket);

    // --- Command loop. Sequence resets to 0 for each new command. ---
    while (!socket.destroyed) {
        const packet = await readPacket(socket, authTimeoutMs);
        if (!packet) {
            return;
        }
        const cmd = packet[0];
        if (cmd === 0x01) {
            // COM_QUIT
            socket.end();
            return;
        }
        if (cmd === 0x0e) {
            // COM_PING -> OK at seq 1
            socket.write(buildOkPacket(1, 0, 0));
            continue;
        }
        if (cmd === 0x03) {
            // COM_QUERY
            const sql = packet.slice(1).toString('utf8').trim();
            handleQuery(socket, sql);
            continue;
        }
        if (cmd === 0x1b) {
            // COM_RESET_CONNECTION
            socket.write(buildOkPacket(1, 0, 0));
            continue;
        }
        if (cmd === 0x16) {
            // COM_SET_OPTION (mysql2 sends this during connection setup to
            // declare multi-statement support). Acknowledge and move on.
            socket.write(buildOkPacket(1, 0, 0));
            continue;
        }
        if (cmd === 0x19) {
            // COM_STMT_PREPARE — modern mysql2 uses prepared statements for
            // some operations. Acknowledge with a simple OK.
            socket.write(buildOkPacket(1, 0, 0));
            continue;
        }
        sendErrorPacket(socket, 1, ER_NOT_SUPPORTED_YET, `unsupported command 0x${cmd.toString(16)}`);
    }
}

function handleQuery(socket: net.Socket, sql: string): void {
    if (process.env['STUB_MYSQL_DEBUG']) {
        console.log('[stub-mysql] COM_QUERY:', sql);
    }
    const upper = sql.replace(/\s+/g, ' ').trim().toUpperCase();
    if (upper === 'SELECT 1') {
        sendResultSet(socket, [{ name: '1', type: 3 }], [['1']]);
        return;
    }
    if (upper === 'SELECT 1+1 AS SUM' || upper === 'SELECT 1 + 1 AS SUM') {
        sendResultSet(socket, [{ name: 'sum', type: 8 }], [['2']]);
        return;
    }
    if (upper === 'SELECT DATABASE()') {
        sendResultSet(socket, [{ name: 'DATABASE()', type: 253 }], [['NULL']]);
        return;
    }
    if (upper === 'SHOW DATABASES') {
        sendResultSet(
            socket,
            [{ name: 'Database', type: 253 }],
            [['information_schema'], ['mysql'], ['test_db']]
        );
        return;
    }
    if (upper === 'SET SESSION TRANSACTION READ ONLY') {
        socket.write(buildOkPacket(1, 0, 0));
        return;
    }
    if (upper === 'SELECT @@VERSION_COMMENT') {
        sendResultSet(socket, [{ name: '@@version_comment', type: 253 }], [['stub-mysql']]);
        return;
    }
    sendErrorPacket(socket, 1, ER_NOT_SUPPORTED_YET, `stub mysql does not implement: ${sql}`);
}

function buildGreeting(connectionId: number, authData: Buffer): Buffer {
    const authData1 = authData.subarray(0, 8);
    const authData2 = authData.subarray(8);
    const lowerCaps = CAPABILITY_FLAGS & 0xffff;
    const upperCaps = (CAPABILITY_FLAGS >>> 16) & 0xffff;

    const payload: Buffer[] = [
        Buffer.from([0x0a]), // protocol version 10
        Buffer.from(SERVER_VERSION + '\0', 'utf8'),
        Buffer.from([
            connectionId & 0xff,
            (connectionId >>> 8) & 0xff,
            (connectionId >>> 16) & 0xff,
            (connectionId >>> 24) & 0xff,
        ]),
        authData1,
        Buffer.from([0x00]), // filler
        Buffer.from([lowerCaps & 0xff, (lowerCaps >>> 8) & 0xff]),
        Buffer.from([0x21]), // charset utf8_general_ci
        Buffer.from([0x02, 0x00]), // status flags SERVER_STATUS_AUTOCOMMIT
        Buffer.from([upperCaps & 0xff, (upperCaps >>> 8) & 0xff]),
        Buffer.from([authData1.length + authData2.length + 1]), // auth_plugin_data_len
        Buffer.alloc(10), // 10 reserved bytes
        authData2,
        Buffer.from([0x00]), // NUL terminator for authData2
        Buffer.from(AUTH_PLUGIN_NAME + '\0', 'utf8'),
    ];
    return wrapPacket(0, Buffer.concat(payload));
}

function parseHandshakeResponse(buf: Buffer): {
    username: string;
    authResponse: string;
    database?: string;
    authPluginName?: string;
    error?: string;
} {
    try {
        let offset = 0;
        const clientFlags = buf.readUInt32LE(offset); offset += 4;
        offset += 4; // max packet size
        offset += 1; // charset
        offset += 23; // reserved

        const nul = buf.indexOf(0, offset);
        if (nul < 0) {
            return { username: '', authResponse: '', error: 'malformed: missing username NUL' };
        }
        const username = buf.slice(offset, nul).toString('utf8');
        offset = nul + 1;

        const authLen = lenEncIntAt(buf, offset);
        if (authLen.error) {
            return { username, authResponse: '', error: authLen.error };
        }
        offset += authLen.consumed;
        const authBuf = buf.slice(offset, offset + authLen.value);
        const authResponse = authBuf.toString('binary');
        offset += authLen.value;

        let database: string | undefined;
        if ((clientFlags & 0x00000008) !== 0) {
            const nul2 = buf.indexOf(0, offset);
            if (nul2 < 0) {
                return { username, authResponse, error: 'malformed: missing database NUL' };
            }
            database = buf.slice(offset, nul2).toString('utf8');
            offset = nul2 + 1;
        }

        let authPluginName: string | undefined;
        if ((clientFlags & 0x00080000) !== 0) {
            const nul3 = buf.indexOf(0, offset);
            if (nul3 < 0) {
                return { username, authResponse, database, error: 'malformed: missing plugin NUL' };
            }
            authPluginName = buf.slice(offset, nul3).toString('utf8');
        }
        if (process.env['STUB_MYSQL_DEBUG']) {
            console.log('[stub-mysql parse] clientFlags=0x' + clientFlags.toString(16),
                'hasDB=', (clientFlags & 0x08) !== 0, 'hasPlugin=', (clientFlags & 0x00080000) !== 0,
                'username=', JSON.stringify(username), 'authLen=', authLen.value,
                'database=', JSON.stringify(database), 'authPluginName=', JSON.stringify(authPluginName));
        }
        return { username, authResponse, database, authPluginName };
    } catch (err) {
        return { username: '', authResponse: '', error: `parse error: ${(err as Error).message}` };
    }
}

function lenEncIntAt(buf: Buffer, offset: number): { value: number; consumed: number; error?: string } {
    if (offset >= buf.length) return { value: 0, consumed: 0, error: 'short read' };
    const first = buf[offset];
    if (first < 0xfb) return { value: first, consumed: 1 };
    if (first === 0xfc) {
        if (offset + 3 > buf.length) return { value: 0, consumed: 0, error: 'short 2-byte lenenc' };
        return { value: buf.readUInt16LE(offset + 1), consumed: 3 };
    }
    if (first === 0xfd) {
        if (offset + 4 > buf.length) return { value: 0, consumed: 0, error: 'short 3-byte lenenc' };
        return { value: buf.readUIntLE(offset + 1, 3), consumed: 4 };
    }
    if (first === 0xfe) {
        if (offset + 9 > buf.length) return { value: 0, consumed: 0, error: 'short 8-byte lenenc' };
        return { value: Number(buf.readBigUInt64LE(offset + 1)), consumed: 9 };
    }
    return { value: 0, consumed: 0, error: 'reserved lenenc first byte' };
}

function readPacket(socket: net.Socket, timeoutMs: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        let buffer = Buffer.alloc(0);
        let settled = false;

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
        };
        const done = (value: Buffer | null) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (value && buffer.length > 4 + value.length) {
                socket.unshift(buffer.slice(4 + value.length));
            }
            resolve(value);
        };
        const onError = () => done(null);
        const onClose = () => done(null);
        const onData = (chunk: Buffer) => {
            buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
            if (buffer.length < 4) return;
            const bodyLen = buffer.readUIntLE(0, 3);
            if (buffer.length < 4 + bodyLen) return;
            const body = buffer.slice(4, 4 + bodyLen);
            buffer = buffer.slice(4 + bodyLen);
            done(body);
        };
        if (timeoutMs > 0) {
            timer = setTimeout(() => done(null), timeoutMs);
        }
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
    });
}

function wrapPacket(seq: number, body: Buffer): Buffer {
    const header = Buffer.alloc(4);
    header.writeUIntLE(body.length, 0, 3);
    header[3] = seq & 0xff;
    return Buffer.concat([header, body]);
}

function buildOkPacket(seq: number, affectedRows: number, lastInsertId: number): Buffer {
    const body = Buffer.concat([
        Buffer.from([0x00]), // OK marker
        lenEncInt(affectedRows),
        lenEncInt(lastInsertId),
        Buffer.from([0x02, 0x00]), // status flags SERVER_STATUS_AUTOCOMMIT
        Buffer.from([0x00, 0x00]), // warnings
    ]);
    return wrapPacket(seq, body);
}

function sendErrorPacket(socket: net.Socket, seq: number, code: number, message: string): void {
    const sqlState = 'HY000';
    const body = Buffer.concat([
        Buffer.from([0xff]),
        Buffer.from([code & 0xff, (code >>> 8) & 0xff]),
        Buffer.from('#', 'utf8'),
        Buffer.from(sqlState, 'utf8'),
        Buffer.from(message, 'utf8'),
    ]);
    socket.write(wrapPacket(seq, body));
}

function sendResultSet(
    socket: net.Socket,
    columns: { name: string; type: number }[],
    rows: string[][]
): void {
    // After COM_QUERY, sequence resets to 0 for the column count packet.
    // Each subsequent packet increments.
    let seq = 1;
    socket.write(wrapPacket(seq++, Buffer.from([columns.length])));

    for (const col of columns) {
        const colBody = Buffer.concat([
            lenEncString('def'),
            lenEncString(''),
            lenEncString(''),
            lenEncString(''),
            lenEncString(col.name),
            lenEncString(''),
            Buffer.from([0x0c]), // filler
            Buffer.from([0x21]), // charset utf8_general_ci
            Buffer.from([0, 0, 0, 0]), // column length
            Buffer.from([col.type & 0xff]),
            Buffer.from([0, 0]), // flags
            Buffer.from([0]), // decimals
            Buffer.from([0, 0]), // filler
        ]);
        socket.write(wrapPacket(seq++, colBody));
    }

    // EOF between columns and rows. Old-style: 0xfe + 2-byte warnings + 2-byte status = 5 bytes.
    socket.write(wrapPacket(seq++, Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00])));

    for (const row of rows) {
        const rowBody = Buffer.concat(row.map((cell) => lenEncString(cell)));
        socket.write(wrapPacket(seq++, rowBody));
    }

    // Final EOF
    socket.write(wrapPacket(seq, Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00])));
}

function lenEncInt(value: number): Buffer {
    if (value < 0xfb) return Buffer.from([value]);
    if (value < 0x10000) {
        const buf = Buffer.alloc(3);
        buf[0] = 0xfc;
        buf.writeUInt16LE(value, 1);
        return buf;
    }
    if (value < 0x1000000) {
        const buf = Buffer.alloc(4);
        buf[0] = 0xfd;
        buf.writeUIntLE(value, 1, 3);
        return buf;
    }
    const buf = Buffer.alloc(9);
    buf[0] = 0xfe;
    buf.writeBigUInt64LE(BigInt(value), 1);
    return buf;
}

function lenEncString(s: string): Buffer {
    if (s === 'NULL' || s === 'null') {
        return Buffer.from([0xfb]); // SQL NULL marker
    }
    const bytes = Buffer.from(s, 'utf8');
    return Buffer.concat([lenEncInt(bytes.length), bytes]);
}
