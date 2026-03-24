# Image Tool

Image manipulation tool for resize, crop, convert, and more using ImageMagick.

## Installation

Requires ImageMagick to be installed on the system:

```bash
# Ubuntu/Debian
apt-get install imagemagick

# macOS
brew install imagemagick

# CentOS/RHEL
yum install imagemagick
```

## Commands

### resize
Resize an image with optional aspect ratio preservation.

```bash
image resize input.png --width 800 --height 600 output.png
image resize input.png --width 800 output.png  # height auto
image resize input.png --width 800 --no-maintain-aspect output.png
image resize input.png --width 800 --upscale output.png  # allow upscaling
```

Options:
- `--width, -w`: Target width in pixels
- `--height, -h`: Target height in pixels
- `--maintain-aspect`: Maintain aspect ratio (default: true)
- `--upscale`: Allow upscaling (default: false)

### crop
Crop an image to specified dimensions.

```bash
image crop input.png --x 100 --y 100 --width 200 --height 200 output.png
image crop input.png --x 0 --y 0 --width 500 --height 500 --gravity Center output.png
```

Options:
- `--x`: X offset in pixels
- `--y`: Y offset in pixels
- `--width, -w`: Crop width in pixels
- `--height, -h`: Crop height in pixels
- `--gravity, -g`: Gravity (North, South, East, West, Center, etc.)

### convert
Convert between image formats.

```bash
image convert input.png output.jpg
image convert input.png output.webp --quality 90
```

Options:
- `--quality, -q`: Quality for lossy formats (1-100)

### rotate
Rotate an image by specified angle.

```bash
image rotate input.png --angle 90 output.png
image rotate input.png --angle 45 --background white output.png
```

Options:
- `--angle, -a`: Rotation angle in degrees
- `--background, -b`: Background color for exposed areas

### flip / flop
Flip vertically or horizontally.

```bash
image flip input.png output.png   # Vertical flip
image flop input.png output.png   # Horizontal flip
```

### thumbnail
Create a thumbnail (optimized small version).

```bash
image thumbnail input.png --width 150 output_thumb.png
image thumbnail input.png --width 150 --height 100 output_thumb.png
```

Options:
- `--width, -w`: Thumbnail width in pixels
- `--height, -h`: Thumbnail height in pixels (defaults to width)

### optimize
Optimize an image for web (strip metadata, progressive loading).

```bash
image optimize input.png output.png
image optimize input.png output.jpg --quality 85
```

Options:
- `--quality, -q`: Quality for lossy formats (1-100)

### watermark
Add a watermark image.

```bash
image watermark input.png watermark.png output.png
image watermark input.png watermark.png output.png --gravity southeast
```

Options:
- `--gravity, -g`: Watermark position (default: southeast)

### blur
Apply Gaussian blur.

```bash
image blur input.png output.png
image blur input.png output.png --radius 10
image blur input.png output.png --radius 10 --sigma 5
```

Options:
- `--radius, -r`: Blur radius (default: 5)
- `--sigma, -s`: Blur sigma (defaults to radius)

### sharpen
Sharpen an image.

```bash
image sharpen input.png output.png
image sharpen input.png output.png --radius 3
```

Options:
- `--radius, -r`: Sharpen radius (default: 2)
- `--sigma, -s`: Sharpen sigma (defaults to radius)

### grayscale
Convert to grayscale.

```bash
image grayscale input.png output.png
```

### sepia
Apply sepia tone effect.

```bash
image sepia input.png output.png
image sepia input.png output.png --threshold 80
```

Options:
- `--threshold, -t`: Sepia threshold 0-100 (default: 80)

### info
Get image information.

```bash
image info input.png
```

Output includes:
- Format
- Width/Height
- Color depth
- Color count
- File size
- Transparency info
- Animation info

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_MAX_FILE_SIZE` | 52428800 | Maximum file size (50MB) |
| `IMAGE_ALLOWED_FORMATS` | png,jpg,jpeg,gif,webp,bmp,tiff,svg | Allowed input formats |
| `IMAGE_OUTPUT_FORMATS` | png,jpg,jpeg,gif,webp,bmp,tiff | Allowed output formats |
| `IMAGE_PATH_ALLOW_LIST` | (empty) | Allowed paths |
| `IMAGE_PATH_DENY_LIST` | (empty) | Denied paths |
| `IMAGE_DEFAULT_QUALITY` | 85 | Default quality for lossy formats |
| `IMAGE_MAX_WIDTH` | 10000 | Maximum output width |
| `IMAGE_MAX_HEIGHT` | 10000 | Maximum output height |

### Path Security

Use `IMAGE_PATH_ALLOW_LIST` and `IMAGE_PATH_DENY_LIST` to restrict file access:

```bash
IMAGE_PATH_ALLOW_LIST=/workspace/images,/workspace/uploads
IMAGE_PATH_DENY_LIST=/etc,/home
```

## Supported Formats

### Input Formats
- PNG
- JPEG (jpg, jpeg)
- GIF
- WebP
- BMP
- TIFF
- SVG (requires additional ImageMagick delegates)

### Output Formats
- PNG
- JPEG (jpg, jpeg)
- GIF
- WebP
- BMP
- TIFF

## Examples

### Create a thumbnail gallery

```bash
for img in *.jpg; do
  image thumbnail "$img" --width 200 "thumbs/${img%.jpg}_thumb.jpg"
done
```

### Convert and optimize for web

```bash
image convert input.png output.jpg --quality 85
image optimize output.jpg output_optimized.jpg
```

### Batch resize

```bash
for img in *.jpg; do
  image resize "$img" --width 1920 "resized/$img"
done
```

### Add watermark to all images

```bash
for img in photos/*.jpg; do
  image watermark "$img" watermark.png "watermarked/$(basename $img)"
done
```

## Error Handling

All errors are returned as JSON:

```json
{
  "error": "Input file not found: missing.png",
  "code": 1
}
```

## Notes

- ImageMagick must be installed on the gateway host
- SVG support requires additional ImageMagick delegates
- Large files may take time to process
- Memory usage scales with image dimensions
