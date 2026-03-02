# StringKit

A lightweight TypeScript utility library for common string manipulation tasks.

## Installation

```bash
npm install stringkit
```

## Usage

```typescript
import { trimWhitespace, capitalizeWords } from "stringkit";

const cleaned = trimWhitespace("  hello world  ");
console.log(cleaned); // "hello world"

const title = capitalizeWords("hello world");
console.log(title); // "Hello World"
```

## Features

- Trim whitespace from strings
- Capitalize words
- Reverse strings
- Split and join utilities
- More coming soon

## Contributing

We welcome contributions. Please read our [CONTRIBUTING.md](./CONTRIBUTING.md) guide before submitting a pull request.

## License

MIT
