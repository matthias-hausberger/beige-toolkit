# QR Code Generator Tool

Generate QR codes from text, URLs, or any data in multiple formats.

## Features

- **Multiple output formats**: ASCII art, terminal blocks, SVG, PNG
- **Customizable colors**: Set dark and light module colors for SVG/PNG
- **Error correction levels**: L (7%), M (15%), Q (25%), H (30%)
- **Configurable size**: Adjust output size to your needs
- **File output**: Save QR codes directly to files

## Installation

```bash
beige tool install qrcode
```

Or manually:

```bash
cd beige-toolkit/tools/qrcode
bun install
```

## Usage

### Basic Usage

```bash
# Generate QR code for a URL (displays in terminal)
qrcode --text "https://example.com"

# Short form
qrcode -t "https://example.com"
```

### Output Formats

```bash
# Terminal format (colored blocks, default)
qrcode -t "https://example.com" -f terminal

# ASCII art format (text-based)
qrcode -t "Hello World" -f ascii

# SVG format (vector graphics)
qrcode -t "https://example.com" -f svg -o qr.svg

# PNG format (raster image)
qrcode -t "https://example.com" -f png -o qr.png
```

### Customization

```bash
# Custom size
qrcode -t "https://example.com" -s 50

# Custom colors (SVG/PNG only)
qrcode -t "https://example.com" -f svg -o qr.svg \
  --dark-color "#1a1a2e" \
  --light-color "#eaf2f8"

# Higher error correction (for damaged/low-quality printing)
qrcode -t "Important Data" -e H -f png -o important.png
```

### Error Correction Levels

| Level | Recovery | Use Case |
|-------|----------|----------|
| L | 7% | Clean environments, maximum data |
| M | 15% | Standard use (default) |
| Q | 25% | May get dirty/damaged |
| H | 30% | Harsh environments, logos overlay |

## Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--text` | `-t` | (required) | Text or URL to encode |
| `--format` | `-f` | `terminal` | Output format: `ascii`, `terminal`, `svg`, `png` |
| `--output` | `-o` | stdout | Output file path (for svg/png) |
| `--size` | `-s` | `25` | Size of QR code |
| `--errorCorrection` | `-e` | `M` | Error correction: `L`, `M`, `Q`, `H` |
| `--dark-color` | | `#000000` | Dark module color (svg/png) |
| `--light-color` | | `#FFFFFF` | Light module color (svg/png) |
| `--help` | `-h` | | Show help message |

## Configuration

Add to your agent's config:

```json
{
  "tools": {
    "qrcode": {
      "defaultFormat": "terminal",
      "defaultSize": 25,
      "defaultErrorCorrection": "M"
    }
  }
}
```

## Examples

### Generate QR for WiFi Access

```bash
qrcode -t "WIFI:T:WPA;S:MyNetwork;P:MyPassword;;" -f png -o wifi.png
```

### Generate vCard QR Code

```bash
qrcode -t "BEGIN:VCARD
VERSION:3.0
FN:John Doe
TEL:+1234567890
EMAIL:john@example.com
END:VCARD" -f svg -o contact.svg
```

### Generate URL with Tracking

```bash
qrcode -t "https://example.com/promo?utm_source=qr&utm_medium=print" \
  -f png -o promo-qr.png -s 200 -e H
```

## Technical Notes

- Pure TypeScript implementation with no native dependencies
- Supports QR Code versions 1-10 (up to 154 characters with L error correction)
- For longer texts, use lower error correction or consider splitting data
- SVG output is scalable without quality loss
- PNG output uses pure JavaScript encoder (no canvas dependency)

## License

MIT
