# Calc Tool

Safe mathematical expression calculator with unit conversions for AI agents.

## Features

- **Safe expression evaluation**: Sandboxed math parser with no code execution
- **Rich math library**: 30+ functions (sin, cos, sqrt, log, etc.)
- **Math constants**: π, e, φ (golden ratio), τ
- **Unit conversions**: Length, weight, temperature, volume, time, data
- **Precision control**: Configurable decimal places

## Installation

```bash
# Clone beige-toolkit
git clone https://github.com/matthias-hausberger/beige-toolkit.git
cd beige-toolkit/tools/calc
```

## Usage

### CLI

```bash
# Evaluate expressions
deno run index.ts eval "2 + 2 * 3"           # 8
deno run index.ts eval "sqrt(16) + pi"       # 7.141592
deno run index.ts eval "sin(pi/4)"           # 0.707107
deno run index.ts eval "pow(2, 10)"          # 1024

# Convert units
deno run index.ts convert 100 km miles       # 62.137119 miles
deno run index.ts convert 72 fahrenheit celsius  # 22.222222 celsius
deno run index.ts convert 1 gallon liters    # 3.785410 liters

# List available units
deno run index.ts units length
deno run index.ts units weight
deno run index.ts units

# List available functions
deno run index.ts functions
```

### As a Tool

```typescript
import { tool } from "./index.ts";

// Evaluate expression
const result = await tool.execute("eval", { expression: "2^10 + sqrt(144)" });
console.log(result.message); // "2^10 + sqrt(144) = 1,036"

// Convert units
const conversion = await tool.execute("convert", {
  value: 100,
  from: "km",
  to: "miles"
});
console.log(conversion.message); // "100 km = 62.137119 miles"
```

## Commands

### `eval <expression>`

Evaluate a mathematical expression.

**Parameters:**
- `expression` (string, required): Math expression to evaluate
- `precision` (number, optional): Decimal places (default: 6)

**Examples:**
```bash
calc eval "2 + 2"
calc eval "sin(pi/4)"
calc eval "avg(1, 2, 3, 4, 5)"
calc eval "sqrt(2) * pi"
```

### `convert <value> <from> <to>`

Convert between units of the same category.

**Parameters:**
- `value` (number, required): Value to convert
- `from` (string, required): Source unit
- `to` (string, required): Target unit

**Examples:**
```bash
calc convert 100 km miles
calc convert 72 fahrenheit celsius
calc convert 1024 megabytes gigabytes
```

### `units [category]`

List available units.

**Parameters:**
- `category` (string, optional): Filter by category

**Categories:** `length`, `weight`, `temperature`, `volume`, `time`, `data`

### `functions`

List available mathematical functions and constants.

## Available Functions

### Basic
`abs`, `ceil`, `floor`, `round`, `trunc`, `sign`

### Power/Logarithm
`sqrt`, `cbrt`, `pow`, `exp`, `log`, `log10`, `log2`

### Trigonometry
`sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`

### Utility
`min`, `max`, `random`, `degToRad`, `radToDeg`

### Statistics
`avg`, `sum`

## Available Constants

- `pi` (π) ≈ 3.141592653589793
- `e` ≈ 2.718281828459045
- `phi` (golden ratio) ≈ 1.618033988749895
- `tau` (2π) ≈ 6.283185307179586

## Supported Units

### Length
`m`, `km`, `cm`, `mm`, `mile`, `yard`, `foot`, `inch`

### Weight
`kg`, `g`, `mg`, `lb`, `oz`, `ton`

### Temperature
`celsius`, `fahrenheit`, `kelvin`

### Volume
`l`, `ml`, `gallon`, `quart`, `pint`, `cup`, `fluid ounce`

### Time
`s`, `min`, `h`, `day`, `week`, `year`, `ms`

### Data
`byte`, `kb`, `mb`, `gb`, `tb`, `bit`

## Configuration

```json
{
  "maxExpressionLength": 1000,
  "defaultPrecision": 6,
  "allowVariables": false
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxExpressionLength` | number | 1000 | Maximum characters in expression |
| `defaultPrecision` | number | 6 | Default decimal places |
| `allowVariables` | boolean | false | Allow variable definitions (not implemented) |

## Security

The calc tool uses a sandboxed expression parser that:

1. **Validates input**: Only allows numbers, operators, parentheses, and known functions
2. **No code execution**: Uses safe evaluation with Function constructor
3. **Function whitelist**: Only predefined math functions are allowed
4. **Length limits**: Prevents denial of service via long expressions

## Error Handling

The tool returns user-friendly errors for:
- Invalid syntax
- Unknown functions
- Unbalanced parentheses
- Incompatible unit conversions
- Division by zero
- Non-finite results

## License

MIT
