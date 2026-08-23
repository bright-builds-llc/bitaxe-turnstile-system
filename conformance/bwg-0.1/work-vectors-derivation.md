# BWG/0.1 Work Vector Derivation

This artifact independently works the expected values published in `work-vectors.json`. It does not use the Rust implementation under test.

For an assigned target `T`, let `D = T + 1`. Euclidean division gives unique integers `W` and `R` such that:

```text
2^256 = W * D + R, where 0 <= R < D
```

Therefore `W = floor(2^256 / (T + 1))`. This is the same integer identity used by the pinned Bitcoin Core `GetBitsProof` source. The JSON value is decimal `W`; the binary value is `W` encoded as 32 unsigned big-endian bytes. Equivalent Binary-Zero Work is the display-only value `log2(W)`, rounded to 12 fractional digits in the fixture.

## Bitcoin difficulty one

- `T`: `00000000ffff0000000000000000000000000000000000000000000000000000`
- `D`: `26959535291011309493156476344723991336010898738574164086137773096961`
- `W`: `4295032833`
- `R`: `411376139330301510538742295639337626245683966408394961542119423`
- 32-byte `W`: `0000000000000000000000000000000000000000000000000000000100010001`
- `log2(W)`: `32.000022013947`

## Light preset

The target is `2^214 - 1`, so `D = 2^214` divides `2^256` exactly.

- `T`: `00000000003fffffffffffffffffffffffffffffffffffffffffffffffffffff`
- `D`: `26328072917139296674479506920917608079723773850137277813577744384`
- `W`: `2^42 = 4398046511104`
- `R`: `0`
- 32-byte `W`: `0000000000000000000000000000000000000000000000000000040000000000`
- `log2(W)`: `42.000000000000`

## Fractional display

- `T`: `00000000000abcde000000000000000000000000000000000000000000000000`
- `D`: `4417259262208961120318883375005466933675388549823785727070044161`
- `W`: `26213559667632`
- `R`: `1487020292706163126229643171200203343308983595371725706407343184`
- 32-byte `W`: `000000000000000000000000000000000000000000000000000017d751e98bb0`
- `log2(W)`: `44.575378511129`

## Boundary targets

For the maximum target, `T = 2^256 - 1`, so `D = 2^256`, `W = 1`, and `R = 0`. Its 32-byte work encoding ends in `01`, and `log2(W) = 0`.

For the minimum non-zero target, `T = 1`, so `D = 2`, `W = 2^255`, and `R = 0`:

- `W`: `57896044618658097711785492504343953926634992332820282019728792003956564819968`
- 32-byte `W`: `8000000000000000000000000000000000000000000000000000000000000000`
- `log2(W)`: `255.000000000000`

## Accumulation and overflow

The accumulation example is ordinary exact integer addition:

```text
4398046511104 + 4295032833 = 4402341543937
```

Its 32-byte big-endian encoding is `0000000000000000000000000000000000000000000000000000040100010001`.

The overflow vector adds `2^255 + 2^255 = 2^256`, which lies one above the maximum value representable by the 32-byte unsigned work contract and must be rejected.
