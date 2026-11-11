import { authenticator } from "otplib";
import QRCode from "qrcode";

/**
 * TOTP helpers (RFC 6238) via otplib. Pure — no env/server-only — so the
 * verification window behavior can be unit-tested.
 */

// Allow +/- 1 step (30s) of clock drift.
authenticator.options = { window: 1, step: 30 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpKeyUri(
  secret: string,
  accountName: string,
  issuer = "Xiero Nexus AI",
): string {
  return authenticator.keyuri(accountName, issuer, secret);
}

export function verifyTotp(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token: token.trim(), secret });
  } catch {
    return false;
  }
}

export async function qrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { margin: 1, width: 220 });
}
