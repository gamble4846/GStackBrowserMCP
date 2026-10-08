// MCP server (plan §4.5): Streamable HTTP at BASE_PATH/mcp, stateless at the MCP level.
// Browser sessions are our own durable IDs (they survive MCP reconnects and are shared with
// browse-remote), so every tool takes a sessionId.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { clientIp, readJson, requireAuth, sendError, sendJson } from '../api/http';
import {
  createSession, deleteSession, execInSession, getSession, listSessions, publicView, SessionError, waitReady,
} from '../core/sessionManager';
import { applyAuthState, exportAuthState, normalizeAuthState, summarize } from '../core/authState';
import { deleteProfile, listProfiles, loadProfile, saveProfile } from '../core/profiles';
import { audit } from '../core/log';
import type { Principal } from '../core/keys';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 2));
const IMAGE_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const sid = z.string().describe('Browser session id from browser_start (gs_...)');
const authStateSchema = z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())])
  .describe('Cookies + storage: Playwright storageState JSON ({cookies, origins:[{origin, localStorage, sessionStorage}]}), a cookie array (Cookie-Editor / gstack), or {origin, localStorage:{...}}');

function buildServer(who: Principal, ip: string): McpServer {
  const server = new McpServer({ name: 'gstack-browser', version: '0.1.0' }, {
    instructions: 'Remote gstack browser. Call browser_start first and keep the sessionId. Use browser_snapshot (interactive) to get @e refs, then browser_click/fill with those refs. Call browser_stop when done: it permanently deletes the session profile and files.',
  });

  async function exec(sessionId: string, command: string, args: string[] = [], stdin?: string): Promise<ToolResult> {
    try {
      const s = getSession(sessionId, who);
      const r = await execInSession(s, who, { command, args, stdin, via: 'mcp', ip });
      const out = r.stdout.trim() || (r.exitCode === 0 ? '(ok)' : '');
      const files = r.files.length ? `\n\nFiles written in the session: ${r.files.join(', ')} (fetch with browser_get_file)` : '';
      if (r.exitCode !== 0) return text(`${out}\n${r.stderr.trim()}`.trim() || `exit code ${r.exitCode}`, true);
      return text(out + files);
    } catch (err) { return errorResult(err); }
  }
  function errorResult(err: unknown): ToolResult {
    return text(err instanceof Error ? err.message : String(err), true);
  }
  // registerTool's generics recurse too deeply over our many zod shapes; the handler is typed by hand.
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (a: any) => Promise<ToolResult>) => void;
  const tool = (name: string, description: string, shape: z.ZodRawShape, fn: (a: any) => Promise<ToolResult>) =>
    register(name, { description, inputSchema: shape }, async (a: any) => { try { return await fn(a); } catch (err) { return errorResult(err); } });

  // ---- session lifecycle ----
  tool('browser_start', 'Start a new isolated browser session (fresh profile). Returns sessionId. With wait=true (default) it returns once the browser is ready.', {
    viewport: z.string().regex(/^\d{2,4}x\d{2,4}$/).optional().describe('e.g. 1280x720'),
    stealth: z.enum(['default', 'extended']).optional(),
    label: z.string().max(80).optional(),
    authProfile: z.string().optional().describe('Name of one of your saved auth profiles to start logged in'),
    authState: authStateSchema.optional(),
    wait: z.boolean().optional().default(true),
  }, async (a) => {
    let auth: { state: any; warnings: string[] } | null = null;
    if (a.authProfile) auth = { state: loadProfile(who.user, a.authProfile), warnings: [] };
    else if (a.authState) auth = normalizeAuthState(typeof a.authState === 'string' ? a.authState : JSON.stringify(a.authState));
    const s = await createSession(who, 'mcp', { viewport: a.viewport, stealth: a.stealth, label: a.label },
      auth ? async (sess) => {
        const r = await applyAuthState(sess, who, auth!.state);
        audit({ action: 'auth.apply', user: who.user, session: sess.id, via: 'mcp', ip, ok: r.origins.every((o) => o.ok), detail: JSON.stringify(summarize(auth!.state)) });
        (sess as any).authReport = { ...r, warnings: auth!.warnings };
      } : undefined);
    if (a.wait !== false) await waitReady(s, 120_000);
    return json({ sessionId: s.id, status: s.status, error: s.error, authReport: (s as any).authReport,
      next: s.status === 'starting' ? 'Poll browser_status with this sessionId until status is "ready".' : undefined });
  });
  tool('browser_status', 'Get a session\'s status (starting | ready | failed). Optionally wait up to waitSeconds for it to become ready.', {
    sessionId: sid, waitSeconds: z.number().int().min(0).max(120).optional(),
  }, async (a) => {
    const s = getSession(a.sessionId, who);
    if (a.waitSeconds) await waitReady(s, a.waitSeconds * 1000);
    return json({ ...publicView(s), authReport: (s as any).authReport });
  });
  tool('browser_stop', 'Stop a session and permanently delete its browser profile (cookies, storage) and files.', { sessionId: sid },
    async (a) => { await deleteSession(a.sessionId, who); return text(`Session ${a.sessionId} deleted.`); });
  tool('browser_list_sessions', 'List your browser sessions.', {}, async () => json(listSessions(who)));

  // ---- common commands (thin wrappers over gstack browse) ----
  tool('browser_goto', 'Navigate to a URL. Use http://localhost:<port> to reach your own machine through a tunnel.', { sessionId: sid, url: z.string() },
    (a) => exec(a.sessionId, 'goto', [a.url]));
  tool('browser_snapshot', 'Accessibility snapshot with @e refs for click/fill. interactive=true lists only interactive elements; diff=true shows changes since the previous snapshot.', {
    sessionId: sid, interactive: z.boolean().optional().default(true), compact: z.boolean().optional(), diff: z.boolean().optional(),
    depth: z.number().int().min(1).max(50).optional(), selector: z.string().optional(),
  }, (a) => exec(a.sessionId, 'snapshot', [
    ...(a.interactive ? ['-i'] : []), ...(a.compact ? ['-c'] : []), ...(a.diff ? ['-D'] : []),
    ...(a.depth ? ['-d', String(a.depth)] : []), ...(a.selector ? ['-s', a.selector] : []),
  ]));
  tool('browser_click', 'Click an element by @ref (from browser_snapshot) or CSS selector.', { sessionId: sid, target: z.string() }, (a) => exec(a.sessionId, 'click', [a.target]));
  tool('browser_fill', 'Fill an input by @ref or CSS selector.', { sessionId: sid, target: z.string(), value: z.string() }, (a) => exec(a.sessionId, 'fill', [a.target, a.value]));
  tool('browser_type', 'Type text into the focused element (or a selector).', { sessionId: sid, text: z.string(), selector: z.string().optional() },
    (a) => exec(a.sessionId, 'type', [...(a.selector ? ['--selector', a.selector] : []), '--', a.text]));
  tool('browser_press', 'Press a key, e.g. Enter, Tab, ArrowDown, Control+A.', { sessionId: sid, key: z.string() }, (a) => exec(a.sessionId, 'press', [a.key]));
  tool('browser_select', 'Choose an option in a <select> by value, label or visible text.', { sessionId: sid, target: z.string(), value: z.string() }, (a) => exec(a.sessionId, 'select', [a.target, a.value]));
  tool('browser_hover', 'Hover an element.', { sessionId: sid, target: z.string() }, (a) => exec(a.sessionId, 'hover', [a.target]));
  tool('browser_scroll', 'Scroll an element into view, or to the bottom of the page.', { sessionId: sid, target: z.string().optional() }, (a) => exec(a.sessionId, 'scroll', a.target ? [a.target] : []));
  tool('browser_wait', 'Wait for a selector, network idle, or page load (15 s max).', { sessionId: sid, for: z.string().describe('CSS selector, "--networkidle" or "--load"') },
    (a) => exec(a.sessionId, 'wait', [a.for]));
  tool('browser_text', 'Clean page text (optionally of one element).', { sessionId: sid, selector: z.string().optional() }, (a) => exec(a.sessionId, 'text', a.selector ? [a.selector] : []));
  tool('browser_links', 'All links on the page.', { sessionId: sid }, (a) => exec(a.sessionId, 'links'));
  tool('browser_forms', 'Form fields as JSON.', { sessionId: sid }, (a) => exec(a.sessionId, 'forms'));
  tool('browser_console', 'Captured console messages.', { sessionId: sid, errorsOnly: z.boolean().optional() }, (a) => exec(a.sessionId, 'console', a.errorsOnly ? ['--errors'] : []));
  tool('browser_tabs', 'List open tabs.', { sessionId: sid }, (a) => exec(a.sessionId, 'tabs'));
  tool('browser_newtab', 'Open a new tab.', { sessionId: sid, url: z.string().optional() }, (a) => exec(a.sessionId, 'newtab', a.url ? [a.url] : []));
  tool('browser_switch_tab', 'Switch to a tab by id.', { sessionId: sid, tabId: z.number().int() }, (a) => exec(a.sessionId, 'tab', [String(a.tabId)]));
  tool('browser_close_tab', 'Close a tab (current one if no id).', { sessionId: sid, tabId: z.number().int().optional() }, (a) => exec(a.sessionId, 'closetab', a.tabId ? [String(a.tabId)] : []));
  tool('browser_screenshot', 'Screenshot returned as an image. Full page by default; viewport=true for the visible area; or a selector/@ref for one element.', {
    sessionId: sid, viewport: z.boolean().optional(), target: z.string().optional(),
  }, async (a) => {
    const s = getSession(a.sessionId, who);
    const r = await execInSession(s, who, { command: 'screenshot', args: [...(a.viewport ? ['--viewport'] : []), '--base64', ...(a.target ? [a.target] : [])], via: 'mcp', ip });
    const m = /data:(image\/\w+);base64,([A-Za-z0-9+/=]+)/.exec(r.stdout);
    if (r.exitCode !== 0 || !m) return text(r.stderr.trim() || r.stdout.trim() || 'screenshot failed', true);
    return { content: [{ type: 'image', data: m[2], mimeType: m[1] }] };
  });

  // ---- everything else ----
  tool('browser_command', 'Run any gstack browse command (see gstack BROWSER.md): e.g. command "responsive", args ["shots/home"]; "pdf", ["page.pdf"]; "js", ["document.title"]; "cleanup", ["--all"]. Relative file paths are written inside the session; fetch them with browser_get_file.', {
    sessionId: sid, command: z.string(), args: z.array(z.string()).optional().default([]), stdin: z.string().optional(),
  }, (a) => exec(a.sessionId, a.command, a.args, a.stdin));
  tool('browser_batch', 'Run several commands in order, stopping at the first error: [["goto","https://..."],["snapshot","-i"]].', {
    sessionId: sid, commands: z.array(z.array(z.string()).min(1)).min(1).max(50),
  }, (a) => exec(a.sessionId, 'chain', [], JSON.stringify(a.commands)));
  tool('browser_get_file', 'Fetch a file the session wrote (screenshot, pdf, download). Images come back as images, other files as base64.', {
    sessionId: sid, path: z.string().describe('Path relative to the session, as listed in a command result'),
  }, async (a) => {
    const s = getSession(a.sessionId, who);
    const rel = a.path.replace(/^\.\//, '');
    const abs = path.join(s.ident.dir, rel);
    if (rel.includes('..') || path.isAbsolute(rel) || /^(home|tmp|\.gstack|auth)(\/|$)/.test(rel) || !fs.existsSync(abs)) throw new SessionError(404, `file not found: ${rel}`);
    const data = fs.readFileSync(abs);
    if (data.length > 15 * 1024 * 1024) throw new SessionError(413, 'file too large for MCP (15 MB); use the REST API');
    const mime = IMAGE_EXT[path.extname(rel).toLowerCase()];
    if (mime) return { content: [{ type: 'image', data: data.toString('base64'), mimeType: mime }] };
    return text(`base64 (${data.length} bytes):\n${data.toString('base64')}`);
  });

  // ---- logged-in sessions ----
  tool('browser_set_auth_state', 'Load cookies + localStorage/sessionStorage into a running session (from an auth state or one of your saved profiles).', {
    sessionId: sid, authState: authStateSchema.optional(), authProfile: z.string().optional(), returnTo: z.string().optional(),
  }, async (a) => {
    const s = getSession(a.sessionId, who);
    const auth = a.authProfile ? { state: loadProfile(who.user, a.authProfile), warnings: [] as string[] }
      : a.authState ? normalizeAuthState(typeof a.authState === 'string' ? a.authState : JSON.stringify(a.authState)) : null;
    if (!auth) throw new SessionError(400, 'give authState or authProfile');
    const r = await applyAuthState(s, who, auth.state, { returnTo: a.returnTo });
    audit({ action: 'auth.apply', user: who.user, session: s.id, via: 'mcp', ip, ok: r.origins.every((o) => o.ok), detail: JSON.stringify(summarize(auth.state)) });
    return json({ ...r, warnings: auth.warnings });
  });
  tool('browser_export_auth_state', 'Export the session\'s cookies and storage (for the current site, or the given origins). Owner only. Contains secrets.', {
    sessionId: sid, origins: z.array(z.string()).optional(),
  }, async (a) => {
    const s = getSession(a.sessionId, who);
    if (s.owner !== who.user) throw new SessionError(403, 'only the session owner can export its auth state');
    const st = await exportAuthState(s, who, a.origins);
    audit({ action: 'auth.export', user: who.user, session: s.id, via: 'mcp', ip, detail: JSON.stringify(summarize(st)) });
    return json(st);
  });
  tool('auth_profiles_list', 'List your saved auth profiles (names, counts, expiry). Never shows values.', {}, async () => json(listProfiles(who.user)));
  tool('auth_profile_save', 'Save the session\'s current login (cookies + storage) as a named, encrypted profile you can start sessions with.', {
    sessionId: sid, name: z.string(), origins: z.array(z.string()).optional(),
  }, async (a) => {
    const s = getSession(a.sessionId, who);
    if (s.owner !== who.user) throw new SessionError(403, 'only the session owner can save its auth state');
    const meta = saveProfile(who.user, a.name, await exportAuthState(s, who, a.origins));
    audit({ action: 'profile.save', user: who.user, via: 'mcp', ip, detail: a.name });
    return json(meta);
  });
  tool('auth_profile_delete', 'Delete one of your saved auth profiles.', { name: z.string() }, async (a) => {
    deleteProfile(who.user, a.name);
    audit({ action: 'profile.delete', user: who.user, via: 'mcp', ip, detail: a.name });
    return text(`Profile ${a.name} deleted.`);
  });
  return server;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const who = requireAuth(req, res, 'mcp');
  if (!who) return;
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'this MCP endpoint is stateless: use POST' }, { allow: 'POST' }); return; }
  try {
    const body = await readJson(req);
    const server = buildServer(who, clientIp(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, body);
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
  }
}
