# QR Code Tool - Usage Guide

Generate QR codes from text, URLs, or data in multiple formats.

## Quick Reference

```bash
# Generate and display in terminal
qrcode --text "https://example.com"

# Save as SVG file
qrcode -t "https://example.com" -f svg -o qr.svg

# Save as PNG file
qrcode -t "Contact info" -f png -o contact.png
```

## Commands

### Generate QR Code

```bash
qrcode --text <text> [--format <format>] [--output <file>] [options]
```

**Required Parameters:**
- `--text` or `-t`: The text, URL, or data to encode

**Optional Parameters:**
- `--format` or `-f`: Output format (`terminal`, `ascii`, `svg`, `png`)
- `--output` or `-o`: File path to save (for svg/png)
- `--size` or `-s`: Size of QR code (default: 25)
- `--errorCorrection` or `-e`: Error correction level (`L`, `M`, `Q`, `H`)
- `--dark-color`: Dark module color (svg/png only)
- `--light-color`: Light module color (svg/png only)

## Output Formats

| Format | Description | Best For |
|--------|-------------|----------|
| `terminal` | Colored terminal blocks (default) | Quick viewing in terminal |
| `ascii` | ASCII art with █ characters | Text-only environments |
| `svg` | Scalable vector graphics | Print, web, scaling |
| `png` | Raster image | General image use |

## Examples

### URLs
```bash
qrcode -t "https://example.com"
qrcode -t "https://myapp.com/download" -f png -o download-qr.png
```

### WiFi Credentials
```bash
qrcode -t "WIFI:T:WPA;S:NetworkName;P:Password;;" -f svg -o wifi.svg
```

### Contact Info (vCard)
```bash
qrcode -t "BEGIN:VCARD
VERSION:3.0
FN:John Doe
TEL:+1234567890
END:VCARD" -f png -o contact.png
```

### High Error Correction for Print
```bash
qrcode -t "https://example.com" -e H -f png -o print-qr.png -s 200
```

## Tips

1. **Use terminal format for quick checks** - It's the fastest and shows immediately
2. **Use SVG for print** - Vector format scales perfectly
3. **Use high error correction (H) for print** - Allows for some damage/obstruction
4. **Test before printing** - Always scan your generated QR code to verify
5. **Keep URLs short** - Shorter data = simpler QR code = easier to scan

## Common Use Cases

| Use Case | Command |
|----------|---------|
| Share URL | `qrcode -t "https://..." -f terminal` |
| WiFi access | `qrcode -t "WIFI:T:WPA;S:...;P:...;;" -f svg -o wifi.svg` |
| Print material | `qrcode -t "..." -e H -f png -o qr.png -s 300` |
| Business card | `qrcode -t "BEGIN:VCARD..." -f svg -o card.svg` |
