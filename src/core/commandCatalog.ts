// Which gstack `browse` commands remote callers may run, and how their arguments are
// treated (plan §4.2). gstack itself still validates everything; this is the outer gate.

// Commands that make no sense or are unsafe on a shared remote browser.
const DENIED: Record<string, string> = {
  'cookie-import-browser': 'There is no local browser on the server to import from. Use an auth state or auth profile instead (browse remote-auth import <file> / remote-auth use <profile>).',
  connect: 'Headed mode is not available on the remote browser.',
  disconnect: 'Headed mode is not available on the remote browser.',
  focus: 'Headed mode is not available on the remote browser.',
  pair: 'Pairing is not available on the remote browser.',
  'pair-agent': 'Pairing is not available on the remote browser.',
  unpair: 'Pairing is not available on the remote browser.',
  inbox: 'The sidebar inbox is not available on the remote browser.',
  profiles: 'Browser profiles are managed by the server: every session gets its own fresh profile.',
  skill: 'Browser skills are not available on the shared remote browser.',
  'domain-skill': 'Domain skills are not available on the shared remote browser.',
  restart: 'Delete the session and start a new one instead.',
  handoff: "Human takeover isn't available on the remote browser yet. Load a logged-in auth state (browse remote-auth use <profile>) and retry, or report this step as blocked.",
  resume: "Human takeover isn't available on the remote browser yet. Load a logged-in auth state (browse remote-auth use <profile>) and retry, or report this step as blocked.",
};

const ALIASES: Record<string, string> = { setcontent: 'load-html', 'set-content': 'load-html', setContent: 'load-html' };

export function canonical(command: string): string {
  return ALIASES[command] ?? command;
}

export function deniedReason(command: string): string | null {
  return DENIED[canonical(command)] ?? null;
}

const COMMAND_RE = /^[a-z][a-z0-9-]{0,40}$/i;
export function isWellFormed(command: string): boolean {
  return COMMAND_RE.test(command);
}

// ---- redaction for the audit log / timeline ----
const SECRET_VALUE_COMMANDS = new Set(['fill', 'type', 'header', 'cookie', 'useragent']);
export function redactArgs(command: string, args: string[]): string[] {
  const c = canonical(command);
  const out = args.map((a) => (a.length > 300 ? `${a.slice(0, 300)}…(${a.length} chars)` : a));
  if (c === 'fill' && out.length >= 2) out[1] = `[redacted ${args[1].length} chars]`;
  if (c === 'type') return out.map((a, i) => (i === out.length - 1 && !a.startsWith('-') ? `[redacted ${a.length} chars]` : a));
  if (c === 'header' && out[0]) out[0] = out[0].replace(/:(.*)$/, (_m, v: string) => `:[redacted ${v.length} chars]`);
  if (c === 'cookie' && out[0]) out[0] = out[0].replace(/=(.*)$/, (_m, v: string) => `=[redacted ${v.length} chars]`);
  if (c === 'storage' && out[0] === 'set' && out[2] !== undefined) out[2] = `[redacted ${args[2].length} chars]`;
  if (SECRET_VALUE_COMMANDS.has(c)) return out;
  return out;
}

// Commands whose stdout may carry secrets; the timeline only keeps a short preview.
export const SENSITIVE_OUTPUT = new Set(['cookies', 'storage', 'js', 'eval', 'html', 'state']);

// Nested commands inside chain/batch must pass the same gate.
export function validateNested(commands: unknown): string | null {
  if (!Array.isArray(commands)) return 'chain/batch input must be a JSON array of [command, ...args]';
  for (const entry of commands) {
    const cmd = Array.isArray(entry) ? entry[0] : (entry as any)?.command;
    if (typeof cmd !== 'string' || !isWellFormed(cmd)) return `invalid nested command: ${JSON.stringify(entry).slice(0, 80)}`;
    const why = deniedReason(cmd);
    if (why) return `${cmd}: ${why}`;
  }
  return null;
}
