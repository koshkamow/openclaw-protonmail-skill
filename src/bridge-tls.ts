/**
 * TLS options for talking to Proton Mail Bridge under Bun.
 *
 * @packageDocumentation
 *
 * @remarks
 * Bridge presents a self-signed certificate whose only subjectAltName is the
 * IP address `127.0.0.1`. Trusting it is the caller's job, via
 * `NODE_EXTRA_CA_CERTS` pointing at Bridge's exported CA — Bun honours that
 * variable, so the chain verifies.
 *
 * What Bun does *not* do is use the `host` option when checking that the
 * certificate belongs to the machine we reached. On an upgraded socket — the
 * STARTTLS path both IMAP and SMTP take — Bun checks against a default of
 * `localhost`, which the certificate does not name, and the handshake fails:
 *
 * ```
 * ERR_TLS_CERT_ALTNAME_INVALID
 * Hostname/IP does not match certificate's altnames:
 *   Host: localhost. is not cert's CN: 127.0.0.1
 * ```
 *
 * Node passes `host` through and succeeds. Measured on Bun 1.3.14 and Node
 * 24.18.0 against Bridge 03.25.00.
 *
 * The fix is to name the host explicitly, by running Node's own
 * {@link tls.checkServerIdentity} against the host we configured. Verification
 * stays fully on: the chain is still validated against the CA, and the
 * certificate must still name the host we actually connected to. This is the
 * standard check with the right argument, not a bypass — nothing here sets
 * `rejectUnauthorized: false`.
 */

import tls from 'tls';
import type { PeerCertificate } from 'tls';

/**
 * TLS options that verify Bridge's certificate correctly on both runtimes.
 *
 * @param host - The host the connection was opened to, e.g. `127.0.0.1`
 * @returns Options to merge into a `tls.connect` / nodemailer / ImapFlow config
 *
 * @example
 * ```typescript
 * nodemailer.createTransport({
 *   host: '127.0.0.1',
 *   port: 1025,
 *   secure: false,
 *   requireTLS: true,
 *   tls: bridgeTlsOptions('127.0.0.1'),
 * });
 * ```
 */
export function bridgeTlsOptions(host: string): {
  checkServerIdentity: (servername: string, cert: PeerCertificate) => Error | undefined;
} {
  return {
    // `servername` is ignored on purpose: it is the value Bun gets wrong.
    // `host` is what we dialled, and what the certificate must name.
    checkServerIdentity: (_servername: string, cert: PeerCertificate) =>
      tls.checkServerIdentity(host, cert),
  };
}
