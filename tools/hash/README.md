# Hash Tool

Hashing and encryption utilities for the Beige agent toolkit.

## Overview

Provides comprehensive hashing, encoding, and cryptographic functions:

- **Hash digests**: MD5, SHA-1, SHA-256, SHA-512, SHA-3, Blake2, RIPEMD-160
- **HMAC signatures**: Hash-based message authentication codes
- **File hashing**: Calculate checksums for files
- **UUID generation**: Generate unique identifiers
- **Random generation**: Cryptographically secure random bytes
- **Encoding/Decoding**: Base64, hex, URL encoding, HTML escaping

## Installation

```bash
bun add tools/hash
```

## Commands

### digest

Generate a hash digest of a string.

```bash
hash digest "hello world"
hash digest "hello world" --algorithm sha512
hash digest "hello world" -a md5 -e base64
```

**Options:**
- `--algorithm, -a <algo>` - Hash algorithm (default: sha256)
- `--encoding, -e <enc>` - Output encoding: hex, base64, base64url

### hmac

Generate an HMAC signature.

```bash
hash hmac "message" "secret-key"
hash hmac "message" "secret-key" -a sha512
```

**Options:**
- `--algorithm, -a <algo>` - Hash algorithm (default: sha256)
- `--encoding, -e <enc>` - Output encoding: hex, base64, base64url

### file

Hash the contents of a file.

```bash
hash file /path/to/file.txt
hash file /path/to/file.txt -a sha512
hash file /path/to/file.txt -a md5 -e base64
```

**Options:**
- `--algorithm, -a <algo>` - Hash algorithm (default: sha256)
- `--encoding, -e <enc>` - Output encoding: hex, base64, base64url

### compare

Compare two strings or hashes securely.

```bash
hash compare "hash1" "hash2"
hash compare "password123" "password123" --timing-safe
```

**Options:**
- `--timing-safe` - Use timing-safe comparison (default: true)

Returns JSON: `{"match": true}` or `{"match": false}`

### uuid

Generate a UUID (Universally Unique Identifier).

```bash
hash uuid
# Output: 550e8400-e29b-41d4-a716-446655440000
```

### random

Generate random bytes.

```bash
hash random 32
hash random 16 -e base64
hash random 64 -e hex
```

**Options:**
- `--encoding, -e <enc>` - Output encoding: hex, base64, base64url, raw

### encode

Encode a string to various formats.

```bash
hash encode "hello" -f base64
# Output: aGVsbG8=

hash encode "hello world" -f hex
# Output: 68656c6c6f20776f726c64

hash encode "hello world" -f url
# Output: hello%20world

hash encode "<script>" -f html
# Output: &lt;script&gt;
```

**Formats:**
- `base64` - Standard Base64 encoding
- `base64url` - URL-safe Base64 encoding
- `hex` - Hexadecimal representation
- `url` - URL encoding (percent-encoding)
- `html` - HTML entity escaping

### decode

Decode a string from various formats.

```bash
hash decode "aGVsbG8=" -f base64
# Output: hello

hash decode "68656c6c6f" -f hex
# Output: hello

hash decode "hello%20world" -f url
# Output: hello world

hash decode "&lt;script&gt;" -f html
# Output: <script>
```

### algorithms

List all supported hash algorithms.

```bash
hash algorithms
```

## Supported Algorithms

| Algorithm | Use Case |
|-----------|----------|
| `md5` | Legacy checksums (not recommended for security) |
| `sha1` | Git commits (deprecated for security) |
| `sha224` | SHA-2 family, 224-bit |
| `sha256` | General purpose, recommended |
| `sha384` | SHA-2 family, 384-bit |
| `sha512` | High-security applications |
| `sha3-224` | SHA-3 family, 224-bit |
| `sha3-256` | SHA-3 family, 256-bit |
| `sha3-384` | SHA-3 family, 384-bit |
| `sha3-512` | SHA-3 family, 512-bit |
| `blake2b512` | BLAKE2, 512-bit |
| `blake2s256` | BLAKE2, 256-bit |
| `ripemd160` | Bitcoin addresses |

## Configuration

Configure via environment variables or tool config:

```json
{
  "defaultAlgorithm": "sha256",
  "allowedAlgorithms": ["sha256", "sha512"],
  "maxFileSize": 104857600,
  "maxInputLength": 1048576
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `defaultAlgorithm` | Default hash algorithm | sha256 |
| `allowedAlgorithms` | Restrict to specific algorithms | all |
| `maxFileSize` | Max file size for hashing (bytes) | 104857600 (100MB) |
| `maxInputLength` | Max string input length | 1048576 (1MB) |

## Security Considerations

1. **MD5 and SHA-1**: Only use for checksums, not security
2. **Timing-safe comparison**: Always use for password/hash comparison
3. **HMAC**: Use for message authentication, not just hashing
4. **Random bytes**: Uses cryptographically secure random number generator

## Examples

### Verify file integrity

```bash
# Generate checksum
hash file backup.tar.gz -a sha256 > checksum.txt

# Later, verify
hash file backup.tar.gz -a sha256
# Compare with checksum.txt
```

### API signature

```bash
# Create signature for API request
TIMESTAMP=$(date +%s)
MESSAGE="POST:/api/users:$TIMESTAMP"
SIGNATURE=$(hash hmac "$MESSAGE" "$API_SECRET")
curl -H "X-Signature: $SIGNATURE" https://api.example.com/users
```

### Generate secure tokens

```bash
# Generate API token
TOKEN=$(hash random 32 -e base64url)
echo "API_TOKEN=$TOKEN"
```

### Password verification flow

```bash
# Store password hash
STORED_HASH=$(hash digest "user_password" -a sha512)

# Later, verify
INPUT_HASH=$(hash digest "user_input" -a sha512)
RESULT=$(hash compare "$STORED_HASH" "$INPUT_HASH")
echo "$RESULT"  # {"match": true} or {"match": false}
```

## License

MIT
