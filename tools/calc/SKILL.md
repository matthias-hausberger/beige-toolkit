# Calc Tool - Usage Guide

A safe mathematical expression calculator with unit conversions.

## Quick Start

```bash
# Basic math
calc eval "2 + 2 * 3"              # → 8

# Using functions
calc eval "sqrt(144) + pi"         # → 15.141592

# Unit conversion
calc convert 100 km miles          # → 62.137119 miles

# Temperature
calc convert 72 f c                # → 22.222222 celsius
```

## Commands

| Command | Description |
|---------|-------------|
| `calc eval <expr>` | Evaluate a math expression |
| `calc convert <v> <from> <to>` | Convert between units |
| `calc units [category]` | List available units |
| `calc functions` | List math functions and constants |

## Expression Syntax

### Operators
- `+` `-` `*` `/` - Basic arithmetic
- `^` or `**` - Exponentiation
- `()` - Grouping

### Examples
```bash
calc eval "2^10"                   # 1024
calc eval "sqrt(2) * sin(pi/4)"    # 1
calc eval "avg(10, 20, 30)"        # 20
calc eval "floor(3.7) + ceil(2.1)" # 6
```

## Unit Conversions

### Length
`m`, `km`, `cm`, `mm`, `mi`, `yd`, `ft`, `in`

```bash
calc convert 5 km miles
calc convert 72 inches feet
```

### Weight
`kg`, `g`, `mg`, `lb`, `oz`, `ton`

```bash
calc convert 150 lb kg
calc convert 1 ton grams
```

### Temperature
`c`, `f`, `k` (celsius, fahrenheit, kelvin)

```bash
calc convert 0 c f                 # 32 fahrenheit
calc convert 100 c k               # 373.15 kelvin
```

### Volume
`l`, `ml`, `gal`, `qt`, `pt`, `cup`, `floz`

```bash
calc convert 1 gallon liters
calc convert 500 ml cups
```

### Time
`ms`, `s`, `min`, `h`, `d`, `w`, `y`

```bash
calc convert 1 day hours           # 24 hours
calc convert 1000 ms seconds       # 1 second
```

### Data
`b`, `kb`, `mb`, `gb`, `tb`, `bit`

```bash
calc convert 1024 mb gb            # 1 gb
calc convert 8 bits bytes          # 1 byte
```

## Tips for AI Agents

1. **Always quote expressions** with spaces
2. **Unit aliases work**: `f` = `fahrenheit`, `km` = `kilometer`
3. **Chain calculations**: `calc eval "sqrt(16) * pi"`
4. **Check available units**: `calc units length`

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| "Unknown function" | Function not in whitelist | Use `calc functions` to see available |
| "Cannot convert" | Units in different categories | Can't convert kg to meters |
| "Unbalanced parentheses" | Missing `(` or `)` | Check expression syntax |
