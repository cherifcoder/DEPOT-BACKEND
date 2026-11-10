import { randomBytes, randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSegment(length = 5): string {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return output;
}

function dateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Reference lisible et unique : VTE-20261023-K7M2P */
export function makeReference(prefix: 'VTE' | 'ACH' | 'LIV' | 'PRT' | 'DEP' | 'REC', date = new Date()): string {
  return `${prefix}-${dateStamp(date)}-${randomSegment()}`;
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('hex');
}

export function randomPassword(length = 12): string {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%&*';
  const all = lower + upper + digits + symbols;

  const required = [
    lower[randomInt(0, lower.length)],
    upper[randomInt(0, upper.length)],
    digits[randomInt(0, digits.length)],
    symbols[randomInt(0, symbols.length)],
  ];

  const remaining = Array.from({ length: Math.max(0, length - required.length) }, () =>
    all.charAt(randomInt(0, all.length)),
  );

  return [...required, ...remaining].sort(() => Math.random() - 0.5).join('');
}
