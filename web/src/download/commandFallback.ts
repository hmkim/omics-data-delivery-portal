/**
 * Command fallback (R5.6): browsers without the File System Access API and a file above the
 * single-object limit get copy-paste aria2c / curl commands instead of a split download.
 */
export interface CommandInput {
  filename: string;
  url: string;
}

export interface Commands {
  aria2c: string;
  curl: string;
}

/**
 * Wraps a value in double quotes for POSIX shells and PowerShell, escaping the characters that
 * are special inside double quotes (`"`, `\`, `` ` ``, `$`). Newlines are dropped: a filename with a
 * line break cannot be expressed safely on a single command line.
 */
export function shellQuote(value: string): string {
  const cleaned = value.replace(/[\r\n]/g, '');
  return `"${cleaned.replace(/(["\\`$])/g, '\\$1')}"`;
}

/** Signed URLs contain `&`, `?`, `=`; double quotes keep them intact in bash, zsh and PowerShell. */
function quoteUrl(url: string): string {
  return shellQuote(url);
}

export function buildCommands({ filename, url }: CommandInput): Commands {
  const file = shellQuote(filename);
  const target = quoteUrl(url);
  return {
    aria2c: `aria2c -x 4 -s 4 -k 8G --file-allocation=none -o ${file} ${target}`,
    curl: `curl -L -C - -o ${file} ${target}`,
  };
}
