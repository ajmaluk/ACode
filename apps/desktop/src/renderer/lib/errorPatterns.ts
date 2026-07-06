/**
 * Error Patterns — matches common error messages and suggests fixes.
 */

const SAFE_MODULE_RE = /^[a-zA-Z0-9@/\-_.]+$/;

function sanitizeModuleName(name: string): string | null {
  if (!SAFE_MODULE_RE.test(name)) return null;
  return name;
}

interface ErrorPattern {
  pattern: RegExp;
  suggestion: string;
  autoFix?: (match: RegExpMatchArray) => { command: string } | null;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // JavaScript / TypeScript
  {
    pattern: /Cannot find module '(.+?)'/,
    suggestion: "Module not found. Try installing it: npm install $1",
    autoFix: (m) => {
      const mod = sanitizeModuleName(m[1]);
      return mod ? { command: `npm install ${mod}` } : null;
    },
  },
  {
    pattern: /Module not found: Can't resolve '(.+?)'/,
    suggestion: "Module not found. Try installing it: npm install $1",
    autoFix: (m) => {
      const mod = sanitizeModuleName(m[1]);
      return mod ? { command: `npm install ${mod}` } : null;
    },
  },
  {
    pattern: /Type '(.+?)' is not assignable to type '(.+?)'/,
    suggestion: "Type mismatch: $1 cannot be assigned to $2. Check the type definitions.",
  },
  {
    pattern: /Property '(.+?)' does not exist on type '(.+?)'/,
    suggestion: "Property '$1' is not defined on type '$2'. Check spelling or add to type definition.",
  },
  {
    pattern: /Object is possibly 'undefined'/,
    suggestion: "Null reference risk. Add a null check or use optional chaining (?.).",
  },
  {
    pattern: /(.+?) is not a function/,
    suggestion: "$1 is not a function. Check if it's imported correctly.",
  },

  // Python
  {
    pattern: /ModuleNotFoundError: No module named '(.+?)'/,
    suggestion: "Python module not found. Try installing: pip install $1",
    autoFix: (m) => {
      const mod = sanitizeModuleName(m[1]);
      return mod ? { command: `pip install ${mod}` } : null;
    },
  },
  {
    pattern: /ImportError: cannot import name '(.+?)' from '(.+?)'/,
    suggestion: "Import failed. Check if '$1' exists in module '$2'.",
  },
  {
    pattern: /SyntaxError: unexpected token '(.+?)'/,
    suggestion: "Syntax error: unexpected token '$1'. Check parentheses and brackets.",
  },

  // Rust
  {
    pattern: /error\[E\d+\]: (.+?)\n\s+-->\s+(.+?):(\d+):(\d+)/,
    suggestion: "Rust compile error at $2:$3 — see error details above.",
  },
  {
    pattern: /thread '(.+?)' panicked at '(.+?)'/,
    suggestion: "Rust panic in thread '$1': $2",
  },

  // Go
  {
    pattern: /cannot use (.+?) as (.+?) in argument/,
    suggestion: "Type mismatch in Go: $1 cannot be used as $2.",
  },
  {
    pattern: /undefined: (.+)/,
    suggestion: "Undefined identifier: $1. Check import or spelling.",
  },

  // Git
  {
    pattern: /fatal: not a git repository/,
    suggestion: "Not a git repository. Run 'git init' or navigate to a git project.",
  },
  {
    pattern: /CONFLICT \(merge conflict\) in (.+?)$/,
    suggestion: "Merge conflict in $1. Open the file and resolve conflicts manually.",
  },

  // Network / API
  {
    pattern: /ECONNREFUSED (.+?):(\d+)/,
    suggestion: "Connection refused at $1:$2. Is the server running?",
  },
  {
    pattern: /ETIMEDOUT/,
    suggestion: "Connection timed out. Check network or increase timeout.",
  },
  {
    pattern: /429.*rate.?limit/i,
    suggestion: "Rate limited by API provider. Wait before retrying.",
  },
  {
    pattern: /401.*unauthorized/i,
    suggestion: "Authentication failed. Check your API key.",
  },
  {
    pattern: /403.*forbidden/i,
    suggestion: "Access forbidden. Check permissions or API key scope.",
  },

  // Disk / File system
  {
    pattern: /ENOSPC/,
    suggestion: "No space left on device. Free up disk space.",
  },
  {
    pattern: /EACCES.*permission denied/i,
    suggestion: "Permission denied. Check file permissions.",
  },
  {
    pattern: /ENOENT.*no such file or directory/,
    suggestion: "File or directory not found. Check the path.",
  },

  // Docker
  {
    pattern: /Cannot connect to the Docker daemon/,
    suggestion: "Docker daemon not running. Start Docker Desktop.",
  },
];

/**
 * Match an error message against known patterns.
 * Returns the suggestion and optional auto-fix command.
 */
export function matchErrorPattern(errorMessage: string): {
  suggestion: string;
  autoFix?: { command: string };
} | null {
  for (const { pattern, suggestion, autoFix } of ERROR_PATTERNS) {
    const match = errorMessage.match(pattern);
    if (match) {
      return {
        suggestion: suggestion.replace(/\$(\d+)/g, (_, i) => match[parseInt(i)] ?? ""),
        autoFix: autoFix?.(match) ?? undefined,
      };
    }
  }
  return null;
}

/**
 * Get all registered error patterns (for display/debugging).
 */
export function getErrorPatterns(): ErrorPattern[] {
  return ERROR_PATTERNS;
}
