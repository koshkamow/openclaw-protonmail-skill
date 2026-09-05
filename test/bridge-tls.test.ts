/**
 * Tests for the Bridge TLS options.
 *
 * The bug these guard against is silent: Bun checks the certificate against a
 * default of "localhost" instead of the host that was dialled, and the only
 * symptom is a failed handshake. The point of the helper is that identity is
 * still checked — so the tests assert that a wrong certificate is still
 * rejected, not merely that a right one passes.
 */

import { describe, expect, it } from 'bun:test';
import type { PeerCertificate } from 'node:tls';

import { bridgeTlsOptions } from '../src/bridge-tls';

/** A certificate naming only the IP 127.0.0.1, as Bridge's does. */
function bridgeCert(): PeerCertificate {
  return {
    subject: { CN: '127.0.0.1' },
    issuer: { CN: '127.0.0.1' },
    subjectaltname: 'IP Address:127.0.0.1',
  } as unknown as PeerCertificate;
}

/** A certificate for some other host entirely. */
function foreignCert(): PeerCertificate {
  return {
    subject: { CN: 'mail.example.com' },
    issuer: { CN: 'Example CA' },
    subjectaltname: 'DNS:mail.example.com',
  } as unknown as PeerCertificate;
}

describe('bridgeTlsOptions()', () => {
  it('accepts a certificate naming the host that was dialled', () => {
    const { checkServerIdentity } = bridgeTlsOptions('127.0.0.1');
    expect(checkServerIdentity('ignored', bridgeCert())).toBeUndefined();
  });

  it('ignores the servername argument, which is the value Bun gets wrong', () => {
    const { checkServerIdentity } = bridgeTlsOptions('127.0.0.1');
    // Bun passes "localhost" here; the check must not be misled by it.
    expect(checkServerIdentity('localhost', bridgeCert())).toBeUndefined();
  });

  it('still rejects a certificate for a different host', () => {
    const { checkServerIdentity } = bridgeTlsOptions('127.0.0.1');
    const error = checkServerIdentity('127.0.0.1', foreignCert());

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('altnames');
  });

  it("rejects Bridge's certificate when a different host was configured", () => {
    const { checkServerIdentity } = bridgeTlsOptions('192.0.2.10');
    expect(checkServerIdentity('192.0.2.10', bridgeCert())).toBeInstanceOf(Error);
  });
});
