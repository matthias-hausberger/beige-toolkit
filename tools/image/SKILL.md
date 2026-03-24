# Image Tool Usage Guide

## Quick Reference

```bash
# Get image info
image info photo.jpg

# Resize to width (maintains aspect ratio)
image resize photo.jpg --width 800 resized.jpg

# Resize to exact dimensions
image resize photo.jpg --width 800 --height 600 --no-maintain-aspect resized.jpg

# Convert format
image convert photo.png photo.jpg --quality 90

# Crop region
image crop photo.jpg --x 100 --y 50 --width 400 --height 300 cropped.jpg

# Create thumbnail
image thumbnail photo.jpg --width 150 thumb.jpg

# Rotate
image rotate photo.jpg --angle 90 rotated.jpg

# Optimize for web
image optimize photo.jpg optimized.jpg --quality 85

# Add watermark
image watermark photo.jpg logo.png watermarked.jpg --gravity southeast

# Effects
image blur photo.jpg blurred.jpg --radius 5
image sharpen photo.jpg sharpened.jpg --radius 2
image grayscale photo.jpg gray.jpg
image sepia photo.jpg sepia.jpg
```

## Common Workflows

### Web Optimization

```bash
# 1. Resize to max width
image resize original.jpg --width 1920 full.jpg

# 2. Create thumbnail
image thumbnail original.jpg --width 300 thumb.jpg

# 3. Optimize both
image optimize full.jpg full_opt.jpg --quality 85
image optimize thumb.jpg thumb_opt.jpg --quality 80
```

### Batch Processing

```bash
# Process all JPEGs
for f in *.jpg; do
  image resize "$f" --width 800 "web/$f"
  image thumbnail "$f" --width 200 "thumbs/$f"
done
```

## Prerequisites

ImageMagick must be installed:

```bash
# Check if available
which convert

# Install on Ubuntu/Debian
apt-get install imagemagick

# Install on macOS
brew install imagemagick
```

## Output Format

All successful commands return JSON:

```json
{
  "success": true,
  "input": "photo.jpg",
  "output": "resized.jpg",
  "dimensions": { "width": 800, "height": 600 },
  "outputSize": 245678
}
```

## Error Handling

Errors are also JSON:

```json
{
  "error": "Input file not found: missing.jpg",
  "code": 1
}
```
