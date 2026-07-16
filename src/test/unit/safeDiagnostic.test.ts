/**
 * Tests for src/identity/safeDiagnostic.ts — the release-safe diagnostic
 * formatter. The formatter is the single source of truth for what
 * leaves the process boundary: only the allowlisted fields
 * (operation, credentialSource, elapsedMs, errorClass, mysqlErrorCode,
 * connectionState, retryCount) survive the round-trip, and every
 * string value must look like an enum/code label rather than a raw
 * payload.
 */

import * as assert from 'assert';
import safeDiagnostic, {
    formatDiagnostic,
    formatDiagnosticBatch,
    getAllowlist,
} from '../../identity/safeDiagnostic';
import type { SafeDiagnosticInput } from '../../identity/safeDiagnostic';

type ErrorWithCode = Error & { code?: string };

function catchAsErrorWithCode(block: () => unknown): ErrorWithCode | null {
    try {
        block();
    } catch (err: unknown) {
        return err as ErrorWithCode;
    }
    return null;
}

function codeOf(caught: ErrorWithCode | null): string | undefined {
    return caught ? caught.code : undefined;
}

suite('safeDiagnostic - formatDiagnostic allowlist enforcement', () => {
    test('(a) allowed input passes through unchanged with all expected fields', () => {
        const input: SafeDiagnosticInput = {
            operation: 'identity:vscode:success',
            credentialSource: 'vscode',
            elapsedMs: 42,
            errorClass: 'class:credential_error',
            mysqlErrorCode: 'ER_ACCESS_DENIED_ERROR',
            connectionState: 'connected',
            retryCount: 1,
        };
        const out = formatDiagnostic(input);
        assert.deepStrictEqual(out, {
            operation: 'identity:vscode:success',
            credentialSource: 'vscode',
            elapsedMs: 42,
            errorClass: 'class:credential_error',
            mysqlErrorCode: 'ER_ACCESS_DENIED_ERROR',
            connectionState: 'connected',
            retryCount: 1,
        });
    });

    test('(a2) allowed input with only required fields passes through with just those keys', () => {
        const out = formatDiagnostic({
            operation: 'minimal',
            credentialSource: 'unknown',
        });
        assert.deepStrictEqual(out, {
            operation: 'minimal',
            credentialSource: 'unknown',
        });
    });

    test('(b) Bearer <token> substring returns RangeError with code BEARER_LEAK', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'Authorization: Bearer abc.def.ghi-jkl_mno=pqr',
                credentialSource: 'unknown',
            })
        );
        assert.ok(caught instanceof RangeError, 'expected RangeError');
        assert.strictEqual(codeOf(caught), 'BEARER_LEAK');
    });

    test('(b2) Bearer in errorClass field also triggers BEARER_LEAK', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'op',
                credentialSource: 'unknown',
                errorClass: 'Bearer x.y.z',
            })
        );
        assert.ok(caught instanceof RangeError, 'expected RangeError');
        assert.strictEqual(codeOf(caught), 'BEARER_LEAK');
    });

    test('(c) literal <user@host> returns RangeError with code EMAIL_LEAK', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'identity:vscode:failure',
                credentialSource: 'vscode',
                errorClass: 'wrapped <someone@example.com> principal',
            })
        );
        assert.ok(caught instanceof RangeError, 'expected RangeError');
        assert.strictEqual(codeOf(caught), 'EMAIL_LEAK');
    });

    test('(d) unknown field "secret" returns TypeError with code UNKNOWN_FIELD', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'op',
                credentialSource: 'unknown',
                secret: 'shhh',
            } as unknown as SafeDiagnosticInput)
        );
        assert.ok(caught instanceof TypeError, 'expected TypeError');
        assert.strictEqual(codeOf(caught), 'UNKNOWN_FIELD');
    });

    test('(d2) unknown field "token" returns TypeError with code UNKNOWN_FIELD', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'op',
                credentialSource: 'unknown',
                token: 'Bearer abc',
            } as unknown as SafeDiagnosticInput)
        );
        assert.ok(caught instanceof TypeError, 'expected TypeError');
        assert.strictEqual(codeOf(caught), 'UNKNOWN_FIELD');
    });

    test('(e) extra field not in allowlist returns TypeError even when value is benign', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'op',
                credentialSource: 'unknown',
                host: 'foo.mysql.database.azure.com',
            } as unknown as SafeDiagnosticInput)
        );
        assert.ok(caught instanceof TypeError, 'expected TypeError');
        assert.strictEqual(codeOf(caught), 'UNKNOWN_FIELD');
    });

    test('(bonus) password= substring triggers ASSIGNMENT_LEAK', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'op',
                credentialSource: 'unknown',
                errorClass: 'password=hunter2',
            })
        );
        assert.ok(caught instanceof RangeError, 'expected RangeError');
        assert.strictEqual(codeOf(caught), 'ASSIGNMENT_LEAK');
    });

    test('(bonus) SQL boundary keyword in operation triggers SQL_LEAK', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'SELECT 1',
                credentialSource: 'unknown',
            })
        );
        assert.ok(caught instanceof RangeError, 'expected RangeError');
        assert.strictEqual(codeOf(caught), 'SQL_LEAK');
    });

    test('(bonus) non-integer elapsedMs triggers INVALID_TYPE', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'op',
                credentialSource: 'unknown',
                elapsedMs: 1.5,
            })
        );
        assert.ok(caught instanceof TypeError, 'expected TypeError');
        assert.strictEqual(codeOf(caught), 'INVALID_TYPE');
    });

    test('(bonus) invalid credentialSource triggers INVALID_TYPE', () => {
        const caught = catchAsErrorWithCode(() =>
            formatDiagnostic({
                operation: 'op',
                credentialSource: 'vault' as SafeDiagnosticInput['credentialSource'],
            })
        );
        assert.ok(caught instanceof TypeError, 'expected TypeError');
        assert.strictEqual(codeOf(caught), 'INVALID_TYPE');
    });
});

