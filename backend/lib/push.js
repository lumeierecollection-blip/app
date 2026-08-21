/**
 * Amendment F -- push, ported from tradeapp's lib/push.js pattern: device
 * tokens and seen-post keys live in small JSON files (no database), and
 * firebase-admin is lazy-loaded so a server without credentials runs
 * everything except the actual send. Message shape follows this project's
 * notify contract ({token, title, body, data}) so the Flutter app's
 * registration flow is unchanged.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';

let admin = null;
let adminInitialized = false;
let adminError = null;

export function pushConfigured() {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS,
  );
}

export async function initAdmin() {
  if (adminInitialized) return;
  adminInitialized = true;
  if (!pushConfigured()) {
    adminError = new Error(
      'FCM not configured (set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS)',
    );
    return;
  }
  try {
    const module = await import('firebase-admin');
    admin = module.default ?? module;
    const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
      : admin.credential.applicationDefault();
    admin.initializeApp({ credential });
  } catch (err) {
    adminError = err;
    admin = null;
  }
}

export function pushStatus() {
  if (!pushConfigured()) return { enabled: false, reason: 'not-configured' };
  if (adminInitialized && admin) return { enabled: true };
  return {
    enabled: false,
    reason: adminError ? String(adminError.message || adminError) : 'initializing',
  };
}

async function sendPush(token, message) {
  await initAdmin();
  if (!admin) return { skipped: true, reason: pushStatus().reason };
  try {
    await admin.messaging().send({ token, ...message });
    return { ok: true };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

/** One post's dedupe key -- channel-scoped so two channels reposting the
 * same text are both delivered. */
export function postKey(post) {
  return post.id;
}

export class PushNotifier {
  constructor({ tokenFile, seenFile, sender = sendPush } = {}) {
    this.tokenFile = tokenFile;
    this.seenFile = seenFile;
    this.sender = sender;
    this.tokens = [];
    this.seen = new Set();
  }

  async load() {
    const [tokens, seen] = await Promise.all([loadList(this.tokenFile), loadList(this.seenFile)]);
    this.tokens = tokens;
    this.seen = new Set(seen);
  }

  register(token) {
    const clean = String(token || '').trim();
    if (!clean) return false;
    if (this.tokens.includes(clean)) return false;
    this.tokens.push(clean);
    saveListSync(this.tokenFile, this.tokens);
    return true;
  }

  unregister(token) {
    const clean = String(token || '').trim();
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t !== clean);
    if (this.tokens.length !== before) saveListSync(this.tokenFile, this.tokens);
    return this.tokens.length !== before;
  }

  /** Posts not yet pushed. Marks them seen immediately (crash may re-push a
   * batch -- acceptable; silently dropping one is not). */
  process(posts) {
    const fresh = [];
    for (const post of posts) {
      const key = postKey(post);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      fresh.push(post);
    }
    if (fresh.length) {
      this.trimSeen();
      saveListSync(this.seenFile, [...this.seen]);
    }
    return fresh;
  }

  markSeen(posts) {
    for (const post of posts) this.seen.add(postKey(post));
    saveListSync(this.seenFile, [...this.seen]);
  }

  async push(posts) {
    if (!posts.length || this.tokens.length === 0) return { attempted: 0, ok: 0 };
    let attempted = 0;
    let ok = 0;
    for (const post of posts) {
      const message = {
        notification: {
          title: post.displayName || post.handle,
          body: truncate(post.text ?? 'new post', 120),
        },
        data: {
          type: 'post',
          postId: String(post.numericId ?? ''),
          sourceHandle: post.handle,
        },
      };
      for (const token of this.tokens) {
        attempted++;
        try {
          const result = await this.sender(token, message);
          if (result?.ok) ok++;
        } catch {
          // A failing device must not stop the rest.
        }
      }
    }
    return { attempted, ok };
  }

  trimSeen() {
    if (this.seen.size <= 5000) return;
    const list = [...this.seen];
    this.seen = new Set(list.slice(list.length - 5000));
  }
}

function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function loadList(file) {
  if (!file) return [];
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}

async function saveList(file, list) {
  if (!file) return;
  try {
    await writeFile(file, JSON.stringify(list));
  } catch {
    // Persistence is best-effort.
  }
}

/** Synchronous variant for the hot paths (register/process/markSeen): these
 * files are tiny and written rarely, and a crash must never lose the
 * seen-set (that would re-push) or a just-registered device. */
function saveListSync(file, list) {
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify(list));
  } catch {
    // Persistence is best-effort.
  }
}
