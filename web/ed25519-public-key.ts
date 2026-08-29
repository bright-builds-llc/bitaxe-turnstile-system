import { decodeBase64Url, encodeBase64Url } from "./crypto-bytes";

const ED25519_FIELD_PRIME = (1n << 255n) - 19n;
const ED25519_SUBGROUP_ORDER =
  (1n << 252n) + 27742317777372353535851937790883648493n;
const ED25519_D = field(
  -121665n * fieldPower(121666n, ED25519_FIELD_PRIME - 2n),
);
const ED25519_SQRT_M1 = fieldPower(2n, (ED25519_FIELD_PRIME - 1n) / 4n);
const ED25519_IDENTITY: EdwardsPoint = { x: 0n, y: 1n };

type EdwardsPoint = { x: bigint; y: bigint };

/** Returns whether an input is one canonical, non-identity, prime-subgroup Ed25519 key. */
export function isCanonicalPrimeSubgroupEd25519PublicKey(
  input: unknown,
): input is string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input)) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(input, 43, "Ed25519 public key is invalid");
  } catch {
    return false;
  }
  if (bytes.byteLength !== 32 || encodeBase64Url(bytes) !== input) return false;

  const encoded = littleEndianInteger(bytes);
  const sign = encoded >> 255n;
  const y = encoded & ((1n << 255n) - 1n);
  if (y >= ED25519_FIELD_PRIME) return false;
  const maybePoint = maybeDecompressEd25519(y, sign);
  if (!maybePoint || pointsEqual(maybePoint, ED25519_IDENTITY)) return false;
  return pointsEqual(
    scalarMultiply(maybePoint, ED25519_SUBGROUP_ORDER),
    ED25519_IDENTITY,
  );
}

function maybeDecompressEd25519(
  y: bigint,
  sign: bigint,
): EdwardsPoint | undefined {
  const ySquared = field(y * y);
  const numerator = field(ySquared - 1n);
  const denominator = field(ED25519_D * ySquared + 1n);
  const xSquared = field(
    numerator * fieldPower(denominator, ED25519_FIELD_PRIME - 2n),
  );
  let x = fieldPower(xSquared, (ED25519_FIELD_PRIME + 3n) / 8n);
  if (field(x * x) !== xSquared) x = field(x * ED25519_SQRT_M1);
  if (field(x * x) !== xSquared) return undefined;
  if (x === 0n && sign === 1n) return undefined;
  if ((x & 1n) !== sign) x = field(-x);
  return { x, y };
}

function scalarMultiply(point: EdwardsPoint, scalar: bigint): EdwardsPoint {
  let result = ED25519_IDENTITY;
  let addend = point;
  let remaining = scalar;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = addPoints(result, addend);
    addend = addPoints(addend, addend);
    remaining >>= 1n;
  }
  return result;
}

function addPoints(left: EdwardsPoint, right: EdwardsPoint): EdwardsPoint {
  const product = field(ED25519_D * left.x * right.x * left.y * right.y);
  const xNumerator = field(left.x * right.y + left.y * right.x);
  const yNumerator = field(left.y * right.y + left.x * right.x);
  return {
    x: field(
      xNumerator * fieldPower(field(1n + product), ED25519_FIELD_PRIME - 2n),
    ),
    y: field(
      yNumerator * fieldPower(field(1n - product), ED25519_FIELD_PRIME - 2n),
    ),
  };
}

function pointsEqual(left: EdwardsPoint, right: EdwardsPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function littleEndianInteger(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index];
    if (byte === undefined) return 0n;
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function field(value: bigint): bigint {
  const reduced = value % ED25519_FIELD_PRIME;
  return reduced < 0n ? reduced + ED25519_FIELD_PRIME : reduced;
}

function fieldPower(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let factor = field(base);
  let remaining = exponent;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = field(result * factor);
    factor = field(factor * factor);
    remaining >>= 1n;
  }
  return result;
}
