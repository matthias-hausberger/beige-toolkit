# Hash Tool - Usage Guide

Quick reference for the hash tool.

## Most Common Commands

```bash
# Hash a string
hash digest "hello world"

# Hash a file
hash file /path/to/file.txt

# Generate UUID
hash uuid

# Generate random token
hash random 32
```

## Command Reference

| Command | Purpose | Example |
|---------|---------|---------|
| `digest` | Hash a string | `hash digest "text" -a sha256` |
| `hmac` | HMAC signature | `hash hmac "msg" "key"` |
| `file` | Hash file | `hash file /path/file.txt` |
| `compare` | Compare strings | `hash compare "a" "b"` |
| `uuid` | Generate UUID | `hash uuid` |
| `random` | Random bytes | `hash random 32 -e base64` |
| `encode` | Encode string | `hash encode "text" -f base64` |
| `decode` | Decode string | `hash decode "dGV4dA==" -f base64` |

## Common Algorithms

- `sha256` - General purpose (default)
- `sha512` - High security
- `md5` - Legacy checksums only

## Encodings

- `hex` - Hexadecimal (default)
- `base64` - Standard Base64
- `base64url` - URL-safe Base64

## Quick Examples

```bash
# SHA-256 hash
hash digest "password123"

# SHA-512 with base64 output
hash digest "secret" -a sha512 -e base64

# File checksum
hash file document.pdf -a sha256

# UUID for database
hash uuid

# 32-byte random token (base64)
hash random 32 -e base64

# Base64 encode
hash encode "hello" -f base64

# Base64 decode
hash decode "aGVsbG8=" -f base64
```