suite('safeDiagnostic - formatDiagnosticBatch atomicity', () => {
    test('(f) batch with all valid events returns the full allowlisted list', () => {
        const events: SafeDiagnosticInput[] = [
            { operation: 'op1', credentialSource: 'vscode' },
            { operation: 'op2', credentialSource: 'azureCli', elapsedMs: 10 },
            { operation: 'op3', credentialSource: 'unknown', retryCount: 0 },
        ];
        const out = formatDiagnosticBatch(events);
        assert.strictEqual(out.length, 3);
        const first = out[0];
        const second = out[1];
        const third = out[2];
        assert.ok(first && second && third, 'batch must contain all three events');
        assert.strictEqual(first.operation, 'op1');
        assert.strictEqual(second.credentialSource, 'azureCli');
        assert.strictEqual(second.elapsedMs, 10);
        assert.strictEqual(third.retryCount, 0);
    });

    test('(f2) batch rejects the whole batch on any single failure', () => {
        const events: SafeDiagnosticInput[] = [
            { operation: 'op1', credentialSource: 'vscode' },
            { operation: 'op2', credentialSource: 'azureCli' },
            // This one carries a Bearer token; the batch must abort here
            // and the first two events must NOT be returned.
            {
                operation: 'Bearer abc.def.ghi',
                credentialSource: 'unknown',
            } as SafeDiagnosticInput,
        ];
        const caught = catchAsErrorWithCode(() => formatDiagnosticBatch(events));
        assert.ok(caught instanceof TypeError, 'expected TypeError from batch wrapper');
        assert.strictEqual(codeOf(caught), 'BEARER_LEAK');
        assert.match(caught && caught.message ? caught.message : '', /events\[2\] rejected/);
    });

    test('(f3) empty batch returns an empty array', () => {
        const out = formatDiagnosticBatch([]);
        assert.deepStrictEqual(out, []);
    });
});

suite('safeDiagnostic - getAllowlist and default export', () => {
    test('getAllowlist returns the canonical 7-key allowlist in deterministic order', () => {
        const list = getAllowlist();
        assert.deepStrictEqual([...list], [
            'operation',
            'credentialSource',
            'elapsedMs',
            'errorClass',
            'mysqlErrorCode',
            'connectionState',
            'retryCount',
        ]);
    });

    test('getAllowlist returns a frozen array', () => {
        const list = getAllowlist();
        assert.ok(Object.isFrozen(list));
    });

    test('default export safeDiagnostic is a callable alias for formatDiagnostic', () => {
        const a = safeDiagnostic({
            operation: 'op',
            credentialSource: 'unknown',
        });
        const b = formatDiagnostic({
            operation: 'op',
            credentialSource: 'unknown',
        });
        assert.deepStrictEqual(a, b);
    });

    test('default export rejects Bearer leaks identically to named export', () => {
        let caught: (Error & { code?: string }) | null = null;
        try {
            safeDiagnostic({
                operation: 'Bearer abc',
                credentialSource: 'unknown',
            });
        } catch (err: unknown) {
            caught = err as Error & { code?: string };
        }
        assert.strictEqual(caught?.code, 'BEARER_LEAK');
    });
});