import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'], override: true });
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { MongoClient, type Collection, type Db, type Document } from 'mongodb';
import { GoogleGenAI } from '@google/genai';
import {
  buildTailoredCvDocBase64,
  buildTailoredCvText,
  buildWordDocFromCvText,
  createSeedState,
} from './src/seedData.js';
import type {
  AlertItem,
  AppStatePayload,
  ApplicationStatus,
  ColdEmailLead,
  DailyDigest,
  JobApplication,
  JobStatus,
  MongoConnectionStatus,
  ReplyStage,
  ScoutedJob,
  UserProfile,
} from './src/types.js';

const PORT = Number(process.env.PORT || 3000);
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = IS_VERCEL
  ? path.join('/tmp', 'careerrelay-data')
  : path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const DEFAULT_MONGO_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/careerrelay';
const DEFAULT_MONGO_DB = process.env.MONGODB_DB || 'careerrelay';
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const SESSION_SECRET = (
  process.env.SESSION_SECRET ||
  ADMIN_PASSWORD ||
  'careerrelay-session-secret'
).trim();
const SESSION_COOKIE_NAME = 'careerrelay_session';

function computeSessionToken(password: string): string {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`careerrelay-auth:${password}`)
    .digest('hex');
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isRequestAuthenticated(req: express.Request): boolean {
  if (!ADMIN_PASSWORD) return true;
  const expectedToken = computeSessionToken(ADMIN_PASSWORD);
  const cookies = parseCookies(req.headers.cookie);
  if (
    cookies[SESSION_COOKIE_NAME] &&
    safeEqual(cookies[SESSION_COOKIE_NAME], expectedToken)
  ) {
    return true;
  }
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (safeEqual(bearer, expectedToken) || safeEqual(bearer, ADMIN_PASSWORD)) {
      return true;
    }
  }
  const headerPwd = String(req.headers['x-admin-password'] || '').trim();
  if (headerPwd && safeEqual(headerPwd, ADMIN_PASSWORD)) {
    return true;
  }
  return false;
}

let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;
let activeMongoUri: string | null = null;
let activeMongoDbName: string = DEFAULT_MONGO_DB;
let lastMongoAutoReconnectAt = 0;
let manualMongoDisconnected = false;
let mongoReconnectInFlight = false;

function maskMongoUri(uri: string | null): string | null {
  if (!uri) return null;
  return uri.replace(/:\/\/([^:@]+):([^@]+)@/, '://***:***@');
}

function inferDbNameFromUri(uri: string, fallback: string): string {
  try {
    const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
    if (match && match[1] && match[1].trim()) {
      return match[1].trim();
    }
  } catch {
    // ignore
  }
  return fallback;
}

function stripMongoId<T>(doc: (T & { _id?: unknown; userId?: unknown }) | null): T | null {
  if (!doc) return null;
  const copy = { ...doc };
  delete copy._id;
  delete copy.userId;
  return copy as T;
}

async function readLocalMirror(): Promise<AppStatePayload> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as AppStatePayload;
    return {
      ...parsed,
      coldLeads: Array.isArray(parsed.coldLeads) ? parsed.coldLeads : [],
    };
  } catch {
    const seed = createSeedState();
    await writeLocalMirror(seed);
    return seed;
  }
}

async function writeLocalMirror(state: AppStatePayload): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    STORE_PATH,
    JSON.stringify({ ...state, coldLeads: state.coldLeads || [] }, null, 2),
    'utf-8'
  );
}

async function syncCollection<T extends { id: string }>(
  col: Collection<Document>,
  items: T[]
): Promise<void> {
  await col.deleteMany({});
  if (items.length > 0) {
    await col.insertMany(items.map((item) => ({ ...item })));
  }
}

async function writeMongoState(db: Db, state: AppStatePayload): Promise<void> {
  await db.collection('profiles').replaceOne(
    { userId: 'default' },
    { userId: 'default', ...state.profile },
    { upsert: true }
  );
  await db.collection('digests').replaceOne(
    { userId: 'default' },
    { userId: 'default', ...state.digest },
    { upsert: true }
  );
  await Promise.all([
    syncCollection(db.collection('jobs'), state.jobs),
    syncCollection(db.collection('applications'), state.applications),
    syncCollection(db.collection('alerts'), state.alerts),
    syncCollection(db.collection('cold_leads'), state.coldLeads || []),
  ]);
}

async function readMongoState(db: Db): Promise<AppStatePayload | null> {
  const profileDoc = await db
    .collection('profiles')
    .findOne({ userId: 'default' });

  if (!profileDoc) {
    return null;
  }

  const [jobDocs, appDocs, alertDocs, coldDocs, digestDoc] = await Promise.all([
    db.collection('jobs').find({}).sort({ createdAt: -1 }).toArray(),
    db.collection('applications').find({}).sort({ submittedAt: -1 }).toArray(),
    db.collection('alerts').find({}).sort({ createdAt: -1 }).toArray(),
    db.collection('cold_leads').find({}).sort({ createdAt: -1 }).toArray(),
    db.collection('digests').findOne({ userId: 'default' }),
  ]);

  const seed = createSeedState();
  const profile = stripMongoId<UserProfile>(profileDoc as UserProfile & { _id?: unknown }) || seed.profile;
  const jobs = jobDocs.map((d) => stripMongoId<ScoutedJob>(d as unknown as ScoutedJob)!);
  const applications = appDocs.map(
    (d) => stripMongoId<JobApplication>(d as unknown as JobApplication)!
  );
  const alerts = alertDocs.map((d) => stripMongoId<AlertItem>(d as unknown as AlertItem)!);
  const coldLeads = coldDocs.map(
    (d) => stripMongoId<ColdEmailLead>(d as unknown as ColdEmailLead)!
  );
  const digest =
    stripMongoId<DailyDigest>(digestDoc as unknown as DailyDigest) || seed.digest;

  return { profile, jobs, applications, alerts, coldLeads, digest };
}

function tryAutoReconnectMongo(): void {
  if (
    mongoDb ||
    manualMongoDisconnected ||
    mongoReconnectInFlight ||
    !process.env.MONGODB_URI?.trim()
  ) {
    return;
  }
  const now = Date.now();
  if (now - lastMongoAutoReconnectAt < 60_000) {
    return;
  }
  lastMongoAutoReconnectAt = now;
  mongoReconnectInFlight = true;
  void connectToMongo(DEFAULT_MONGO_URI, DEFAULT_MONGO_DB)
    .then(() => {
      console.log(
        `Reconnected to MongoDB (${maskMongoUri(DEFAULT_MONGO_URI)}, db=${activeMongoDbName})`
      );
    })
    .catch(() => {
      // stay on local fallback silently until next 60s interval
    })
    .finally(() => {
      mongoReconnectInFlight = false;
    });
}

async function readStore(): Promise<AppStatePayload> {
  tryAutoReconnectMongo();
  if (mongoDb) {
    try {
      const existing = await readMongoState(mongoDb);
      if (existing) {
        return existing;
      }
      const local = await readLocalMirror();
      await writeMongoState(mongoDb, local);
      return local;
    } catch (err) {
      console.warn('MongoDB read fallback to local mirror:', err);
    }
  }
  return readLocalMirror();
}

async function writeStore(state: AppStatePayload): Promise<void> {
  await writeLocalMirror(state);
  if (mongoDb) {
    await writeMongoState(mongoDb, state);
  }
}

async function getMongoStatus(): Promise<MongoConnectionStatus> {
  tryAutoReconnectMongo();
  const configuredUriMasked = maskMongoUri(DEFAULT_MONGO_URI);
  if (!mongoDb) {
    return {
      connected: false,
      uriMasked: null,
      configuredUriMasked,
      dbName: activeMongoDbName,
      engine: 'local_fallback',
    };
  }

  try {
    const [jobs, applications, alerts] = await Promise.all([
      mongoDb.collection('jobs').countDocuments(),
      mongoDb.collection('applications').countDocuments(),
      mongoDb.collection('alerts').countDocuments(),
    ]);
    return {
      connected: true,
      uriMasked: maskMongoUri(activeMongoUri),
      configuredUriMasked,
      dbName: activeMongoDbName,
      engine: 'mongodb',
      counts: { jobs, applications, alerts },
    };
  } catch {
    return {
      connected: false,
      uriMasked: null,
      configuredUriMasked,
      dbName: activeMongoDbName,
      engine: 'local_fallback',
    };
  }
}

async function connectToMongo(
  uri: string,
  explicitDbName?: string
): Promise<AppStatePayload> {
  const trimmedUri = uri.trim();
  if (!trimmedUri) {
    throw new Error('MongoDB connection URI is required.');
  }

  const nextDbName =
    explicitDbName?.trim() || inferDbNameFromUri(trimmedUri, DEFAULT_MONGO_DB);

  const client = new MongoClient(trimmedUri, {
    serverSelectionTimeoutMS: 3500,
    connectTimeoutMS: 3500,
  });

  await client.connect();
  const db = client.db(nextDbName);
  await db.command({ ping: 1 });

  if (mongoClient) {
    await mongoClient.close().catch(() => {});
  }

  mongoClient = client;
  mongoDb = db;
  activeMongoUri = trimmedUri;
  activeMongoDbName = nextDbName;

  const existing = await readMongoState(db);
  if (existing) {
    await writeLocalMirror(existing);
    return existing;
  }

  const local = await readLocalMirror();
  await writeMongoState(db, local);
  return local;
}

async function disconnectMongo(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close().catch(() => {});
  }
  mongoClient = null;
  mongoDb = null;
  activeMongoUri = null;
}

let geminiCooldownUntil = 0;

function getGeminiClient(): GoogleGenAI | null {
  if (Date.now() < geminiCooldownUntil) return null;
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

function getGmailSmtpConfig(): { user: string; pass: string } | null {
  const user = process.env.GMAIL_USER?.trim();
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  if (!user || !pass) return null;
  return { user, pass };
}

async function sendApplicationViaServerSmtp(params: {
  toEmail: string;
  subject: string;
  bodyText: string;
  fromName?: string;
  attachmentName?: string;
  attachmentMime?: string;
  attachmentBase64?: string;
}): Promise<{ messageId: string; threadId: string; mode: 'gmail_oauth' }> {
  const cfg = getGmailSmtpConfig();
  if (!cfg) {
    throw new Error('Server Gmail SMTP is not configured in .env.local / .env');
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  const attachments =
    params.attachmentBase64 && params.attachmentName
      ? [
          {
            filename: params.attachmentName,
            content: Buffer.from(params.attachmentBase64, 'base64'),
            contentType: params.attachmentMime || 'application/msword',
          },
        ]
      : undefined;

  const info = await transporter.sendMail({
    from: `"${(params.fromName || 'Oguike Godswill').replace(/"/g, '')}" <${cfg.user}>`,
    to: params.toEmail,
    subject: params.subject,
    text: params.bodyText,
    attachments,
  });

  const messageId = info.messageId || `smtp-${Date.now()}`;
  return {
    messageId,
    threadId: messageId,
    mode: 'gmail_oauth',
  };
}

function extractBodySnippet(rawSource: Buffer | undefined): string {
  if (!rawSource) return '';
  const text = rawSource.toString('utf-8');
  const separatorIdx = text.indexOf('\r\n\r\n');
  const body = separatorIdx !== -1 ? text.slice(separatorIdx + 4) : text;
  return body
    .replace(/<[^>]+>/g, ' ')
    .replace(/=\r?\n/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function extractJsonObject<T>(rawText: string): T | null {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const startObj = cleaned.indexOf('{');
    const endObj = cleaned.lastIndexOf('}');
    if (startObj !== -1 && endObj > startObj) {
      try {
        return JSON.parse(cleaned.slice(startObj, endObj + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function computeStats(state: AppStatePayload) {
  return {
    scouted: state.jobs.length,
    submitted: state.applications.length,
    captchas: state.jobs.filter((j) => j.status === 'captcha_required').length,
    replies: state.applications.filter(
      (a) => Boolean(a.latestRecruiterSnippet) || a.status !== 'submitted'
    ).length,
  };
}

interface NormalizedBoardJob {
  role: string;
  company: string;
  location: string;
  postingUrl: string;
  tags: string[];
  descriptionText: string;
  source: string;
}

async function sendInstantPhoneAlert(
  profile: UserProfile,
  title: string,
  message: string
): Promise<{ sent: boolean; channel: string; detail: string }> {
  if (profile.instantAlertsEnabled === false) {
    return {
      sent: false,
      channel: 'disabled',
      detail: 'Instant phone alerts are turned off in Autopilot Controls.',
    };
  }

  const rawPhone =
    profile.whatsappPhone?.trim() ||
    process.env.WHATSAPP_PHONE?.trim() ||
    '+2347060868353';
  const phoneDigits = rawPhone.replace(/[^0-9]/g, '');
  const apiKey = (
    profile.whatsappApiKey ||
    process.env.WHATSAPP_API_KEY ||
    ''
  ).trim();
  const webhookUrl = (
    profile.whatsappWebhookUrl ||
    process.env.WHATSAPP_WEBHOOK_URL ||
    ''
  ).trim();
  const tgToken = (
    profile.telegramBotToken ||
    process.env.TELEGRAM_BOT_TOKEN ||
    ''
  ).trim();
  const tgChatId = (
    profile.telegramChatId ||
    process.env.TELEGRAM_CHAT_ID ||
    ''
  ).trim();

  const text = `*[CareerRelay]* ${title}\n${message}`;

  // Channel 1: Custom WhatsApp Webhook (Evolution API / Green-API / Baileys / Make / n8n)
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: rawPhone, title, message, text }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        return {
          sent: true,
          channel: 'whatsapp_webhook',
          detail: `Sent alert to WhatsApp webhook for ${rawPhone}.`,
        };
      }
    } catch {
      // fall through to next configured channel
    }
  }

  // Channel 2: CallMeBot Free WhatsApp Gateway
  if (apiKey && phoneDigits) {
    try {
      const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(
        phoneDigits
      )}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        return {
          sent: true,
          channel: 'whatsapp_callmebot',
          detail: `Sent WhatsApp message to +${phoneDigits} via CallMeBot.`,
        };
      }
    } catch {
      // fall through to Telegram if configured
    }
  }

  // Channel 3: Telegram Bot API
  if (tgToken && tgChatId) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${tgToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tgChatId, text }),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (res.ok) {
        return {
          sent: true,
          channel: 'telegram',
          detail: `Sent Telegram alert to chat ${tgChatId}.`,
        };
      }
    } catch {
      // ignore error
    }
  }

  return {
    sent: false,
    channel: 'not_configured',
    detail:
      'Add a CallMeBot WhatsApp API key (send "I allow callmebot to send me messages" to +34 644 51 95 23 on WhatsApp), a Webhook URL, or Telegram Bot credentials in Settings.',
  };
}

function buildReplyAssistantAndPrep(
  company: string,
  role: string,
  stage: ReplyStage,
  _replyText: string,
  candidateName: string
): { suggestedReply: string; interviewPrep: string[] } {
  const isFlutter = /\b(flutter|dart|mobile|ios|android|cross-platform)\b/i.test(role);

  const interviewPrep = isFlutter
    ? [
        `Demo RunBuddy (Flutter + Riverpod + Geolocator GPS + LiveKit voice + WebSockets) and explain real-time state sync during live sessions.`,
        `Walk through Solis (artapp): 3D interactive UI, audio guide playback, and secure Keychain/Keystore JWT + refresh-token rotation.`,
        `Cover Verso's offline/Neon PostgreSQL journaling architecture and prepare crisp answers on Flutter widget tree performance & state isolation.`,
      ]
    : [
        `Lead with ConnectNigeria Marketplace (Next.js 16, React 19, TypeScript, TanStack Query & Table, Lexical, Google Maps, Pusher) & CN Creator (Zustand).`,
        `Walk through Molearn (4 role-based NextAuth dashboards, Prisma/PostgreSQL, Stripe checkout) and PocketGuard (Recharts + Prisma + JWT).`,
        `Highlight measurable Core Web Vitals (LCP/CLS), WCAG accessibility, and end-to-end API error/validation patterns for ${company}.`,
      ];

  let suggestedReply = '';
  if (stage === 'Interview') {
    suggestedReply = `Hi ${company} Hiring Team,\n\nThank you for reaching out! I would be delighted to speak with your engineering team about the ${role} role.\n\nI am available tomorrow or Thursday between 10:00 AM – 4:00 PM WAT (UTC+1) and flexible across US/EU overlap hours. Please let me know what slot works best.\n\nBest regards,\n${candidateName}\n+234 706 086 8353 · https://oguikegodswill.vercel.app`;
  } else if (stage === 'Assessment') {
    suggestedReply = `Hi ${company} Team,\n\nThank you for sending over the ${role} technical assessment. I have received the details and will submit my completed solution promptly within your expected timeframe.\n\nPlease let me know if there are any specific focus areas you would like me to prioritize.\n\nBest regards,\n${candidateName}\n+234 706 086 8353`;
  } else if (stage === 'Offer') {
    suggestedReply = `Hi ${company} Team,\n\nThank you very much for extending the offer for the ${role} position! I am genuinely excited about the team and product roadmap.\n\nI am reviewing the compensation and onboarding details carefully and would love to hop on a quick call to align on start dates and next steps.\n\nWarm regards,\n${candidateName}\n+234 706 086 8353`;
  } else {
    suggestedReply = `Hi ${company} Team,\n\nThank you for your reply regarding the ${role} position. I would be happy to clarify any questions or share relevant code walkthroughs (${isFlutter ? 'RunBuddy, Solis, Verso' : 'ConnectNigeria Marketplace, Molearn, PocketGuard'}).\n\nLooking forward to your thoughts.\n\nBest regards,\n${candidateName}\n+234 706 086 8353 · https://oguikegodswill.vercel.app`;
  }

  return { suggestedReply, interviewPrep };
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extractXmlTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs = 7000
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CareerRelay/1.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function stripHtmlText(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const IGNORED_EMAIL_HOSTS = new Set([
  'remotive.com',
  'weworkremotely.com',
  'jobicy.com',
  'remoteok.com',
  'example.com',
  'sentry.io',
  'wixpress.com',
]);

function extractDomain(email: string | undefined): string {
  if (!email || !email.includes('@')) return '';
  return email.split('@')[1]?.trim().toLowerCase() || '';
}

function isUsableEmailCandidate(email: string): boolean {
  const lower = email.trim().toLowerCase();
  const domain = extractDomain(lower);
  if (!domain || !domain.includes('.')) return false;
  if (
    lower.includes('noreply') ||
    lower.includes('no-reply') ||
    lower.includes('donotreply') ||
    lower.includes('placeholder') ||
    domain.endsWith('.example') ||
    domain.endsWith('.png') ||
    domain.endsWith('.jpg') ||
    domain.endsWith('.jpeg') ||
    domain.endsWith('.svg') ||
    domain.endsWith('.webp') ||
    IGNORED_EMAIL_HOSTS.has(domain)
  ) {
    return false;
  }
  return true;
}

function extractEmailsFromText(text: string): string[] {
  const rawMatches =
    text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const m of rawMatches) {
    const clean = m.replace(/[.,;:!?)]+$/, '');
    const key = clean.toLowerCase();
    if (!seen.has(key) && isUsableEmailCandidate(clean)) {
      seen.add(key);
      unique.push(clean);
    }
  }
  return unique;
}

const mxCache = new Map<string, boolean>();

async function verifyEmailMx(email: string): Promise<boolean> {
  if (!isUsableEmailCandidate(email)) return false;
  const domain = extractDomain(email);
  if (!domain) return false;
  if (mxCache.has(domain)) return mxCache.get(domain)!;

  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('MX lookup timeout')), 3000)
      ),
    ]);
    const valid =
      Array.isArray(records) && records.some((r) => Boolean(r.exchange));
    mxCache.set(domain, valid);
    return valid;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

const companyEmailLookupCache = new Map<
  string,
  { email: string; emailSource: 'company_site' | 'none'; mxVerified: boolean }
>();

function cleanCompanyNameForSearch(companyName: string): string {
  return companyName
    .replace(
      /\b(inc\.?|llc|ltd\.?|corp\.?|corporation|group|hq|technologies|technology|international|labs|systems|solutions)\b/gi,
      ' '
    )
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveCompanyEmailViaGitHubAndSite(companyName: string): Promise<{
  email: string;
  emailSource: 'company_site' | 'none';
  mxVerified: boolean;
}> {
  const cleanName = cleanCompanyNameForSearch(companyName);
  if (!cleanName || cleanName.length < 2) {
    return { email: '', emailSource: 'none', mxVerified: false };
  }
  const cacheKey = cleanName.toLowerCase();
  if (companyEmailLookupCache.has(cacheKey)) {
    return companyEmailLookupCache.get(cacheKey)!;
  }

  const primaryToken = cleanName.split(' ')[0]?.toLowerCase() || '';
  const searchRes = await fetchJsonWithTimeout<{
    items?: Array<{ login?: string; url?: string }>;
  }>(
    `https://api.github.com/search/users?q=${encodeURIComponent(cleanName)}+type:org&per_page=3`
  );

  for (const item of searchRes?.items || []) {
    if (!item.login) continue;
    const detail = await fetchJsonWithTimeout<{
      login?: string;
      name?: string | null;
      email?: string | null;
      blog?: string | null;
    }>(`https://api.github.com/users/${item.login}`);
    if (!detail) continue;

    const orgText = `${detail.login || ''} ${detail.name || ''}`.toLowerCase();
    if (primaryToken && !orgText.includes(primaryToken)) {
      continue;
    }

    if (detail.email && (await verifyEmailMx(detail.email))) {
      const hit = {
        email: detail.email.trim(),
        emailSource: 'company_site' as const,
        mxVerified: true,
      };
      companyEmailLookupCache.set(cacheKey, hit);
      return hit;
    }

    if (detail.blog) {
      const siteUrl = /^https?:\/\//i.test(detail.blog)
        ? detail.blog
        : `https://${detail.blog}`;
      const html = await fetchTextWithTimeout(siteUrl, 3500);
      if (html) {
        const mailtoMatches = Array.from(
          html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi)
        ).map((m) => m[1]);
        for (const candidate of mailtoMatches) {
          if (isUsableEmailCandidate(candidate) && (await verifyEmailMx(candidate))) {
            const hit = {
              email: candidate,
              emailSource: 'company_site' as const,
              mxVerified: true,
            };
            companyEmailLookupCache.set(cacheKey, hit);
            return hit;
          }
        }
      }
    }
  }

  const miss = { email: '', emailSource: 'none' as const, mxVerified: false };
  companyEmailLookupCache.set(cacheKey, miss);
  return miss;
}

async function findVerifiedHiringEmail(
  descriptionText: string,
  postingUrl: string,
  companyName?: string
): Promise<{
  email: string;
  emailSource: 'job_post' | 'company_site' | 'none';
  mxVerified: boolean;
}> {
  for (const candidate of extractEmailsFromText(descriptionText)) {
    if (await verifyEmailMx(candidate)) {
      return { email: candidate, emailSource: 'job_post', mxVerified: true };
    }
  }

  if (postingUrl && /^https?:\/\//i.test(postingUrl)) {
    const html = await fetchTextWithTimeout(postingUrl, 4000);
    if (html) {
      const mailtoMatches = Array.from(
        html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi)
      ).map((m) => m[1]);
      for (const candidate of mailtoMatches) {
        if (isUsableEmailCandidate(candidate) && (await verifyEmailMx(candidate))) {
          return {
            email: candidate,
            emailSource: 'company_site',
            mxVerified: true,
          };
        }
      }
    }
  }

  if (companyName) {
    const resolved = await resolveCompanyEmailViaGitHubAndSite(companyName);
    if (resolved.mxVerified && resolved.email) {
      return resolved;
    }
  }

  return { email: '', emailSource: 'none', mxVerified: false };
}

function getSystemBrowserExecutable(): string | null {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const exe of candidates) {
    if (fsSync.existsSync(exe)) return exe;
  }
  return null;
}

async function attemptWebPortalAutoApply(
  job: ScoutedJob,
  profile: UserProfile
): Promise<{
  status: 'applied' | 'captcha_required';
  applyUrl: string;
  details: string;
}> {
  const executablePath = getSystemBrowserExecutable();
  if (!executablePath) {
    return {
      status: 'captcha_required',
      applyUrl: job.postingUrl,
      details:
        'No local Chrome or Edge browser binary found for automated portal form filling. Open the portal manually to apply.',
    };
  }

  const tailoredCv = buildTailoredCvDocBase64(profile.cvText, job.role, job.fitFeedback);
  const cvFilePath = path.resolve(process.cwd(), 'Oguike_Godswill_CV.doc');
  if (tailoredCv.base64) {
    await fs.writeFile(cvFilePath, Buffer.from(tailoredCv.base64, 'base64')).catch(() => {});
  } else if (!fsSync.existsSync(cvFilePath) && profile.cvAttachmentBase64) {
    await fs.writeFile(
      cvFilePath,
      Buffer.from(profile.cvAttachmentBase64, 'base64')
    );
  }

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });

  let currentUrl = job.postingUrl;

  try {
    const page = await browser.newPage();
    await page.addInitScript('window.__name = window.__name || function(t) { return t; };');
    await page.goto(job.postingUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 12000,
    });
    await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    currentUrl = page.url();

    const detectGate = async () => {
      const title = await page.title().catch(() => '');
      const bodyText = await page
        .evaluate(() => document.body?.innerText?.slice(0, 2500) || '')
        .catch(() => '');
      const hasCaptchaDom = await page
        .evaluate(() =>
          Boolean(
            document.querySelector(
              '[class*="cf-turnstile"], [class*="g-recaptcha"], [class*="h-captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]'
            )
          )
        )
        .catch(() => false);

      const gateTextMatch =
        /just a moment|verify you are human|checking your browser|attention required|sign in to apply|log in to apply|create an account to apply/i.test(
          `${title} ${bodyText}`
        );

      return hasCaptchaDom || gateTextMatch;
    };

    if (await detectGate()) {
      return {
        status: 'captcha_required',
        applyUrl: currentUrl,
        details:
          'External portal requires human verification (CAPTCHA / Turnstile) or account sign-in before applying.',
      };
    }

    // Follow external "Apply" button/link on aggregator listings (e.g., WeWorkRemotely / Remotive / Jobicy)
    const externalApplyHref = await page
      .evaluate((curHost) => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const applyLink = links.find((a) => {
          const txt = (a.textContent || '').trim();
          const href = a.getAttribute('href') || '';
          if (!/^https?:\/\//i.test(href)) return false;
          const isApplyText =
            /apply for this (job|position)|apply now|apply externally|apply on company|apply for job/i.test(
              txt
            ) || /^apply$/i.test(txt);
          try {
            const u = new URL(href);
            return isApplyText && (u.hostname !== curHost || /\/apply/i.test(href));
          } catch {
            return false;
          }
        });
        return applyLink?.getAttribute('href') || null;
      }, new URL(currentUrl).hostname)
      .catch(() => null);

    if (externalApplyHref) {
      await page.goto(externalApplyHref, {
        waitUntil: 'domcontentloaded',
        timeout: 12000,
      });
      await page.waitForLoadState('load', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(800);
      currentUrl = page.url();
      if (await detectGate()) {
        return {
          status: 'captcha_required',
          applyUrl: currentUrl,
          details:
            'External application portal presented a CAPTCHA / anti-bot verification or login gate.',
        };
      }
    }

    const formInfo = await page
      .evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        for (let i = 0; i < forms.length; i++) {
          const form = forms[i];
          const meta = `${form.id} ${form.className} ${form.getAttribute('action') || ''} ${form.textContent?.slice(0, 300) || ''}`.toLowerCase();
          if (/newsletter|subscribe|job alert|sign in|log in|login|search/.test(meta) && !form.querySelector('input[type="file"]')) {
            continue;
          }
          const hasFile = Boolean(form.querySelector('input[type="file"]'));
          const hasEmail = Boolean(
            form.querySelector('input[type="email"], input[name*="email" i], input[id*="email" i]')
          );
          const hasExtraField = Boolean(
            form.querySelector(
              'input[name*="name" i], input[type="tel"], input[name*="phone" i], textarea'
            )
          );
          const hasApplyCue = /apply|application|candidate|resume|cv|submit/.test(meta);
          if (hasFile || (hasEmail && hasExtraField && hasApplyCue)) {
            return { hasForm: true, formIndex: i };
          }
        }
        const standaloneFile = document.querySelector('input[type="file"]');
        return { hasForm: Boolean(standaloneFile), formIndex: -1 };
      })
      .catch(() => ({ hasForm: false, formIndex: -1 }));

    if (!formInfo.hasForm) {
      return {
        status: 'captcha_required',
        applyUrl: currentUrl,
        details:
          'Portal uses an external/JS workflow (or no direct HTML application form detected); open portal manually to apply.',
      };
    }

    const nameParts = profile.name.trim().split(/\s+/);
    const firstName = nameParts[0] || 'Oguike';
    const lastName = nameParts.slice(1).join(' ') || 'Godswill';

    await page
      .evaluate(
        (data) => {
          const forms = Array.from(document.querySelectorAll('form'));
          const root: ParentNode =
            data.formIndex >= 0 && forms[data.formIndex] ? forms[data.formIndex] : document;

          const mappings: Array<[string[], string]> = [
            [
              [
                'input[name="first_name"]',
                'input[id="first_name"]',
                'input[name="firstname"]',
                'input[name*="first" i]',
                'input[id*="first" i]',
              ],
              data.firstName,
            ],
            [
              [
                'input[name="last_name"]',
                'input[id="last_name"]',
                'input[name="lastname"]',
                'input[name*="last" i]',
                'input[id*="last" i]',
              ],
              data.lastName,
            ],
            [
              [
                'input[name="name"]',
                'input[name="candidate.name"]',
                'input[name="name" i]',
                'input[id="name" i]',
                'input[autocomplete="name"]',
              ],
              data.fullName,
            ],
            [
              [
                'input[name="email"]',
                'input[id="email"]',
                'input[type="email"]',
                'input[name*="email" i]',
                'input[id*="email" i]',
              ],
              data.email,
            ],
            [
              [
                'input[name="phone"]',
                'input[id="phone"]',
                'input[type="tel"]',
                'input[name*="phone" i]',
                'input[id*="phone" i]',
              ],
              data.phone,
            ],
            [
              ['input[name="org"]', 'input[name*="company" i]', 'input[id*="company" i]'],
              'ConnectNigeria',
            ],
            [
              ['input[name="location"]', 'input[name*="location" i]', 'input[id*="location" i]'],
              'Lagos, Nigeria',
            ],
            [
              [
                'input[name="urls[LinkedIn]"]',
                'input[name*="linkedin" i]',
                'input[id*="linkedin" i]',
                'input[placeholder*="linkedin" i]',
              ],
              'https://linkedin.com/in/oguikegodswill/',
            ],
            [
              [
                'input[name="urls[GitHub]"]',
                'input[name*="github" i]',
                'input[id*="github" i]',
                'input[placeholder*="github" i]',
              ],
              'https://github.com/oguike-godswill',
            ],
            [
              [
                'input[name="urls[Portfolio]"]',
                'input[name="urls[Personal Website]"]',
                'input[name*="website" i]',
                'input[name*="portfolio" i]',
                'input[id*="website" i]',
              ],
              'https://oguikegodswill.vercel.app',
            ],
            [
              [
                'textarea[name="comments"]',
                'textarea[id="cover_letter_text"]',
                'textarea[name*="cover" i]',
                'textarea[id*="cover" i]',
                'textarea[name*="comment" i]',
                'textarea',
              ],
              data.coverLetter,
            ],
          ];

          for (let m = 0; m < mappings.length; m++) {
            const selectors = mappings[m][0];
            const val = mappings[m][1];
            for (let s = 0; s < selectors.length; s++) {
              const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selectors[s]);
              if (el && !el.value) {
                el.focus();
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                break;
              }
            }
          }
        },
        {
          formIndex: formInfo.formIndex,
          firstName,
          lastName,
          fullName: profile.name,
          email: profile.email,
          phone: '+234 706 086 8353',
          coverLetter: job.coverLetter,
        }
      )
      .catch(() => {});

    const fileInput = await page
      .$('input#resume-upload-input, input[name="resume"], input[type="file"]')
      .catch(() => null);
    if (fileInput && fsSync.existsSync(cvFilePath)) {
      await fileInput.setInputFiles(cvFilePath).catch(() => {});
    }

    // Re-check for CAPTCHA or unfilled required custom inputs before submitting
    const submitGateCheck = await page
      .evaluate((formIndex) => {
        const forms = Array.from(document.querySelectorAll('form'));
        const root: ParentNode =
          formIndex >= 0 && forms[formIndex] ? forms[formIndex] : document;
        const hasCaptcha = Boolean(
          document.querySelector(
            '[class*="cf-turnstile"], [class*="g-recaptcha"], [class*="h-captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]'
          )
        );
        const requiredEmpty = Array.from(
          root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            '[required]'
          )
        ).filter((el) => {
          if (el.type === 'file' || el.type === 'hidden') return false;
          return !el.value || !el.value.trim();
        }).length;
        return { hasCaptcha, requiredEmpty };
      }, formInfo.formIndex)
      .catch(() => ({ hasCaptcha: true, requiredEmpty: 1 }));

    if (submitGateCheck.hasCaptcha || submitGateCheck.requiredEmpty > 0) {
      return {
        status: 'captcha_required',
        applyUrl: currentUrl,
        details: submitGateCheck.hasCaptcha
          ? 'Portal form requires human CAPTCHA verification before submission.'
          : `Portal form has ${submitGateCheck.requiredEmpty} custom required question(s) needing manual review.`,
      };
    }

    const submitBtn = await page
      .$(
        'button[type="submit"], input[type="submit"], button:has-text("Submit Application"), button:has-text("Submit")'
      )
      .catch(() => null);
    if (!submitBtn) {
      return {
        status: 'captcha_required',
        applyUrl: currentUrl,
        details: 'No standard submit button located; open portal URL to submit manually.',
      };
    }

    await submitBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const postSubmitText = await page
      .evaluate(() => document.body?.innerText?.slice(0, 1500) || '')
      .catch(() => '');
    if (
      /thank you|application (has been )?(received|submitted)|we have received your application/i.test(
        postSubmitText
      )
    ) {
      return {
        status: 'applied',
        applyUrl: page.url(),
        details: 'Application form filled with Oguike_Godswill_CV.doc and submitted.',
      };
    }

    return {
      status: 'captcha_required',
      applyUrl: page.url(),
      details:
        'Form submission could not be confirmed automatically (CAPTCHA or validation prompt). Please review in browser.',
    };
  } catch (err) {
    return {
      status: 'captcha_required',
      applyUrl: currentUrl,
      details: `Portal automation paused (${
        err instanceof Error ? err.message.slice(0, 100) : 'navigation error'
      }). Open portal manually to apply.`,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

function buildSentCompanyAndDomainSets(state: AppStatePayload): {
  sentCompanies: Set<string>;
  sentDomains: Set<string>;
} {
  const sentCompanies = new Set<string>();
  const sentDomains = new Set<string>();

  for (const app of state.applications) {
    if (app.status !== 'bounced') {
      sentCompanies.add(app.company.toLowerCase());
      const dom = extractDomain(app.recipientEmail);
      if (dom) sentDomains.add(dom);
    }
  }
  for (const lead of state.coldLeads || []) {
    if (lead.status === 'sent' || lead.status === 'followed_up' || lead.status === 'replied') {
      sentCompanies.add(lead.company.toLowerCase());
      const dom = extractDomain(lead.contactEmail);
      if (dom) sentDomains.add(dom);
    }
  }
  return { sentCompanies, sentDomains };
}

async function fetchJsonWithTimeout<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'CareerRelay/1.0' },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function scoutLivePublicJobBoards(
  profile: UserProfile,
  existingTitles: Set<string>
): Promise<ScoutedJob[]> {
  const remotiveUrls = [
    'https://remotive.com/api/remote-jobs?category=software-dev&search=frontend&limit=20',
    'https://remotive.com/api/remote-jobs?category=software-dev&search=react&limit=20',
    'https://remotive.com/api/remote-jobs?category=software-dev&search=flutter&limit=15',
  ];
  const jobicyUrls = [
    'https://jobicy.com/api/v2/remote-jobs?count=20&tag=react',
    'https://jobicy.com/api/v2/remote-jobs?count=15&tag=flutter',
  ];
  const wwrRssUrls = [
    'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',
    'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
  ];

  const hnStoryPromise = fetchJsonWithTimeout<{
    hits?: Array<{ objectID?: string; title?: string }>;
  }>(
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=Who%20is%20hiring&hitsPerPage=1'
  ).then(async (storyRes) => {
    const sid = storyRes?.hits?.[0]?.objectID;
    if (!sid) return [];
    const [reactHits, flutterHits] = await Promise.all([
      fetchJsonWithTimeout<{
        hits?: Array<{ objectID?: string; comment_text?: string }>;
      }>(
        `https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${sid}&query=react&hitsPerPage=15`
      ),
      fetchJsonWithTimeout<{
        hits?: Array<{ objectID?: string; comment_text?: string }>;
      }>(
        `https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${sid}&query=flutter&hitsPerPage=12`
      ),
    ]);
    return [...(reactHits?.hits || []), ...(flutterHits?.hits || [])];
  });

  const [
    remotiveResults,
    jobicyResults,
    wwrResults,
    remoteOkRaw,
    hnHits,
    arbeitnowRes,
    workingNomadsRaw,
    himalayasRes,
    ashbySupabase,
    ashbyPosthog,
    greenhouseGrafana,
  ] = await Promise.all([
    Promise.all(
      remotiveUrls.map((u) =>
        fetchJsonWithTimeout<{
          jobs?: Array<{
            title?: string;
            company_name?: string;
            candidate_required_location?: string;
            url?: string;
            tags?: string[];
            description?: string;
          }>;
        }>(u)
      )
    ),
    Promise.all(
      jobicyUrls.map((u) =>
        fetchJsonWithTimeout<{
          jobs?: Array<{
            jobTitle?: string;
            companyName?: string;
            jobGeo?: string;
            url?: string;
            jobExcerpt?: string;
            jobDescription?: string;
          }>;
        }>(u)
      )
    ),
    Promise.all(wwrRssUrls.map((u) => fetchTextWithTimeout(u))),
    fetchJsonWithTimeout<
      Array<{
        position?: string;
        company?: string;
        location?: string;
        url?: string;
        tags?: string[];
        description?: string;
      }>
    >('https://remoteok.com/api'),
    hnStoryPromise,
    fetchJsonWithTimeout<{
      data?: Array<{
        company_name?: string;
        title?: string;
        description?: string;
        remote?: boolean;
        url?: string;
        tags?: string[];
        location?: string;
      }>;
    }>('https://www.arbeitnow.com/api/job-board-api'),
    fetchJsonWithTimeout<
      Array<{
        url?: string;
        title?: string;
        description?: string;
        company_name?: string;
        category_name?: string;
        tags?: string;
        location?: string;
      }>
    >('https://www.workingnomads.com/api/exposed_jobs/'),
    fetchJsonWithTimeout<{
      jobs?: Array<{
        title?: string;
        companyName?: string;
        description?: string;
        excerpt?: string;
        applicationLink?: string;
        guid?: string;
        categories?: string[];
        locationRestrictions?: string[];
      }>;
    }>('https://himalayas.app/jobs/api?limit=25'),
    fetchJsonWithTimeout<{
      jobs?: Array<{
        title?: string;
        location?: string;
        isRemote?: boolean;
        jobUrl?: string;
        applyUrl?: string;
        descriptionPlain?: string;
      }>;
    }>('https://api.ashbyhq.com/posting-api/job-board/supabase'),
    fetchJsonWithTimeout<{
      jobs?: Array<{
        title?: string;
        location?: string;
        isRemote?: boolean;
        jobUrl?: string;
        applyUrl?: string;
        descriptionPlain?: string;
      }>;
    }>('https://api.ashbyhq.com/posting-api/job-board/posthog'),
    fetchJsonWithTimeout<{
      jobs?: Array<{
        title?: string;
        location?: { name?: string };
        absolute_url?: string;
        company_name?: string;
      }>;
    }>('https://boards-api.greenhouse.io/v1/boards/grafanalabs/jobs'),
  ]);

  const rawList: NormalizedBoardJob[] = [];

  // 1A.1 Hacker News "Who Is Hiring?" Algolia comments (frequently contain direct emails)
  const seenHnIds = new Set<string>();
  for (const hit of hnHits || []) {
    if (!hit.objectID || !hit.comment_text || seenHnIds.has(hit.objectID)) continue;
    seenHnIds.add(hit.objectID);
    const firstChunk = hit.comment_text.split(/<p>/i)[0] || '';
    const headerLine = stripHtmlText(firstChunk).replace(/\*+/g, '').trim();
    const parts = headerLine
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;
    const company = parts[0].slice(0, 80);
    const role =
      parts.find((p, idx) => idx > 0 && /engineer|developer|frontend|react|flutter|full.?stack|mobile/i.test(p)) ||
      parts[1];
    const locPart =
      parts.find((p, idx) => idx > 0 && p !== role && /remote|onsite|hybrid|nyc|sf|london|berlin|europe|worldwide|us|uk|lagos|global/i.test(p)) ||
      'Remote';
    if (!company || !role) continue;
    rawList.push({
      role,
      company,
      location: locPart,
      postingUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      tags: ['HackerNews'],
      descriptionText: stripHtmlText(hit.comment_text),
      source: 'Hacker News Who Is Hiring API',
    });
  }

  // 1A.2 Arbeitnow Public Job Board API
  for (const item of (arbeitnowRes?.data || []).slice(0, 35)) {
    if (!item.title || !item.company_name || !item.url) continue;
    rawList.push({
      role: item.title.trim(),
      company: item.company_name.trim(),
      location: item.remote
        ? `Remote (${item.location || 'Worldwide'})`
        : item.location?.trim() || 'Remote',
      postingUrl: item.url.trim(),
      tags: Array.isArray(item.tags) ? item.tags : [],
      descriptionText: stripHtmlText(item.description),
      source: 'Arbeitnow Live Job API',
    });
  }

  // 1A.3 Working Nomads Public API
  for (const item of (workingNomadsRaw || []).slice(0, 35)) {
    if (!item.title || !item.company_name || !item.url) continue;
    rawList.push({
      role: item.title.trim(),
      company: item.company_name.trim(),
      location: item.location?.trim() || 'Remote',
      postingUrl: item.url.trim(),
      tags: item.tags ? item.tags.split(',').map((t) => t.trim()) : [],
      descriptionText: stripHtmlText(item.description),
      source: 'Working Nomads Live API',
    });
  }

  // 1A.4 Himalayas Remote Jobs API
  for (const item of himalayasRes?.jobs || []) {
    const postingUrl = item.applicationLink || item.guid;
    if (!item.title || !item.companyName || !postingUrl) continue;
    rawList.push({
      role: item.title.trim(),
      company: item.companyName.trim(),
      location:
        Array.isArray(item.locationRestrictions) && item.locationRestrictions.length > 0
          ? item.locationRestrictions.join(', ')
          : 'Remote Worldwide',
      postingUrl: postingUrl.trim(),
      tags: Array.isArray(item.categories) ? item.categories : [],
      descriptionText: stripHtmlText(item.description || item.excerpt),
      source: 'Himalayas Remote Jobs API',
    });
  }

  // 1A.5 Direct Public ATS JSON Feeds (Ashby & Greenhouse)
  const ashbyBoards: Array<{ company: string; res: typeof ashbySupabase }> = [
    { company: 'Supabase', res: ashbySupabase },
    { company: 'PostHog', res: ashbyPosthog },
  ];
  for (const board of ashbyBoards) {
    for (const item of (board.res?.jobs || []).slice(0, 25)) {
      const url = item.applyUrl || item.jobUrl;
      if (!item.title || !url) continue;
      rawList.push({
        role: item.title.trim(),
        company: board.company,
        location: item.isRemote ? `Remote (${item.location || 'Global'})` : item.location || 'Remote',
        postingUrl: url.trim(),
        tags: ['Ashby ATS'],
        descriptionText: item.descriptionPlain || '',
        source: 'Direct ATS API (Ashby / Greenhouse)',
      });
    }
  }
  for (const item of (greenhouseGrafana?.jobs || []).slice(0, 25)) {
    if (!item.title || !item.absolute_url) continue;
    rawList.push({
      role: item.title.trim(),
      company: item.company_name?.trim() || 'Grafana Labs',
      location: item.location?.name?.trim() || 'Remote',
      postingUrl: item.absolute_url.trim(),
      tags: ['Greenhouse ATS'],
      descriptionText: `${item.title} at Grafana Labs (${item.location?.name || 'Remote'})`,
      source: 'Direct ATS API (Ashby / Greenhouse)',
    });
  }

  for (const xml of wwrResults) {
    if (!xml) continue;
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];
    for (const block of itemMatches.slice(0, 25)) {
      const fullTitle = extractXmlTag(block, 'title');
      const postingUrl = extractXmlTag(block, 'link');
      const region = extractXmlTag(block, 'region') || 'Anywhere in the World';
      const desc = stripHtmlText(extractXmlTag(block, 'description'));
      const colonIdx = fullTitle.indexOf(':');
      if (colonIdx === -1 || !postingUrl) continue;
      const company = fullTitle.slice(0, colonIdx).trim();
      const role = fullTitle.slice(colonIdx + 1).trim();
      if (!company || !role) continue;
      rawList.push({
        role,
        company,
        location: region,
        postingUrl,
        tags: [],
        descriptionText: desc,
        source: 'WeWorkRemotely Live Feed',
      });
    }
  }

  for (const item of (remoteOkRaw || []).slice(1, 50)) {
    if (!item.position || !item.company || !item.url) continue;
    rawList.push({
      role: item.position.trim(),
      company: item.company.trim(),
      location: item.location?.trim() || 'Worldwide',
      postingUrl: item.url.trim(),
      tags: Array.isArray(item.tags) ? item.tags : [],
      descriptionText: stripHtmlText(item.description),
      source: 'RemoteOK Live Job Feed',
    });
  }

  for (const res of remotiveResults) {
    for (const item of res?.jobs || []) {
      if (!item.title || !item.company_name || !item.url) continue;
      rawList.push({
        role: item.title.trim(),
        company: item.company_name.trim(),
        location: item.candidate_required_location?.trim() || 'Remote',
        postingUrl: item.url.trim(),
        tags: Array.isArray(item.tags) ? item.tags : [],
        descriptionText: stripHtmlText(item.description),
        source: 'Remotive Live Job Feed',
      });
    }
  }

  for (const res of jobicyResults) {
    for (const item of res?.jobs || []) {
      if (!item.jobTitle || !item.companyName || !item.url) continue;
      rawList.push({
        role: item.jobTitle.trim(),
        company: item.companyName.trim(),
        location: item.jobGeo?.trim() || 'Remote',
        postingUrl: item.url.trim(),
        tags: [],
        descriptionText: stripHtmlText(item.jobDescription || item.jobExcerpt),
        source: 'Jobicy Live Job Feed',
      });
    }
  }

  const seenBatch = new Set<string>();
  const cvLower = profile.cvText.toLowerCase();
  const targetRoleLower = profile.targetRole.toLowerCase();
  const coreTechChecks = [
    'React',
    'Next.js',
    'TypeScript',
    'JavaScript',
    'Tailwind',
    'HTML',
    'CSS',
    'Node.js',
    'MongoDB',
    'PostgreSQL',
    'Prisma',
    'Stripe',
    'REST API',
    'Figma',
    'Flutter',
  ];
  const gapTechChecks = [
    'GraphQL',
    'Jest',
    'Cypress',
    'Playwright',
    'Docker',
    'AWS',
    'Redux',
    'Storybook',
    'Dart',
    'React Native',
    'CI/CD',
    'Kubernetes',
    'Vue',
    'Angular',
  ];

  interface PreScoredCandidate {
    raw: NormalizedBoardJob;
    score: number;
    fitFeedback: string;
    cvGaps: string[];
    cvHighlights: string[];
    matchedSkills: string[];
  }

  const preScored: PreScoredCandidate[] = [];
  const now = new Date().toISOString();

  for (const job of rawList) {
    const key = `${job.company.toLowerCase()}::${job.role.toLowerCase()}`;
    if (existingTitles.has(key) || seenBatch.has(key)) continue;
    seenBatch.add(key);

    const roleLower = job.role.toLowerCase();
    const roleAndTags = `${job.role} ${job.tags.join(' ')}`.toLowerCase();
    const excludedRole =
      /backend|devops|sre|ubuntu|kernel|embedded|lending manager|client service|risk control|office assistant|virtual assistant|marketing|sales|recruiter|human resources|customer support|copywriter|analyst/.test(
        roleLower
      );
    const relevantRole =
      !excludedRole &&
      /frontend|front-end|react|next\.?js|typescript|javascript|flutter|ui engineer|web developer|mobile developer|product engineer|full.?stack/.test(
        roleLower
      );
    if (!relevantRole) continue;

    const fullTextLower = `${roleAndTags} ${job.descriptionText}`.toLowerCase();
    const matchedSkills = coreTechChecks.filter((tech) => {
      const t = tech.toLowerCase();
      return (
        fullTextLower.includes(t) &&
        (cvLower.includes(t) || cvLower.includes(t.replace('.', '')))
      );
    });

    const missingSkills = gapTechChecks.filter((tech) => {
      const t = tech.toLowerCase();
      return fullTextLower.includes(t) && !cvLower.includes(t);
    });

    const locLower = job.location.toLowerCase();
    const allowsGlobalOrAfrica =
      ((/worldwide|anywhere|global|emea|africa|nigeria|\bremote\b/.test(locLower) ||
        locLower === '') &&
        !/\b(us only|usa only|u\.s\. only|canada only|uk only|onsite|on-site)\b/.test(
          locLower
        ));
    const isRegionRestricted = !allowsGlobalOrAfrica;

    let score = 68 + Math.min(20, matchedSkills.length * 4);
    if (
      /frontend|front-end|react|flutter/.test(roleLower) &&
      (/frontend|react|flutter/.test(targetRoleLower) || cvLower.includes('react'))
    ) {
      score += 6;
    }
    if (allowsGlobalOrAfrica) score += 6;
    if (isRegionRestricted) score -= 22;
    score = Math.max(55, Math.min(95, score));

    const cvGaps: string[] = [];
    if (missingSkills.length > 0) {
      cvGaps.push(
        `Posting mentions ${missingSkills.slice(0, 3).join(', ')} — not emphasized on CV`
      );
    }
    if (isRegionRestricted) {
      cvGaps.push(`Location restriction (${job.location}) vs ${profile.targetLocation}`);
    }
    if (cvGaps.length === 0) {
      cvGaps.push('Quantify performance & automated test coverage metrics in CV summary');
    }

    const cvHighlights: string[] = [];
    if (cvLower.includes('connectnigeria')) {
      cvHighlights.push(
        'Frontend Engineer on ConnectNigeria.com (responsive redesign & checkout API flows)'
      );
    }
    if (cvLower.includes('molearn') || cvLower.includes('legitautos')) {
      cvHighlights.push(
        'Built full-stack Next.js, TypeScript, Tailwind CSS, PostgreSQL/MongoDB apps (Molearn & LegitAutos)'
      );
    }
    if (cvHighlights.length === 0) {
      cvHighlights.push(
        `Matched core stack: ${matchedSkills.slice(0, 4).join(', ') || 'Frontend Web & UI'}`
      );
    }

    const fitFeedback = `${
      matchedSkills.length > 0
        ? `Matched ${matchedSkills.slice(0, 5).join(', ')} from live ${job.source.replace(
            / Live (Job )?Feed/,
            ''
          )} posting`
        : `Frontend/UI alignment from live ${job.source.replace(
            / Live (Job )?Feed/,
            ''
          )} posting`
    }; location listed as "${job.location}".`;

    preScored.push({
      raw: job,
      score,
      fitFeedback,
      cvGaps,
      cvHighlights,
      matchedSkills,
    });
  }

  const sorted = preScored.sort((a, b) => {
    const aHasEmail = extractEmailsFromText(a.raw.descriptionText).length > 0 ? 12 : 0;
    const bHasEmail = extractEmailsFromText(b.raw.descriptionText).length > 0 ? 12 : 0;
    return b.score + bHasEmail - (a.score + aHasEmail);
  });
  const topCandidates: PreScoredCandidate[] = [];
  const sourceCounts = new Map<string, number>();
  for (const item of sorted) {
    if (topCandidates.length >= 8) break;
    const sc = sourceCounts.get(item.raw.source) || 0;
    if (sc >= 2 && sorted.length > 8) continue;
    sourceCounts.set(item.raw.source, sc + 1);
    topCandidates.push(item);
  }
  const resolvedJobs = await Promise.all(
    topCandidates.map(async (item, idx) => {
      const verified = await findVerifiedHiringEmail(
        item.raw.descriptionText,
        item.raw.postingUrl,
        item.raw.company
      );
      const status: JobStatus =
        item.score < profile.matchThreshold
          ? 'below_threshold'
          : verified.mxVerified && verified.email
            ? 'ready_to_send'
            : 'portal_only';

      return {
        id: `job-live-${Date.now()}-${idx}`,
        role: item.raw.role,
        company: item.raw.company,
        location: item.raw.location,
        postingUrl: item.raw.postingUrl,
        recruiterEmail: verified.email,
        emailSource: verified.emailSource,
        mxVerified: verified.mxVerified,
        matchScore: item.score,
        fitFeedback: item.fitFeedback,
        cvGaps: item.cvGaps,
        cvHighlights: item.cvHighlights,
        coverLetter: `Hi ${item.raw.company} Hiring Team,

I am applying for the ${item.raw.role} position. As a Frontend & Cross-Platform Engineer based in ${profile.targetLocation}, I build production React/Next.js web applications (ConnectNigeria Marketplace & Creator, LegitAutos, Molearn, PocketGuard) as well as Flutter mobile apps (RunBuddy, Solis, Verso) backed by TypeScript, Tailwind CSS, PostgreSQL, Supabase, and MongoDB. I see strong alignment with your stack${
          item.matchedSkills.length > 0
            ? ` (${item.matchedSkills.slice(0, 5).join(', ')})`
            : ''
        }.

Key highlights from my background:
${item.cvHighlights.map((h) => `• ${h}`).join('\n')}

My CV is attached and live projects are available at oguikegodswill.vercel.app (GitHub: github.com/oguike-godswill). I would welcome the chance to connect.

Best regards,
${profile.name}`,
        status,
        source: item.raw.source,
        createdAt: now,
        updatedAt: now,
      } satisfies ScoutedJob;
    })
  );

  return resolvedJobs;
}

function normalizeWebsiteUrl(raw: string | undefined): string {
  if (!raw || !raw.trim()) return '';
  const t = raw.trim();
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

function buildColdPitchForCompany(params: {
  company: string;
  contactEmail: string;
  websiteUrl: string;
  githubUrl?: string;
  location: string;
  companyBio: string;
  source: string;
  profile: UserProfile;
}): ColdEmailLead {
  const now = new Date().toISOString();
  const bioLine = params.companyBio
    ? `I have been following what your team is building at ${params.company} (${params.companyBio.slice(
        0,
        140
      )})`
    : `I have been following ${params.company}'s work${
        params.websiteUrl ? ` (${params.websiteUrl})` : ''
      }`;

  const subject = `Frontend Engineer (React / Next.js / Flutter) — ${params.company}`;
  const pitchBody = `Hi ${params.company} Team,

${bioLine} and wanted to reach out directly.

I am a Frontend & Cross-Platform Engineer in ${params.location || 'Lagos, Nigeria'} shipping both production React/Next.js web apps (ConnectNigeria Marketplace & Creator, LegitAutos at https://legitautomobile.com/, Molearn, and PocketGuard) and Flutter mobile apps (RunBuddy, Solis, and Verso).

Are you looking for an extra pair of hands on your frontend or mobile engineering team this quarter? I have attached my CV (${
    params.profile.cvAttachmentName || 'Oguike_Godswill_CV.doc'
  }) and my portfolio is at https://oguikegodswill.vercel.app.

Best regards,
${params.profile.name}
+234 706 086 8353 · ${params.profile.email}`;

  const followUpBody = `Hi ${params.company} Team,

Just floating my note back up in case it got buried—I would love to connect if you have any upcoming Frontend (React/Next.js/TypeScript) or Flutter work at ${params.company}. My CV is attached again for convenience.

Best regards,
${params.profile.name}
+234 706 086 8353 · https://oguikegodswill.vercel.app`;

  return {
    id: `cold-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    company: params.company,
    contactEmail: params.contactEmail,
    websiteUrl: normalizeWebsiteUrl(params.websiteUrl),
    githubUrl: params.githubUrl,
    location: params.location,
    companyBio: params.companyBio,
    subject,
    pitchBody,
    followUpBody,
    status: 'ready_to_pitch',
    source: params.source,
    createdAt: now,
    updatedAt: now,
  };
}

async function discoverColdLeads(
  profile: UserProfile,
  existingEmails: Set<string>,
  existingCompanies: Set<string>
): Promise<ColdEmailLead[]> {
  const leads: ColdEmailLead[] = [];
  const excludedOrgRegex =
    /chapter|student|university|club|gdsc|dsc|saturday|communitypro|namtes|devfest|school|academy|bootcamp|youth|awesome-|freecodecamp|roadmap|tutorial|course/i;

  const searchQueries = [
    'https://api.github.com/search/users?q=location:Lagos+type:org&per_page=25',
    'https://api.github.com/search/users?q=location:Nigeria+type:org&per_page=25',
    'https://api.github.com/search/users?q=location:Remote+type:org&per_page=25',
    'https://api.github.com/search/users?q=flutter+in:description+type:org&per_page=25',
    'https://api.github.com/search/users?q=nextjs+in:description+type:org&per_page=25',
    'https://api.github.com/search/users?q=location:London+type:org&per_page=25',
    'https://api.github.com/search/users?q=location:Berlin+type:org&per_page=25',
  ];

  const candidateLogins: Array<{ login: string; html_url?: string }> = [];
  const seenLogins = new Set<string>();

  for (const url of searchQueries) {
    if (candidateLogins.length >= 15) break;
    const res = await fetchJsonWithTimeout<{
      items?: Array<{ login?: string; html_url?: string }>;
    }>(url);
    for (const item of res?.items || []) {
      const login = item.login?.trim();
      if (!login) continue;
      const lower = login.toLowerCase();
      if (
        seenLogins.has(lower) ||
        existingCompanies.has(lower) ||
        excludedOrgRegex.test(login)
      ) {
        continue;
      }
      seenLogins.add(lower);
      candidateLogins.push({ login, html_url: item.html_url });
      if (candidateLogins.length >= 18) break;
    }
  }

  for (const cand of candidateLogins.slice(0, 18)) {
    if (leads.length >= 5) break;
    const detail = await fetchJsonWithTimeout<{
      login?: string;
      name?: string;
      email?: string | null;
      blog?: string | null;
      location?: string | null;
      description?: string | null;
      html_url?: string;
    }>(`https://api.github.com/users/${cand.login}`);

    if (!detail) continue;
    const company = (detail.name || detail.login || cand.login).trim();
    if (
      excludedOrgRegex.test(company) ||
      excludedOrgRegex.test(cand.login) ||
      existingCompanies.has(company.toLowerCase())
    ) {
      continue;
    }

    let contactEmail = '';
    let leadSource = 'GitHub Public Tech Orgs API';

    // Step A: Direct GitHub org email + DNS MX verification
    if (
      detail.email &&
      isUsableEmailCandidate(detail.email) &&
      (await verifyEmailMx(detail.email.trim()))
    ) {
      contactEmail = detail.email.trim();
    }

    // Step B: Fallback to scraping mailto: links from company website + DNS MX verification
    if (!contactEmail && detail.blog) {
      const siteUrl = normalizeWebsiteUrl(detail.blog);
      const html = siteUrl ? await fetchTextWithTimeout(siteUrl, 3500) : null;
      if (html) {
        const mailtoMatches = Array.from(
          html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi)
        ).map((m) => m[1].trim());
        for (const candidate of mailtoMatches) {
          if (isUsableEmailCandidate(candidate) && (await verifyEmailMx(candidate))) {
            contactEmail = candidate;
            leadSource = 'GitHub Org + Website Mailto';
            break;
          }
        }
      }
    }

    if (!contactEmail || existingEmails.has(contactEmail.toLowerCase())) {
      continue;
    }

    existingEmails.add(contactEmail.toLowerCase());
    existingCompanies.add(company.toLowerCase());

    leads.push(
      buildColdPitchForCompany({
        company,
        contactEmail,
        websiteUrl: detail.blog || detail.html_url || '',
        githubUrl: detail.html_url || cand.html_url,
        location: detail.location || 'Remote / Global',
        companyBio: detail.description || '',
        source: leadSource,
        profile,
      })
    );
  }

  // Step C: Expanded MX-verified pool of Nigerian/African & remote React/Next.js/Flutter companies
  if (leads.length < 3) {
    const verifiedTechOrgs = [
      {
        company: 'Paystack',
        contactEmail: 'hello@paystack.com',
        websiteUrl: 'https://paystack.com',
        githubUrl: 'https://github.com/paystack',
        location: 'Lagos, Nigeria',
        companyBio: 'Modern online and offline payments infrastructure for Africa.',
      },
      {
        company: 'Korapay',
        contactEmail: 'hello@korapay.com',
        websiteUrl: 'https://korahq.com',
        githubUrl: 'https://github.com/korapay',
        location: 'Lagos, Nigeria / Remote',
        companyBio: 'Cross-border payment infrastructure and financial APIs across Africa.',
      },
      {
        company: 'PiggyVest',
        contactEmail: 'contact@piggyvest.com',
        websiteUrl: 'https://www.piggyvest.com',
        githubUrl: 'https://github.com/PiggyVest',
        location: 'Lagos, Nigeria',
        companyBio: 'Automated savings and micro-investment platform for millions of users.',
      },
      {
        company: 'Termii',
        contactEmail: 'sales@termii.com',
        websiteUrl: 'https://termii.com',
        githubUrl: 'https://github.com/termii-developer',
        location: 'Lagos, Nigeria / Remote',
        companyBio: 'Omnichannel customer messaging and verification API platform.',
      },
      {
        company: 'Invertase',
        contactEmail: 'oss@invertase.io',
        websiteUrl: 'https://invertase.io',
        githubUrl: 'https://github.com/invertase',
        location: 'Remote (UK / Global)',
        companyBio: 'Flutter, Dart, and React Native SDK engineering & developer tools.',
      },
      {
        company: 'Very Good Ventures',
        contactEmail: 'hello@verygood.ventures',
        websiteUrl: 'https://verygood.ventures',
        githubUrl: 'https://github.com/VeryGoodOpenSource',
        location: 'Remote (Global)',
        companyBio: 'Premier Flutter app engineering consultancy building production cross-platform apps.',
      },
      {
        company: 'Nearform',
        contactEmail: 'hello@nearform.com',
        websiteUrl: 'https://www.nearform.com',
        githubUrl: 'https://github.com/nearform',
        location: 'Remote (Global)',
        companyBio: 'Global digital engineering consultancy building enterprise React, Next.js, and Node.js platforms.',
      },
      {
        company: 'Anima',
        contactEmail: 'contact@animaapp.com',
        websiteUrl: 'https://www.animaapp.com',
        githubUrl: 'https://github.com/AnimaApp',
        location: 'Remote',
        companyBio: 'Design-to-code platform converting Figma into React and frontend components.',
      },
      {
        company: 'Mono',
        contactEmail: 'support@mono.co',
        websiteUrl: 'https://mono.co',
        githubUrl: 'https://github.com/withmono',
        location: 'Lagos, Nigeria',
        companyBio: 'Open banking API infrastructure connecting African financial accounts.',
      },
      {
        company: 'Cowrywise',
        contactEmail: 'hello@cowrywise.com',
        websiteUrl: 'https://www.cowrywise.com',
        githubUrl: 'https://github.com/cowrywiseHQ',
        location: 'Lagos, Nigeria',
        companyBio: 'Digital wealth management and automated savings platform.',
      },
      {
        company: 'Seamfix',
        contactEmail: 'info@seamfix.com',
        websiteUrl: 'https://www.seamfix.com',
        githubUrl: 'https://github.com/seamfix',
        location: 'Lagos, Nigeria',
        companyBio: 'Digital identity verification and enterprise workflow platforms.',
      },
      {
        company: 'Okra',
        contactEmail: 'hello@okra.ng',
        websiteUrl: 'https://www.okra.ng',
        githubUrl: 'https://github.com/okraHQ',
        location: 'Lagos, Nigeria',
        companyBio: 'Real-time financial data and open finance APIs in Africa.',
      },
      {
        company: 'BFREE',
        contactEmail: 'tech@bfree.africa',
        websiteUrl: 'https://bfree.africa',
        githubUrl: 'https://github.com/bfree-africa',
        location: 'Lagos, Nigeria',
        companyBio: 'Ethical credit management and fintech automation platform.',
      },
    ];

    for (const item of verifiedTechOrgs) {
      if (leads.length >= 5) break;
      if (
        existingEmails.has(item.contactEmail.toLowerCase()) ||
        existingCompanies.has(item.company.toLowerCase())
      ) {
        continue;
      }
      if (!(await verifyEmailMx(item.contactEmail))) {
        continue;
      }
      existingEmails.add(item.contactEmail.toLowerCase());
      existingCompanies.add(item.company.toLowerCase());
      leads.push(
        buildColdPitchForCompany({
          ...item,
          source: 'Verified Global & African Tech Orgs (MX Checked)',
          profile,
        })
      );
    }
  }

  return leads;
}

function classifyReplyFallback(
  replyText: string,
  company: string
): {
  stage: ReplyStage;
  status: ApplicationStatus;
  feedback: string;
  nextStep: string;
} {
  const lower = replyText.toLowerCase();
  if (lower.includes('offer') || lower.includes('compensation package')) {
    return {
      stage: 'Offer',
      status: 'offer',
      feedback: `${company} signaled an offer or final compensation discussion.`,
      nextStep: 'Review compensation breakdown and schedule a call to align on start date.',
    };
  }
  if (
    lower.includes('interview') ||
    lower.includes('schedule') ||
    lower.includes('chat') ||
    lower.includes('availability')
  ) {
    return {
      stage: 'Interview',
      status: 'interviewing',
      feedback: `${company} invited you to schedule an interview conversation.`,
      nextStep: 'Reply promptly with 2-3 time slots and review system design examples from your CV.',
    };
  }
  if (
    lower.includes('assessment') ||
    lower.includes('take-home') ||
    lower.includes('coding challenge') ||
    lower.includes('exercise')
  ) {
    return {
      stage: 'Assessment',
      status: 'assessment',
      feedback: `${company} sent a technical assessment or coding exercise.`,
      nextStep: 'Check submission deadline and block focused time on your calendar.',
    };
  }
  if (
    lower.includes('unfortunately') ||
    lower.includes('not moving forward') ||
    lower.includes('other candidates') ||
    lower.includes('rejected')
  ) {
    return {
      stage: 'Rejected',
      status: 'rejected',
      feedback: `${company} decided not to advance this application to the next round.`,
      nextStep: 'Archive thread and review CV gap insights for similar roles in your queue.',
    };
  }
  return {
    stage: 'Follow-up',
    status: 'follow_up',
    feedback: `${company} requested additional details or follow-up clarification.`,
    nextStep: 'Send a concise reply addressing the recruiter question within 24 hours.',
  };
}

export async function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Attempt MongoDB startup connection, falling back gracefully to local JSON if unreachable
  try {
    await connectToMongo(DEFAULT_MONGO_URI, DEFAULT_MONGO_DB);
    console.log(
      `Connected to MongoDB (${maskMongoUri(DEFAULT_MONGO_URI)}, db=${activeMongoDbName})`
    );
  } catch (err) {
    console.warn(
      `MongoDB not reachable at startup (${maskMongoUri(DEFAULT_MONGO_URI)}). Using local fallback store (${STORE_PATH}).`,
      err instanceof Error ? err.message : ''
    );
    await readLocalMirror();
  }

  app.get('/api/health', async (_req, res) => {
    const mongoStatus = await getMongoStatus();
    const gmailCfg = getGmailSmtpConfig();
    res.json({
      ok: true,
      geminiConfigured: Boolean(getGeminiClient()),
      gmailConfigured: Boolean(gmailCfg),
      gmailEmail: gmailCfg?.user || null,
      model: GEMINI_MODEL,
      persistence: mongoStatus.engine,
      mongoConnected: mongoStatus.connected,
      authRequired: Boolean(ADMIN_PASSWORD),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/auth/session', (req, res) => {
    res.json({
      authRequired: Boolean(ADMIN_PASSWORD),
      authenticated: isRequestAuthenticated(req),
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const submitted = String(req.body?.password || '').trim();
    if (ADMIN_PASSWORD && !safeEqual(submitted, ADMIN_PASSWORD)) {
      res.status(401).json({ error: 'Invalid admin password.' });
      return;
    }
    if (ADMIN_PASSWORD) {
      const token = computeSessionToken(ADMIN_PASSWORD);
      res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(
          token
        )}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`
      );
    }
    res.json({ ok: true, authenticated: true });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
    );
    res.json({ ok: true, authenticated: false });
  });

  app.use('/api', (req, res, next) => {
    if (!isRequestAuthenticated(req)) {
      res.status(401).json({ error: 'Unauthorized: admin login required.' });
      return;
    }
    next();
  });

  app.get('/api/gmail/status', (_req, res) => {
    const cfg = getGmailSmtpConfig();
    res.json({
      configured: Boolean(cfg),
      email: cfg?.user || null,
    });
  });

  app.post('/api/gmail/send', async (req, res) => {
    if (!getGmailSmtpConfig()) {
      res.status(400).json({ error: 'Server Gmail SMTP is not configured in .env' });
      return;
    }

    try {
      const {
        toEmail,
        subject,
        bodyText,
        fromName,
        attachmentName,
        attachmentMime,
        attachmentBase64,
      } = req.body as {
        toEmail: string;
        subject: string;
        bodyText: string;
        fromName?: string;
        attachmentName?: string;
        attachmentMime?: string;
        attachmentBase64?: string;
      };

      if (!toEmail || !subject || !bodyText) {
        res.status(400).json({ error: 'toEmail, subject, and bodyText are required' });
        return;
      }

      const result = await sendApplicationViaServerSmtp({
        toEmail,
        subject,
        bodyText,
        fromName,
        attachmentName,
        attachmentMime,
        attachmentBase64,
      });

      res.json(result);
    } catch (err) {
      console.error('Gmail SMTP send error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to send via Gmail SMTP',
      });
    }
  });

  async function runGmailInboxSyncCycle(overrideApps?: JobApplication[]) {
    const cfg = getGmailSmtpConfig();
    if (!cfg) {
      return {
        candidates: [] as Array<{
          applicationId: string;
          company: string;
          role: string;
          from: string;
          subject: string;
          snippet: string;
          gmailMessageId: string;
          gmailThreadId: string;
        }>,
        bouncedCount: 0,
        autoClassifiedCount: 0,
        mode: 'sandbox' as const,
      };
    }

    const state = await readStore();
    const applications: JobApplication[] = overrideApps || state.applications;

    if (applications.length === 0) {
      return {
        candidates: [] as Array<{
          applicationId: string;
          company: string;
          role: string;
          from: string;
          subject: string;
          snippet: string;
          gmailMessageId: string;
          gmailThreadId: string;
        }>,
        bouncedCount: 0,
        autoClassifiedCount: 0,
        mode: 'gmail_oauth' as const,
      };
    }

    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: cfg.user,
        pass: cfg.pass,
      },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const candidates: Array<{
      applicationId: string;
      company: string;
      role: string;
      from: string;
      subject: string;
      snippet: string;
      gmailMessageId: string;
      gmailThreadId: string;
    }> = [];

    const bouncedEmails = new Set<string>();
    let nextApps = [...state.applications];
    const newReplyAlerts: AlertItem[] = [];
    const classifiedAppIds = new Set<string>();
    let autoClassifiedCount = 0;
    const nowIso = new Date().toISOString();

    try {
      const sinceDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since: sinceDate });
      const recentUids = Array.isArray(uids) ? uids.slice(-40) : [];

      if (recentUids.length > 0) {
        for await (const msg of client.fetch(recentUids, {
          envelope: true,
          source: true,
          uid: true,
        })) {
          const fromAddr =
            msg.envelope?.from
              ?.map((f) => `${f.name || ''} <${f.address || ''}>`)
              .join(', ') || '';
          const subject = msg.envelope?.subject || '';

          if (fromAddr.toLowerCase().includes(cfg.user.toLowerCase())) {
            continue;
          }

          const rawText = msg.source ? msg.source.toString('utf-8') : '';
          const isBounceMessage =
            fromAddr.toLowerCase().includes('mailer-daemon') ||
            fromAddr.toLowerCase().includes('postmaster') ||
            /delivery status notification|undeliverable|address not found|message not delivered/i.test(
              `${subject} ${rawText.slice(0, 1200)}`
            );

          if (isBounceMessage) {
            const lowerBody = rawText.toLowerCase();
            for (const appItem of state.applications) {
              if (
                appItem.recipientEmail &&
                appItem.status !== 'bounced' &&
                lowerBody.includes(appItem.recipientEmail.toLowerCase())
              ) {
                bouncedEmails.add(appItem.recipientEmail.toLowerCase());
              }
            }
            for (const lead of state.coldLeads || []) {
              if (
                lead.contactEmail &&
                lead.status !== 'dismissed' &&
                lowerBody.includes(lead.contactEmail.toLowerCase())
              ) {
                bouncedEmails.add(lead.contactEmail.toLowerCase());
              }
            }
            continue;
          }

          const matchedApp = applications.find((appItem) => {
            const domain = extractDomain(appItem.recipientEmail);
            return (
              (appItem.recipientEmail &&
                fromAddr.toLowerCase().includes(appItem.recipientEmail.toLowerCase())) ||
              (domain &&
                !domain.endsWith('.example') &&
                fromAddr.toLowerCase().includes(domain)) ||
              subject.toLowerCase().includes(appItem.company.toLowerCase())
            );
          });

          if (matchedApp) {
            const snippet = extractBodySnippet(msg.source);
            const replyText = (snippet || subject).trim().slice(0, 280);
            candidates.push({
              applicationId: matchedApp.id,
              company: matchedApp.company,
              role: matchedApp.role,
              from: fromAddr,
              subject,
              snippet: snippet || subject,
              gmailMessageId: msg.envelope?.messageId || `imap-${msg.uid}`,
              gmailThreadId: msg.envelope?.inReplyTo || `imap-${msg.uid}`,
            });

            if (
              replyText &&
              !classifiedAppIds.has(matchedApp.id) &&
              matchedApp.latestRecruiterSnippet !== replyText &&
              matchedApp.status !== 'bounced'
            ) {
              classifiedAppIds.add(matchedApp.id);
              const fb = classifyReplyFallback(replyText, matchedApp.company);
              const assist = buildReplyAssistantAndPrep(
                matchedApp.company,
                matchedApp.role,
                fb.stage,
                replyText,
                state.profile.name
              );
              nextApps = nextApps.map((a) =>
                a.id === matchedApp.id
                  ? {
                      ...a,
                      status: fb.status,
                      latestRecruiterSnippet: replyText,
                      aiReplyStage: fb.stage,
                      aiReplyFeedback: fb.feedback,
                      aiNextStep: fb.nextStep,
                      aiSuggestedReply: assist.suggestedReply,
                      aiInterviewPrep: assist.interviewPrep,
                      updatedAt: nowIso,
                    }
                  : a
              );
              newReplyAlerts.push({
                id: `alert-reply-${Date.now()}-${matchedApp.id}`,
                type: 'recruiter_reply',
                title: `${fb.stage} Update — ${matchedApp.company}`,
                message: `${fb.feedback} Next: ${fb.nextStep}`,
                applicationId: matchedApp.id,
                read: false,
                createdAt: nowIso,
              });
              autoClassifiedCount += 1;
              void sendInstantPhoneAlert(
                state.profile,
                `Recruiter Reply (${fb.stage}): ${matchedApp.company}`,
                `${matchedApp.role}: ${fb.feedback}\nNext: ${fb.nextStep}`
              );
            }
          }
        }
      }
    } finally {
      lock.release();
      await client.logout().catch(() => {});
    }

    let nextJobs = state.jobs;
    let nextColdLeads = state.coldLeads || [];
    const newBounceAlerts: AlertItem[] = [];

    if (bouncedEmails.size > 0) {
      const bouncedJobIds = new Set<string>();
      nextApps = nextApps.map((appItem) => {
        if (
          appItem.recipientEmail &&
          bouncedEmails.has(appItem.recipientEmail.toLowerCase()) &&
          appItem.status !== 'bounced'
        ) {
          bouncedJobIds.add(appItem.jobId);
          newBounceAlerts.push({
            id: `alert-bounce-${Date.now()}-${appItem.id}`,
            type: 'recruiter_reply',
            title: `Bounced Email — ${appItem.company}`,
            message: `${appItem.recipientEmail} could not be delivered. Apply via web portal instead.`,
            applicationId: appItem.id,
            jobId: appItem.jobId,
            read: false,
            createdAt: nowIso,
          });
          return {
            ...appItem,
            status: 'bounced' as const,
            aiReplyStage: 'Bounced' as const,
            aiReplyFeedback:
              'Email bounced (address not found). Apply via the web portal link instead.',
            aiNextStep: 'Open the job listing URL and submit via web form.',
            updatedAt: nowIso,
          };
        }
        return appItem;
      });

      nextJobs = state.jobs.map((job) =>
        bouncedJobIds.has(job.id)
          ? {
              ...job,
              status: 'portal_only' as const,
              recruiterEmail: '',
              emailSource: 'none' as const,
              mxVerified: false,
              updatedAt: nowIso,
            }
          : job
      );

      nextColdLeads = (state.coldLeads || []).map((lead) =>
        bouncedEmails.has(lead.contactEmail.toLowerCase())
          ? { ...lead, status: 'dismissed' as const, updatedAt: nowIso }
          : lead
      );
    }

    let updatedState: AppStatePayload | undefined;
    if (bouncedEmails.size > 0 || autoClassifiedCount > 0) {
      updatedState = {
        ...state,
        jobs: nextJobs,
        applications: nextApps,
        coldLeads: nextColdLeads,
        alerts: [...newReplyAlerts, ...newBounceAlerts, ...state.alerts],
      };
      updatedState.digest = {
        ...updatedState.digest,
        stats: computeStats(updatedState),
      };
      await writeStore(updatedState);
    }

    return {
      candidates,
      bouncedCount: bouncedEmails.size,
      autoClassifiedCount,
      mode: 'gmail_oauth' as const,
      state: updatedState,
    };
  }

  app.post('/api/gmail/sync', async (req, res) => {
    if (!getGmailSmtpConfig()) {
      res.status(400).json({ error: 'Server Gmail IMAP is not configured in .env' });
      return;
    }

    try {
      const result = await runGmailInboxSyncCycle(
        req.body?.applications as JobApplication[] | undefined
      );
      res.json(result);
    } catch (err) {
      console.error('Gmail IMAP sync error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to sync Gmail inbox',
      });
    }
  });

  app.post('/api/state/reset', async (_req, res) => {
    const fresh = createSeedState();
    await writeStore(fresh);
    res.json({ ok: true, state: fresh });
  });

  async function renderCvPdfBuffer(cvText: string): Promise<Buffer> {
    const executablePath = getSystemBrowserExecutable();
    if (!executablePath) {
      throw new Error('Local Chrome or Edge browser binary not found to render PDF.');
    }
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      const html = buildWordDocFromCvText(cvText);
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      const pdfBytes = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0.5in', bottom: '0.5in', left: '0.55in', right: '0.55in' },
      });
      return Buffer.from(pdfBytes);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  app.get('/api/cv/download', async (_req, res) => {
    const state = await readStore();
    const seedProfile = createSeedState().profile;
    const fileName = state.profile.cvAttachmentName || seedProfile.cvAttachmentName || 'Oguike_Godswill_CV.doc';
    const mime = state.profile.cvAttachmentMime || seedProfile.cvAttachmentMime || 'application/msword';
    const base64 = state.profile.cvAttachmentBase64 || seedProfile.cvAttachmentBase64 || '';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(Buffer.from(base64, 'base64'));
  });

  app.get('/api/cv/download-pdf', async (req, res) => {
    try {
      const state = await readStore();
      const seedProfile = createSeedState().profile;
      const baseCvText = state.profile.cvText || seedProfile.cvText;
      const trackParam = String(req.query.track || '').toLowerCase();
      const cvText =
        trackParam === 'flutter'
          ? buildTailoredCvText(baseCvText, 'Flutter Mobile Engineer').cvText
          : trackParam === 'react'
            ? buildTailoredCvText(baseCvText, 'Frontend React Next.js Engineer').cvText
            : baseCvText;

      const pdfBuffer = await renderCvPdfBuffer(cvText);
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(path.join(DATA_DIR, 'Oguike_Godswill_CV.pdf'), pdfBuffer);
      if (!IS_VERCEL) {
        await fs.writeFile(path.resolve(process.cwd(), 'Oguike_Godswill_CV.pdf'), pdfBuffer);
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="Oguike_Godswill_CV.pdf"'
      );
      res.send(pdfBuffer);
    } catch (error) {
      console.error('PDF CV generation error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to generate PDF CV',
      });
    }
  });

  app.post('/api/jobs/mark-applied', async (req, res) => {
    try {
      const { jobId } = req.body as { jobId: string };
      if (!jobId) {
        res.status(400).json({ error: 'jobId is required' });
        return;
      }

      const state = await readStore();
      const target = state.jobs.find((j) => j.id === jobId);
      if (!target) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      const nowIso = new Date().toISOString();
      const nextJobs = state.jobs.map((j) =>
        j.id === jobId ? { ...j, status: 'applied' as const, updatedAt: nowIso } : j
      );

      const alreadyLogged = state.applications.some((a) => a.jobId === jobId);
      const newApp: JobApplication[] = alreadyLogged
        ? []
        : [
            {
              id: `app-portal-${Date.now()}`,
              jobId: target.id,
              company: target.company,
              role: target.role,
              recipientEmail: 'Web Portal Submission',
              sentCoverLetter: target.coverLetter,
              gmailMessageId: `portal-${Date.now()}`,
              gmailThreadId: `portal-${Date.now()}`,
              status: 'submitted',
              latestRecruiterSnippet: '',
              aiReplyStage: 'Acknowledged',
              aiReplyFeedback: `Marked as submitted manually via portal (${target.postingUrl}).`,
              aiNextStep: 'Run Sync Gmail to capture confirmation emails.',
              dispatchMode: 'sandbox',
              submittedAt: nowIso,
              updatedAt: nowIso,
            },
          ];

      const updatedState: AppStatePayload = {
        ...state,
        jobs: nextJobs,
        applications: [...newApp, ...state.applications],
      };
      updatedState.digest = {
        ...updatedState.digest,
        stats: computeStats(updatedState),
      };
      await writeStore(updatedState);

      res.json({ ok: true, state: updatedState });
    } catch (error) {
      console.error('Mark applied error:', error);
      res.status(500).json({ error: 'Failed to mark job as applied' });
    }
  });

  app.get('/api/mongodb/status', async (_req, res) => {
    const status = await getMongoStatus();
    res.json(status);
  });

  app.post('/api/mongodb/connect', async (req, res) => {
    try {
      const { uri, dbName } = req.body as { uri?: string; dbName?: string };
      const maskedEnv = maskMongoUri(DEFAULT_MONGO_URI);
      const rawUri = uri?.trim();
      const resolvedUri =
        !rawUri || rawUri === 'env' || (maskedEnv && rawUri === maskedEnv)
          ? process.env.MONGODB_URI?.trim() || DEFAULT_MONGO_URI
          : rawUri;

      if (!resolvedUri) {
        res.status(400).json({ error: 'MongoDB URI is required.' });
        return;
      }
      manualMongoDisconnected = false;
      const state = await connectToMongo(resolvedUri, dbName);
      const status = await getMongoStatus();
      res.json({ status, state });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Unable to connect to MongoDB URI.',
      });
    }
  });

  app.post('/api/mongodb/disconnect', async (_req, res) => {
    manualMongoDisconnected = true;
    await disconnectMongo();
    const status = await getMongoStatus();
    res.json({ status });
  });

  app.get('/api/state', async (_req, res) => {
    const state = await readStore();
    res.json(state);
  });

  app.post('/api/state', async (req, res) => {
    const incoming = req.body as AppStatePayload;
    if (!incoming || !incoming.profile || !Array.isArray(incoming.jobs)) {
      res.status(400).json({ error: 'Invalid state payload' });
      return;
    }
    await writeStore(incoming);
    res.json({ ok: true });
  });

  async function runAutopilotCycle(reqProfile?: UserProfile) {
    const state = await readStore();
    const seedProfile = createSeedState().profile;
    const baseProfile = reqProfile || state.profile;
    const profile: UserProfile = {
      ...baseProfile,
      cvAttachmentName: baseProfile.cvAttachmentName || seedProfile.cvAttachmentName,
      cvAttachmentMime: baseProfile.cvAttachmentMime || seedProfile.cvAttachmentMime,
      cvAttachmentBase64:
        baseProfile.cvAttachmentBase64 || seedProfile.cvAttachmentBase64,
      autoSendEnabled: baseProfile.autoSendEnabled ?? true,
    };

    const existingTitles = new Set(
      state.jobs.map((j) => `${j.company.toLowerCase()}::${j.role.toLowerCase()}`)
    );

    const ai = getGeminiClient();
    let newJobs: ScoutedJob[] = [];
    let usedLiveGemini = false;
    let groundingSources: Array<{ title?: string; uri?: string }> = [];

    if (ai) {
      try {
        const prompt = `You are CareerRelay Autopilot Job Scout.
Use Google Search to find 3 real, currently open job postings matching:
- Target Role: ${profile.targetRole}
- Target Location: ${profile.targetLocation}
- Candidate Name: ${profile.name}
- Candidate CV:
${profile.cvText.slice(0, 3000)}

Exclude already scouted company+role pairs: ${
          Array.from(existingTitles).slice(0, 12).join(', ') || 'none'
        }.

Return ONLY valid JSON (no markdown commentary) with this exact structure:
{
  "jobs": [
    {
      "role": "Exact Role Title",
      "company": "Company Name",
      "location": "Location / Remote",
      "postingUrl": "https://...",
      "recruiterEmail": "careers@company.com or jobs@company.com",
      "matchScore": 88,
      "fitFeedback": "1-2 sentences explaining CV alignment.",
      "cvGaps": ["Concrete gap 1", "Concrete gap 2"],
      "cvHighlights": ["CV bullet 1", "CV bullet 2"],
      "coverLetter": "Tailored 2-3 paragraph cover letter signed by ${profile.name}."
    }
  ]
}`;

        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            tools: [{ googleSearch: {} }],
            temperature: 0.3,
          },
        });

        const text = response.text || '';
        const parsed = extractJsonObject<{
          jobs?: Array<{
            role: string;
            company: string;
            location: string;
            postingUrl: string;
            recruiterEmail?: string;
            matchScore: number;
            fitFeedback: string;
            cvGaps?: string[];
            cvHighlights?: string[];
            coverLetter: string;
          }>;
        }>(text);

        const metadata = response.candidates?.[0]?.groundingMetadata;
        if (metadata?.groundingChunks) {
          groundingSources = metadata.groundingChunks
            .map((chunk) => ({
              title: chunk.web?.title,
              uri: chunk.web?.uri,
            }))
            .filter((c) => Boolean(c.uri));
        }

        if (parsed?.jobs && Array.isArray(parsed.jobs) && parsed.jobs.length > 0) {
          usedLiveGemini = true;
          const now = new Date().toISOString();
          newJobs = await Promise.all(
            parsed.jobs.map(async (item, idx) => {
              const score = Math.max(
                0,
                Math.min(100, Math.round(Number(item.matchScore) || 80))
              );
              const candidateEmail = item.recruiterEmail?.trim() || '';
              const mxOk = candidateEmail ? await verifyEmailMx(candidateEmail) : false;
              const status: JobStatus =
                score < profile.matchThreshold
                  ? 'below_threshold'
                  : mxOk
                    ? 'ready_to_send'
                    : 'portal_only';
              return {
                id: `job-gemini-${Date.now()}-${idx}`,
                role: item.role || profile.targetRole,
                company: item.company || 'Unknown Company',
                location: item.location || profile.targetLocation,
                postingUrl:
                  item.postingUrl ||
                  groundingSources[idx]?.uri ||
                  'https://careers.google.com',
                recruiterEmail: mxOk ? candidateEmail : '',
                emailSource: (mxOk ? 'job_post' : 'none') as 'job_post' | 'none',
                mxVerified: mxOk,
                matchScore: score,
                fitFeedback:
                  item.fitFeedback || 'Strong skill alignment with candidate CV.',
                cvGaps: Array.isArray(item.cvGaps) ? item.cvGaps : [],
                cvHighlights: Array.isArray(item.cvHighlights)
                  ? item.cvHighlights
                  : [],
                coverLetter: item.coverLetter || '',
                status,
                source: `Gemini (${GEMINI_MODEL}) + Google Search Grounding`,
                createdAt: now,
                updatedAt: now,
              };
            })
          );
        }
      } catch (geminiErr) {
        console.warn('Gemini autopilot fallback triggered:', geminiErr);
      }
    }

    if (newJobs.length === 0) {
      newJobs = await scoutLivePublicJobBoards(profile, existingTitles as Set<string>);
    }

    const newAlerts: AlertItem[] = newJobs
      .filter((j) => j.matchScore >= 90 && j.status === 'ready_to_send')
      .map((j) => ({
        id: `alert-match-${j.id}`,
        type: 'high_match' as const,
        title: `${j.matchScore}% High Match Pre-Drafted — ${j.company}`,
        message: `${j.role} scored ${j.matchScore}% against your CV.`,
        portalUrl: j.postingUrl,
        jobId: j.id,
        read: false,
        createdAt: new Date().toISOString(),
      }));

    // Step B: Re-evaluate threshold on newly scouted and existing pending jobs
    let combinedJobs: ScoutedJob[] = [...newJobs, ...state.jobs].map((job) => {
      if (
        job.status === 'ready_to_send' ||
        job.status === 'below_threshold' ||
        job.status === 'portal_only'
      ) {
        if (job.matchScore < profile.matchThreshold) {
          return { ...job, status: 'below_threshold' as const };
        }
        return {
          ...job,
          status:
            job.mxVerified && job.recruiterEmail
              ? ('ready_to_send' as const)
              : ('portal_only' as const),
        };
      }
      return job;
    });

    // Step C: Autonomous auto-send for qualifying MX-verified jobs with daily & per-cycle caps
    const autoSentApplications: JobApplication[] = [];
    const smtpConfigured = Boolean(getGmailSmtpConfig());
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const jobDailyLimit = profile.jobDailyLimit ?? 8;
    const maxEmailsPerCycle = profile.maxEmailsPerCycle ?? 2;
    let sentTodayCount = state.applications.filter(
      (a) =>
        a.submittedAt?.startsWith(todayPrefix) &&
        a.recipientEmail !== 'Web Portal Submission'
    ).length;
    let sentThisCycleCount = 0;

    const alreadyAppliedKeys = new Set(
      state.applications.map((a) => `${a.company.toLowerCase()}::${a.role.toLowerCase()}`)
    );
    const { sentCompanies, sentDomains } = buildSentCompanyAndDomainSets(state);

    // Upgrade up to 3 existing portal_only jobs via deep company email lookup
    let portalResolvedCount = 0;
    for (let i = 0; i < combinedJobs.length && portalResolvedCount < 3; i++) {
      const job = combinedJobs[i];
      if (
        job.status === 'portal_only' &&
        !job.mxVerified &&
        !sentCompanies.has(job.company.toLowerCase())
      ) {
        portalResolvedCount += 1;
        const resolved = await findVerifiedHiringEmail('', job.postingUrl, job.company);
        if (resolved.mxVerified && resolved.email) {
          combinedJobs[i] = {
            ...job,
            recruiterEmail: resolved.email,
            emailSource: resolved.emailSource,
            mxVerified: true,
            status:
              job.matchScore >= profile.matchThreshold
                ? 'ready_to_send'
                : 'below_threshold',
            updatedAt: new Date().toISOString(),
          };
        }
      }
    }

    let nextExistingApps = [...state.applications];

    if (profile.autoSendEnabled !== false && smtpConfigured) {
      const sentIds = new Set<string>();
      const sentAt = new Date().toISOString();

      for (const job of combinedJobs) {
        if (sentTodayCount >= jobDailyLimit || sentThisCycleCount >= maxEmailsPerCycle) {
          break;
        }
        const appKey = `${job.company.toLowerCase()}::${job.role.toLowerCase()}`;
        const companyKey = job.company.toLowerCase();
        const domainKey = extractDomain(job.recruiterEmail);

        if (
          job.status !== 'ready_to_send' ||
          !job.mxVerified ||
          !job.recruiterEmail ||
          job.matchScore < profile.matchThreshold ||
          alreadyAppliedKeys.has(appKey) ||
          sentCompanies.has(companyKey) ||
          (domainKey && sentDomains.has(domainKey))
        ) {
          continue;
        }

        const mxStillValid = await verifyEmailMx(job.recruiterEmail);
        if (!mxStillValid) {
          continue;
        }

        try {
          const tailoredCv = buildTailoredCvDocBase64(
            profile.cvText,
            job.role,
            job.fitFeedback
          );
          const result = await sendApplicationViaServerSmtp({
            toEmail: job.recruiterEmail,
            subject: `Application: ${job.role} — ${profile.name}`,
            bodyText: job.coverLetter,
            fromName: profile.name,
            attachmentName: profile.cvAttachmentName,
            attachmentMime: profile.cvAttachmentMime,
            attachmentBase64: tailoredCv.base64,
          });

          sentIds.add(job.id);
          alreadyAppliedKeys.add(appKey);
          sentCompanies.add(companyKey);
          if (domainKey) sentDomains.add(domainKey);
          sentTodayCount += 1;
          sentThisCycleCount += 1;
          autoSentApplications.push({
            id: `app-auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            jobId: job.id,
            company: job.company,
            role: job.role,
            recipientEmail: job.recruiterEmail,
            sentCoverLetter: job.coverLetter,
            gmailMessageId: result.messageId,
            gmailThreadId: result.threadId,
            status: 'submitted',
            latestRecruiterSnippet: '',
            aiReplyStage: 'Acknowledged',
            aiReplyFeedback: `Auto-dispatched by CareerRelay Autopilot with ${
              profile.cvAttachmentName || 'CV'
            } (${tailoredCv.track === 'flutter_first' ? 'Flutter-First CV' : 'React/Next.js-First CV'}).`,
            aiNextStep: 'Run Sync Gmail periodically to capture thread responses.',
            dispatchMode: 'gmail_oauth',
            submittedAt: sentAt,
            updatedAt: sentAt,
            tailoredCvTrack: tailoredCv.track,
          });
          void sendInstantPhoneAlert(
            profile,
            `Auto-Applied: ${job.company}`,
            `${job.role} (${job.matchScore}% match) emailed to ${job.recruiterEmail}.`
          );
        } catch (sendErr) {
          console.warn(
            `Autopilot auto-send failed for ${job.company} (${job.recruiterEmail}):`,
            sendErr instanceof Error ? sendErr.message : sendErr
          );
        }
      }

      if (sentIds.size > 0) {
        combinedJobs = combinedJobs.map((job) =>
          sentIds.has(job.id)
            ? { ...job, status: 'applied' as const, updatedAt: sentAt }
            : job
        );
      }

      // Automatic follow-up on un-replied direct-email job applications after coldFollowUpDays (default 4 days)
      const jobFollowUpMs = (profile.coldFollowUpDays ?? 4) * 24 * 60 * 60 * 1000;
      for (let i = 0; i < nextExistingApps.length; i++) {
        if (sentTodayCount >= jobDailyLimit || sentThisCycleCount >= maxEmailsPerCycle) {
          break;
        }
        const existingApp = nextExistingApps[i];
        if (
          existingApp.status === 'submitted' &&
          existingApp.recipientEmail.includes('@') &&
          !existingApp.jobId.startsWith('cold-') &&
          !existingApp.aiReplyFeedback.includes('Follow-up sent') &&
          existingApp.submittedAt &&
          Date.now() - Date.parse(existingApp.submittedAt) >= jobFollowUpMs &&
          (await verifyEmailMx(existingApp.recipientEmail))
        ) {
          try {
            const tailoredCv = buildTailoredCvDocBase64(
              profile.cvText,
              existingApp.role,
              existingApp.aiReplyFeedback
            );
            await sendApplicationViaServerSmtp({
              toEmail: existingApp.recipientEmail,
              subject: `Re: Application: ${existingApp.role} — ${profile.name}`,
              bodyText: `Hi ${existingApp.company} Hiring Team,\n\nI am following up on my application for the ${existingApp.role} position. My updated CV (${profile.cvAttachmentName || 'Oguike_Godswill_CV.doc'}) is attached again, and my portfolio is live at https://oguikegodswill.vercel.app. I would welcome the opportunity to contribute to your team.\n\nBest regards,\n${profile.name}\n+234 706 086 8353 · ${profile.email}`,
              fromName: profile.name,
              attachmentName: profile.cvAttachmentName,
              attachmentMime: profile.cvAttachmentMime,
              attachmentBase64: tailoredCv.base64,
            });
            sentTodayCount += 1;
            sentThisCycleCount += 1;
            nextExistingApps[i] = {
              ...existingApp,
              aiReplyFeedback: `${existingApp.aiReplyFeedback} · Follow-up sent automatically.`,
              updatedAt: sentAt,
            };
          } catch (err) {
            console.warn(
              `Job follow-up failed for ${existingApp.company}:`,
              err instanceof Error ? err.message : err
            );
          }
        }
      }
    }

    const updatedState: AppStatePayload = {
      ...state,
      profile: {
        ...profile,
        lastScoutedAt: new Date().toISOString(),
      },
      jobs: combinedJobs,
      applications: [...autoSentApplications, ...nextExistingApps],
      alerts: [...newAlerts, ...state.alerts],
    };
    updatedState.digest = {
      ...updatedState.digest,
      stats: computeStats(updatedState),
    };

    await writeStore(updatedState);

    return {
      newJobs,
      newAlerts,
      autoSentApplications,
      autoSentCount: autoSentApplications.length,
      usedLiveGemini,
      groundingSources,
      lastScoutedAt: updatedState.profile.lastScoutedAt,
      state: updatedState,
    };
  }

  async function runColdOutreachCycle(reqProfile?: UserProfile) {
    const state = await readStore();
    const seedProfile = createSeedState().profile;
    const baseProfile = reqProfile || state.profile;
    const profile: UserProfile = {
      ...baseProfile,
      cvAttachmentName: baseProfile.cvAttachmentName || seedProfile.cvAttachmentName,
      cvAttachmentMime: baseProfile.cvAttachmentMime || seedProfile.cvAttachmentMime,
      cvAttachmentBase64:
        baseProfile.cvAttachmentBase64 || seedProfile.cvAttachmentBase64,
      autoSendEnabled: baseProfile.autoSendEnabled ?? true,
      coldDailyLimit: baseProfile.coldDailyLimit ?? 10,
      coldFollowUpDays: baseProfile.coldFollowUpDays ?? 4,
    };

    const existingLeads: ColdEmailLead[] = [...(state.coldLeads || [])];
    const existingEmails = new Set(
      existingLeads.map((l) => l.contactEmail.toLowerCase())
    );
    const existingCompanies = new Set(
      existingLeads.map((l) => l.company.toLowerCase())
    );

    const newLeads = await discoverColdLeads(
      profile,
      existingEmails,
      existingCompanies
    );

    let combinedLeads: ColdEmailLead[] = [...newLeads, ...existingLeads].map((lead) => {
      if (lead.status !== 'ready_to_pitch') return lead;
      const refreshed = buildColdPitchForCompany({
        company: lead.company,
        contactEmail: lead.contactEmail,
        websiteUrl: lead.websiteUrl,
        githubUrl: lead.githubUrl,
        location: lead.location,
        companyBio: lead.companyBio || '',
        source: lead.source,
        profile,
      });
      return {
        ...lead,
        subject: refreshed.subject,
        pitchBody: refreshed.pitchBody,
        followUpBody: refreshed.followUpBody,
        updatedAt: new Date().toISOString(),
      };
    });
    const newApplications: JobApplication[] = [];
    const smtpConfigured = Boolean(getGmailSmtpConfig());
    const todayPrefix = new Date().toISOString().slice(0, 10);
    let sentTodayCount = combinedLeads.filter((l) =>
      l.sentAt?.startsWith(todayPrefix)
    ).length;
    const dailyLimit = profile.coldDailyLimit ?? 5;
    const maxEmailsPerCycle = profile.maxEmailsPerCycle ?? 2;
    let sentThisCycleCount = 0;
    let autoSentCount = 0;
    let followUpSentCount = 0;
    const { sentCompanies, sentDomains } = buildSentCompanyAndDomainSets(state);

    if (profile.autoSendEnabled !== false && smtpConfigured) {
      const nowIso = new Date().toISOString();
      const followUpMs = (profile.coldFollowUpDays ?? 4) * 24 * 60 * 60 * 1000;

      // 1. Dispatch new ready_to_pitch leads up to dailyLimit & maxEmailsPerCycle
      for (let i = 0; i < combinedLeads.length; i++) {
        const lead = combinedLeads[i];
        const companyKey = lead.company.toLowerCase();
        const domainKey = extractDomain(lead.contactEmail);

        if (
          lead.status === 'ready_to_pitch' &&
          sentTodayCount < dailyLimit &&
          sentThisCycleCount < maxEmailsPerCycle &&
          !sentCompanies.has(companyKey) &&
          (!domainKey || !sentDomains.has(domainKey)) &&
          (await verifyEmailMx(lead.contactEmail))
        ) {
          try {
            const res = await sendApplicationViaServerSmtp({
              toEmail: lead.contactEmail,
              subject: lead.subject,
              bodyText: lead.pitchBody,
              fromName: profile.name,
              attachmentName: profile.cvAttachmentName,
              attachmentMime: profile.cvAttachmentMime,
              attachmentBase64: profile.cvAttachmentBase64,
            });
            sentTodayCount += 1;
            sentThisCycleCount += 1;
            autoSentCount += 1;
            sentCompanies.add(companyKey);
            if (domainKey) sentDomains.add(domainKey);

            newApplications.push({
              id: `app-cold-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              jobId: lead.id,
              company: lead.company,
              role: 'Cold Outreach — Frontend / Flutter',
              recipientEmail: lead.contactEmail,
              sentCoverLetter: lead.pitchBody,
              gmailMessageId: res.messageId,
              gmailThreadId: res.threadId,
              status: 'submitted',
              latestRecruiterSnippet: '',
              aiReplyStage: 'Acknowledged',
              aiReplyFeedback: `Cold pitch auto-sent with ${
                profile.cvAttachmentName || 'CV'
              } attached.`,
              aiNextStep: `Auto-follow-up scheduled in ${profile.coldFollowUpDays ?? 4} days if no reply.`,
              dispatchMode: 'gmail_oauth',
              submittedAt: nowIso,
              updatedAt: nowIso,
            });

            combinedLeads[i] = {
              ...lead,
              status: 'sent',
              gmailMessageId: res.messageId,
              sentAt: nowIso,
              updatedAt: nowIso,
            };
            continue;
          } catch (err) {
            console.warn(
              `Cold email send failed for ${lead.company} (${lead.contactEmail}):`,
              err instanceof Error ? err.message : err
            );
          }
        }

        // 2. Auto-follow-up if sent older than coldFollowUpDays
        if (
          lead.status === 'sent' &&
          lead.sentAt &&
          Date.now() - Date.parse(lead.sentAt) >= followUpMs &&
          sentThisCycleCount < maxEmailsPerCycle &&
          (await verifyEmailMx(lead.contactEmail))
        ) {
          try {
            await sendApplicationViaServerSmtp({
              toEmail: lead.contactEmail,
              subject: `Re: ${lead.subject}`,
              bodyText: lead.followUpBody,
              fromName: profile.name,
              attachmentName: profile.cvAttachmentName,
              attachmentMime: profile.cvAttachmentMime,
              attachmentBase64: profile.cvAttachmentBase64,
            });
            sentThisCycleCount += 1;
            followUpSentCount += 1;
            combinedLeads[i] = {
              ...lead,
              status: 'followed_up',
              followedUpAt: nowIso,
              updatedAt: nowIso,
            };
          } catch (err) {
            console.warn(
              `Cold follow-up failed for ${lead.company}:`,
              err instanceof Error ? err.message : err
            );
          }
        }
      }
    }

    const updatedState: AppStatePayload = {
      ...state,
      profile,
      coldLeads: combinedLeads,
      applications: [...newApplications, ...state.applications],
    };
    updatedState.digest = {
      ...updatedState.digest,
      stats: computeStats(updatedState),
    };

    await writeStore(updatedState);

    return {
      newLeads,
      autoSentCount,
      followUpSentCount,
      state: updatedState,
    };
  }

  app.post('/api/jobs/autopilot', async (req, res) => {
    try {
      const outcome = await runAutopilotCycle(req.body?.profile as UserProfile | undefined);
      res.json(outcome);
    } catch (error) {
      console.error('Autopilot error:', error);
      res.status(500).json({ error: 'Autopilot scouting failed' });
    }
  });

  async function runPortalAutoApplyCycle(jobId?: string, maxBatch = 3) {
    const state = await readStore();
    const seedProfile = createSeedState().profile;
    const profile: UserProfile = {
      ...state.profile,
      cvAttachmentName: state.profile.cvAttachmentName || seedProfile.cvAttachmentName,
      cvAttachmentMime: state.profile.cvAttachmentMime || seedProfile.cvAttachmentMime,
      cvAttachmentBase64:
        state.profile.cvAttachmentBase64 || seedProfile.cvAttachmentBase64,
    };

    const targets = jobId
      ? state.jobs.filter((j) => j.id === jobId)
      : state.jobs.filter((j) => j.status === 'portal_only').slice(0, maxBatch);

    if (targets.length === 0) {
      return {
        resolvedEmailCount: 0,
        formAppliedCount: 0,
        captchaPausedCount: 0,
        state,
      };
    }

    const todayPrefix = new Date().toISOString().slice(0, 10);
    const jobDailyLimit = profile.jobDailyLimit ?? 8;
    const maxEmailsPerCycle = profile.maxEmailsPerCycle ?? 2;
    let sentTodayCount = state.applications.filter(
      (a) =>
        a.submittedAt?.startsWith(todayPrefix) &&
        a.recipientEmail !== 'Web Portal Submission'
    ).length;
    let sentThisCycleCount = 0;

    const { sentCompanies, sentDomains } = buildSentCompanyAndDomainSets(state);
    const smtpConfigured = Boolean(getGmailSmtpConfig());
    const nowIso = new Date().toISOString();

    let nextJobs = [...state.jobs];
    const newApps: JobApplication[] = [];
    const newAlerts: AlertItem[] = [];
    let resolvedEmailCount = 0;
    let formAppliedCount = 0;
    let captchaPausedCount = 0;

    for (const target of targets) {
      const companyKey = target.company.toLowerCase();
      let email = target.recruiterEmail;
      let emailSource = target.emailSource || 'none';
      let mxVerified = Boolean(target.mxVerified);

      if (!mxVerified || !email) {
        const resolved = await findVerifiedHiringEmail(
          '',
          target.postingUrl,
          target.company
        );
        if (resolved.mxVerified && resolved.email) {
          email = resolved.email;
          emailSource = resolved.emailSource;
          mxVerified = true;
        }
      }

      const domainKey = extractDomain(email);

      if (
        mxVerified &&
        email &&
        smtpConfigured &&
        !sentCompanies.has(companyKey) &&
        (!domainKey || !sentDomains.has(domainKey)) &&
        sentTodayCount < jobDailyLimit &&
        sentThisCycleCount < maxEmailsPerCycle
      ) {
        try {
          const tailoredCv = buildTailoredCvDocBase64(
            profile.cvText,
            target.role,
            target.fitFeedback
          );
          const result = await sendApplicationViaServerSmtp({
            toEmail: email,
            subject: `Application: ${target.role} — ${profile.name}`,
            bodyText: target.coverLetter,
            fromName: profile.name,
            attachmentName: profile.cvAttachmentName,
            attachmentMime: profile.cvAttachmentMime,
            attachmentBase64: tailoredCv.base64,
          });
          resolvedEmailCount += 1;
          sentTodayCount += 1;
          sentThisCycleCount += 1;
          sentCompanies.add(companyKey);
          if (domainKey) sentDomains.add(domainKey);

          nextJobs = nextJobs.map((j) =>
            j.id === target.id
              ? {
                  ...j,
                  recruiterEmail: email,
                  emailSource,
                  mxVerified: true,
                  status: 'applied',
                  updatedAt: nowIso,
                }
              : j
          );
          newApps.push({
            id: `app-resolved-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            jobId: target.id,
            company: target.company,
            role: target.role,
            recipientEmail: email,
            sentCoverLetter: target.coverLetter,
            gmailMessageId: result.messageId,
            gmailThreadId: result.threadId,
            status: 'submitted',
            latestRecruiterSnippet: '',
            aiReplyStage: 'Acknowledged',
            aiReplyFeedback: `Resolved MX-verified company email (${email}) and auto-sent ${
              profile.cvAttachmentName || 'CV'
            } (${tailoredCv.track === 'flutter_first' ? 'Flutter-First CV' : 'React/Next.js-First CV'}).`,
            aiNextStep: 'Run Sync Gmail to capture thread responses.',
            dispatchMode: 'gmail_oauth',
            submittedAt: nowIso,
            updatedAt: nowIso,
            tailoredCvTrack: tailoredCv.track,
          });
          void sendInstantPhoneAlert(
            profile,
            `Portal Resolved & Emailed: ${target.company}`,
            `${target.role} sent to ${email}.`
          );
          continue;
        } catch (err) {
          console.warn(
            `Resolved email SMTP send failed for ${target.company} (${email}):`,
            err instanceof Error ? err.message : err
          );
        }
      }

      // Fall back to Playwright web-form auto-applier (pauses on CAPTCHA / login walls)
      const portalOutcome = await attemptWebPortalAutoApply(target, profile);
      if (portalOutcome.status === 'applied') {
        formAppliedCount += 1;
        sentCompanies.add(companyKey);
        nextJobs = nextJobs.map((j) =>
          j.id === target.id
            ? {
                ...j,
                postingUrl: portalOutcome.applyUrl,
                status: 'applied',
                updatedAt: nowIso,
              }
            : j
        );
        newApps.push({
          id: `app-form-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          jobId: target.id,
          company: target.company,
          role: target.role,
          recipientEmail: 'Web Portal Auto-Submitted',
          sentCoverLetter: target.coverLetter,
          gmailMessageId: `form-${Date.now()}`,
          gmailThreadId: `form-${Date.now()}`,
          status: 'submitted',
          latestRecruiterSnippet: '',
          aiReplyStage: 'Acknowledged',
          aiReplyFeedback: portalOutcome.details,
          aiNextStep: 'Run Sync Gmail to capture confirmation emails.',
          dispatchMode: 'sandbox',
          submittedAt: nowIso,
          updatedAt: nowIso,
        });
        void sendInstantPhoneAlert(
          profile,
          `Web Form Auto-Submitted: ${target.company}`,
          `${target.role} submitted via ${portalOutcome.applyUrl}`
        );
      } else {
        captchaPausedCount += 1;
        nextJobs = nextJobs.map((j) =>
          j.id === target.id
            ? {
                ...j,
                postingUrl: portalOutcome.applyUrl,
                recruiterEmail: email || j.recruiterEmail,
                emailSource,
                mxVerified,
                status: 'captcha_required',
                captchaGateDetails: portalOutcome.details,
                updatedAt: nowIso,
              }
            : j
        );
        newAlerts.push({
          id: `alert-portal-${Date.now()}-${target.id}`,
          type: 'captcha_required',
          title: `Manual Portal Action Needed — ${target.company}`,
          message: `${target.role}: ${portalOutcome.details}`,
          portalUrl: portalOutcome.applyUrl,
          jobId: target.id,
          captchaStatus: 'pending',
          read: false,
          createdAt: nowIso,
        });
        void sendInstantPhoneAlert(
          profile,
          `Action Needed: ${target.company}`,
          `${target.role} — ${portalOutcome.details}\n${portalOutcome.applyUrl}`
        );
      }
    }

    const updatedState: AppStatePayload = {
      ...state,
      jobs: nextJobs,
      applications: [...newApps, ...state.applications],
      alerts: [...newAlerts, ...state.alerts],
    };
    updatedState.digest = {
      ...updatedState.digest,
      stats: computeStats(updatedState),
    };
    await writeStore(updatedState);

    return {
      resolvedEmailCount,
      formAppliedCount,
      captchaPausedCount,
      state: updatedState,
    };
  }

  app.post('/api/jobs/auto-apply-portal', async (req, res) => {
    try {
      const { jobId } = (req.body || {}) as { jobId?: string };
      const outcome = await runPortalAutoApplyCycle(jobId, 3);
      res.json(outcome);
    } catch (error) {
      console.error('Portal auto-apply error:', error);
      res.status(500).json({ error: 'Portal auto-apply failed' });
    }
  });

  app.post('/api/cold/autopilot', async (req, res) => {
    try {
      const outcome = await runColdOutreachCycle(
        req.body?.profile as UserProfile | undefined
      );
      res.json(outcome);
    } catch (error) {
      console.error('Cold autopilot error:', error);
      res.status(500).json({ error: 'Cold outreach cycle failed' });
    }
  });

  app.post('/api/cold/add', async (req, res) => {
    try {
      const { company, contactEmail, websiteUrl, location, companyBio, sendNow } =
        req.body as {
          company: string;
          contactEmail: string;
          websiteUrl?: string;
          location?: string;
          companyBio?: string;
          sendNow?: boolean;
        };

      if (!company?.trim() || !contactEmail?.trim()) {
        res.status(400).json({ error: 'company and contactEmail are required' });
        return;
      }

      const state = await readStore();
      const seedProfile = createSeedState().profile;
      const profile: UserProfile = {
        ...state.profile,
        cvAttachmentName: state.profile.cvAttachmentName || seedProfile.cvAttachmentName,
        cvAttachmentMime: state.profile.cvAttachmentMime || seedProfile.cvAttachmentMime,
        cvAttachmentBase64:
          state.profile.cvAttachmentBase64 || seedProfile.cvAttachmentBase64,
      };

      let lead = buildColdPitchForCompany({
        company: company.trim(),
        contactEmail: contactEmail.trim(),
        websiteUrl: websiteUrl?.trim() || '',
        location: location?.trim() || profile.targetLocation || 'Lagos, Nigeria',
        companyBio: companyBio?.trim() || '',
        source: 'Manual Cold Target',
        profile,
      });

      let sent = false;
      const newApps: JobApplication[] = [];
      if (sendNow && getGmailSmtpConfig()) {
        const result = await sendApplicationViaServerSmtp({
          toEmail: lead.contactEmail,
          subject: lead.subject,
          bodyText: lead.pitchBody,
          fromName: profile.name,
          attachmentName: profile.cvAttachmentName,
          attachmentMime: profile.cvAttachmentMime,
          attachmentBase64: profile.cvAttachmentBase64,
        });
        sent = true;
        const nowIso = new Date().toISOString();
        lead = {
          ...lead,
          status: 'sent',
          gmailMessageId: result.messageId,
          sentAt: nowIso,
          updatedAt: nowIso,
        };
        newApps.push({
          id: `app-cold-${Date.now()}`,
          jobId: lead.id,
          company: lead.company,
          role: 'Cold Outreach — Frontend / Flutter',
          recipientEmail: lead.contactEmail,
          sentCoverLetter: lead.pitchBody,
          gmailMessageId: result.messageId,
          gmailThreadId: result.threadId,
          status: 'submitted',
          latestRecruiterSnippet: '',
          aiReplyStage: 'Acknowledged',
          aiReplyFeedback: `Cold pitch sent with ${profile.cvAttachmentName || 'CV'} attached.`,
          aiNextStep: `Auto-follow-up scheduled in ${profile.coldFollowUpDays ?? 4} days if no reply.`,
          dispatchMode: 'gmail_oauth',
          submittedAt: nowIso,
          updatedAt: nowIso,
        });
      }

      const updatedState: AppStatePayload = {
        ...state,
        coldLeads: [lead, ...(state.coldLeads || [])],
        applications: [...newApps, ...state.applications],
      };
      updatedState.digest = {
        ...updatedState.digest,
        stats: computeStats(updatedState),
      };
      await writeStore(updatedState);

      res.json({ lead, sent, state: updatedState });
    } catch (error) {
      console.error('Cold add error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to add cold target',
      });
    }
  });

  app.post('/api/cold/followup', async (req, res) => {
    try {
      const { leadId } = req.body as { leadId: string };
      if (!leadId) {
        res.status(400).json({ error: 'leadId is required' });
        return;
      }

      const state = await readStore();
      const target = (state.coldLeads || []).find((l) => l.id === leadId);
      if (!target) {
        res.status(404).json({ error: 'Cold lead not found' });
        return;
      }

      const seedProfile = createSeedState().profile;
      const profile = state.profile;
      if (getGmailSmtpConfig()) {
        await sendApplicationViaServerSmtp({
          toEmail: target.contactEmail,
          subject: `Re: ${target.subject}`,
          bodyText: target.followUpBody,
          fromName: profile.name,
          attachmentName: profile.cvAttachmentName || seedProfile.cvAttachmentName,
          attachmentMime: profile.cvAttachmentMime || seedProfile.cvAttachmentMime,
          attachmentBase64:
            profile.cvAttachmentBase64 || seedProfile.cvAttachmentBase64,
        });
      }

      const nowIso = new Date().toISOString();
      const updatedLead: ColdEmailLead = {
        ...target,
        status: 'followed_up',
        followedUpAt: nowIso,
        updatedAt: nowIso,
      };
      const updatedState: AppStatePayload = {
        ...state,
        coldLeads: (state.coldLeads || []).map((l) =>
          l.id === leadId ? updatedLead : l
        ),
      };
      await writeStore(updatedState);

      res.json({ lead: updatedLead, state: updatedState });
    } catch (error) {
      console.error('Cold follow-up error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to send follow-up',
      });
    }
  });

  app.post('/api/replies/analyze', async (req, res) => {
    try {
      const { applicationId, replyText, fromEmail } = req.body as {
        applicationId: string;
        replyText: string;
        fromEmail?: string;
      };

      if (!applicationId || !replyText) {
        res.status(400).json({ error: 'applicationId and replyText are required' });
        return;
      }

      const state = await readStore();
      const target = state.applications.find((a) => a.id === applicationId);
      if (!target) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }

      let stage: ReplyStage = 'Follow-up';
      let status: ApplicationStatus = 'follow_up';
      let feedback = '';
      let nextStep = '';
      let suggestedReply = '';
      let interviewPrep: string[] = [];
      let usedLiveGemini = false;

      const ai = getGeminiClient();
      if (ai) {
        try {
          const prompt = `Classify this recruiter email reply for an application to ${target.company} (${target.role}).
Sender: ${fromEmail || target.recipientEmail}
Email text:
"""
${replyText}
"""

Return ONLY valid JSON:
{
  "stage": "Interview" | "Assessment" | "Follow-up" | "Offer" | "Rejected" | "Acknowledged",
  "feedback": "1 concise sentence summarizing what the recruiter said",
  "nextStep": "1 concrete next action for the candidate",
  "suggestedReply": "Ready-to-send polite reply signed by ${state.profile.name}",
  "interviewPrep": ["3 concise bullet talking points referencing relevant projects"]
}`;
          const response = await Promise.race([
            ai.models.generateContent({
              model: GEMINI_MODEL,
              contents: prompt,
              config: { temperature: 0.1 },
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Gemini timeout')), 5000)
            ),
          ]);
          const parsed = extractJsonObject<{
            stage?: ReplyStage;
            feedback?: string;
            nextStep?: string;
            suggestedReply?: string;
            interviewPrep?: string[];
          }>(response.text || '');

          if (parsed?.stage && parsed.feedback && parsed.nextStep) {
            usedLiveGemini = true;
            stage = parsed.stage;
            feedback = parsed.feedback;
            nextStep = parsed.nextStep;
            suggestedReply = parsed.suggestedReply || '';
            interviewPrep = Array.isArray(parsed.interviewPrep) ? parsed.interviewPrep : [];
            const stageMap: Record<ReplyStage, ApplicationStatus> = {
              Interview: 'interviewing',
              Assessment: 'assessment',
              'Follow-up': 'follow_up',
              Offer: 'offer',
              Rejected: 'rejected',
              Acknowledged: 'replied',
              Bounced: 'bounced',
            };
            status = stageMap[stage] || 'replied';
          }
        } catch (err) {
          geminiCooldownUntil = Date.now() + 5 * 60 * 1000;
          console.warn('Gemini reply classify fallback:', err);
        }
      }

      if (!usedLiveGemini) {
        const fb = classifyReplyFallback(replyText, target.company);
        stage = fb.stage;
        status = fb.status;
        feedback = fb.feedback;
        nextStep = fb.nextStep;
      }

      if (!suggestedReply || interviewPrep.length === 0) {
        const assist = buildReplyAssistantAndPrep(
          target.company,
          target.role,
          stage,
          replyText,
          state.profile.name
        );
        if (!suggestedReply) suggestedReply = assist.suggestedReply;
        if (interviewPrep.length === 0) interviewPrep = assist.interviewPrep;
      }

      const now = new Date().toISOString();
      const updatedApp: JobApplication = {
        ...target,
        status,
        latestRecruiterSnippet: replyText.slice(0, 280),
        aiReplyStage: stage,
        aiReplyFeedback: feedback,
        aiNextStep: nextStep,
        aiSuggestedReply: suggestedReply,
        aiInterviewPrep: interviewPrep,
        updatedAt: now,
      };

      const alert: AlertItem = {
        id: `alert-reply-${Date.now()}`,
        type: 'recruiter_reply',
        title: `${stage} Update — ${target.company}`,
        message: `${feedback} Next: ${nextStep}`,
        applicationId: target.id,
        read: false,
        createdAt: now,
      };

      const updatedState: AppStatePayload = {
        ...state,
        applications: state.applications.map((a) =>
          a.id === target.id ? updatedApp : a
        ),
        alerts: [alert, ...state.alerts],
      };
      updatedState.digest = {
        ...updatedState.digest,
        stats: computeStats(updatedState),
      };

      await writeStore(updatedState);
      void sendInstantPhoneAlert(
        state.profile,
        `Recruiter Reply (${stage}): ${target.company}`,
        `${target.role}: ${feedback}\nNext: ${nextStep}`
      );

      res.json({ application: updatedApp, alert, usedLiveGemini });
    } catch (error) {
      console.error('Reply analyze error:', error);
      res.status(500).json({ error: 'Reply analysis failed' });
    }
  });

  app.post('/api/digest/build', async (req, res) => {
    try {
      const state = await readStore();
      const profile: UserProfile = req.body?.profile || state.profile;
      const jobs: ScoutedJob[] = req.body?.jobs || state.jobs;
      const applications: JobApplication[] =
        req.body?.applications || state.applications;

      const stats = {
        scouted: jobs.length,
        submitted: applications.length,
        captchas: jobs.filter((j) => j.status === 'captcha_required').length,
        replies: applications.filter(
          (a) => Boolean(a.latestRecruiterSnippet) || a.status !== 'submitted'
        ).length,
      };

      let summaryText = '';
      let recurringSkillGaps: string[] = [];
      let cvImprovements: string[] = [];
      let usedLiveGemini = false;

      const ai = getGeminiClient();
      if (ai) {
        try {
          const allGaps = jobs.flatMap((j) => j.cvGaps);
          const prompt = `Create a concise Daily Job Search Feedback Brief for ${profile.name} (${profile.targetRole}).
Stats: ${JSON.stringify(stats)}
Observed CV Gaps across scouted listings: ${JSON.stringify(allGaps)}
Active Recruiter Updates: ${JSON.stringify(
            applications.map((a) => ({
              company: a.company,
              stage: a.aiReplyStage,
              next: a.aiNextStep,
            }))
          )}

Return ONLY valid JSON:
{
  "summaryText": "2-3 crisp sentences summarizing today's pipeline and momentum.",
  "recurringSkillGaps": ["Gap 1", "Gap 2", "Gap 3"],
  "cvImprovements": ["Concrete CV edit 1", "Concrete CV edit 2", "Concrete CV edit 3"]
}`;
          const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
            config: { temperature: 0.2 },
          });
          const parsed = extractJsonObject<{
            summaryText?: string;
            recurringSkillGaps?: string[];
            cvImprovements?: string[];
          }>(response.text || '');
          if (parsed?.summaryText && parsed.recurringSkillGaps && parsed.cvImprovements) {
            usedLiveGemini = true;
            summaryText = parsed.summaryText;
            recurringSkillGaps = parsed.recurringSkillGaps;
            cvImprovements = parsed.cvImprovements;
          }
        } catch (err) {
          console.warn('Gemini digest fallback:', err);
        }
      }

      if (!usedLiveGemini) {
        const readyCount = jobs.filter((j) => j.status === 'ready_to_send').length;
        const interviewCount = applications.filter(
          (a) => a.aiReplyStage === 'Interview'
        ).length;
        const rawGaps = Array.from(new Set(jobs.flatMap((j) => j.cvGaps))).slice(0, 3);

        summaryText = `Today CareerRelay tracked ${stats.scouted} scouted roles (${readyCount} pre-drafted and ready for batch dispatch, ${stats.captchas} paused on manual CAPTCHA verification) and ${stats.submitted} submitted applications with ${stats.replies} recruiter updates (${interviewCount} interview stage).`;
        recurringSkillGaps =
          rawGaps.length > 0
            ? rawGaps
            : [
                'Quantify squad mentorship and architectural ownership',
                'Highlight accessibility (WCAG AA) and high-scale observability metrics',
              ];
        cvImprovements = [
          'Lead your most recent role with business & latency metrics (42% onboarding reduction, 145ms p95).',
          'Add a targeted Technical Stack line matching keywords from your 90%+ roles.',
          'Address recurring listing gaps directly inside a concise Core Competencies strip.',
        ];
      }

      const digest: DailyDigest = {
        generatedAt: new Date().toISOString(),
        summaryText,
        recurringSkillGaps,
        cvImprovements,
        stats,
        lastEmailedAt: state.digest?.lastEmailedAt,
      };

      await writeStore({ ...state, digest });
      res.json({ digest, usedLiveGemini });
    } catch (error) {
      console.error('Digest build error:', error);
      res.status(500).json({ error: 'Digest generation failed' });
    }
  });

  app.post('/api/captcha/report', async (req, res) => {
    try {
      const {
        jobId,
        company,
        role,
        portalUrl,
        recruiterEmail,
        matchScore,
        details,
      } = req.body as {
        jobId?: string;
        company?: string;
        role?: string;
        portalUrl?: string;
        recruiterEmail?: string;
        matchScore?: number;
        details?: string;
      };

      const state = await readStore();
      const now = new Date().toISOString();
      const gateText =
        details ||
        'Automated worker paused at an anti-bot verification challenge (CAPTCHA / Turnstile). Manual human verification in your browser is required.';

      let targetJob = jobId ? state.jobs.find((j) => j.id === jobId) : undefined;
      if (targetJob) {
        targetJob = {
          ...targetJob,
          status: 'captcha_required',
          captchaGateDetails: gateText,
          postingUrl: portalUrl || targetJob.postingUrl,
          updatedAt: now,
        };
      } else {
        const resolvedCompany = company || 'Apex Cloud Systems';
        const resolvedRole = role || 'Staff Full-Stack Product Engineer';
        targetJob = {
          id: `job-captcha-${Date.now()}`,
          role: resolvedRole,
          company: resolvedCompany,
          location: state.profile.targetLocation || 'Remote',
          postingUrl:
            portalUrl ||
            `https://apply.${resolvedCompany
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')}.example/verify`,
          recruiterEmail:
            recruiterEmail ||
            `careers@${resolvedCompany
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')}.example`,
          matchScore: matchScore ?? 91,
          fitFeedback:
            'High CV overlap identified; paused at external portal human-verification gate.',
          cvGaps: ['Confirm availability window in portal questionnaire'],
          coverLetter: `Hi ${resolvedCompany} Hiring Team,

I am excited to apply for the ${resolvedRole} role. My background leading React, TypeScript, and Node.js systems aligns closely with your product engineering priorities.

Best regards,
${state.profile.name}`,
          cvHighlights: [
            '8+ years building B2B SaaS platforms in TypeScript & React',
            'Production Gemini AI + Express pipeline leadership',
          ],
          status: 'captcha_required',
          captchaGateDetails: gateText,
          source: 'External Worker Webhook (/api/captcha/report)',
          createdAt: now,
          updatedAt: now,
        };
      }

      const alert: AlertItem = {
        id: `alert-captcha-${Date.now()}`,
        type: 'captcha_required',
        title: `CAPTCHA Verification Required — ${targetJob.company}`,
        message: `${targetJob.role} paused: ${gateText}`,
        portalUrl: targetJob.postingUrl,
        jobId: targetJob.id,
        captchaStatus: 'pending',
        read: false,
        createdAt: now,
      };

      const exists = state.jobs.some((j) => j.id === targetJob!.id);
      const nextJobs = exists
        ? state.jobs.map((j) => (j.id === targetJob!.id ? targetJob! : j))
        : [targetJob, ...state.jobs];

      const updatedState: AppStatePayload = {
        ...state,
        jobs: nextJobs,
        alerts: [alert, ...state.alerts],
      };
      updatedState.digest = {
        ...updatedState.digest,
        stats: computeStats(updatedState),
      };

      await writeStore(updatedState);
      void sendInstantPhoneAlert(
        state.profile,
        `CAPTCHA Gate: ${targetJob.company}`,
        `${targetJob.role} paused for manual verification.\n${targetJob.postingUrl}`
      );
      res.json({ job: targetJob, alert });
    } catch (error) {
      console.error('CAPTCHA webhook error:', error);
      res.status(500).json({ error: 'CAPTCHA report failed' });
    }
  });

  app.post('/api/alerts/test-whatsapp', async (req, res) => {
    try {
      const state = await readStore();
      const override = (req.body?.profile || {}) as Partial<UserProfile>;
      const mergedProfile: UserProfile = {
        ...state.profile,
        ...override,
      };
      const outcome = await sendInstantPhoneAlert(
        mergedProfile,
        'Test Notification',
        `CareerRelay alerts active for ${mergedProfile.name}. Reply stage, high-match, and CAPTCHA updates will arrive here.`
      );
      res.json({ ok: true, ...outcome });
    } catch (error) {
      res.status(500).json({
        ok: false,
        sent: false,
        channel: 'error',
        detail: error instanceof Error ? error.message : 'Test alert failed',
      });
    }
  });

  let backgroundCycleRunning = false;

  async function runFullAutonomousBackgroundCycle() {
    if (backgroundCycleRunning) return;
    backgroundCycleRunning = true;
    try {
      const current = await readStore();
      if (current.profile.autoScoutCadence !== '15m') {
        return;
      }

      const jobOutcome = await runAutopilotCycle();
      const coldOutcome = await runColdOutreachCycle();
      const portalOutcome =
        current.profile.autoSendEnabled !== false && !IS_VERCEL
          ? await runPortalAutoApplyCycle(undefined, 2)
          : { resolvedEmailCount: 0, formAppliedCount: 0, captchaPausedCount: 0 };
      const syncOutcome = await runGmailInboxSyncCycle().catch(() => ({
        bouncedCount: 0,
        autoClassifiedCount: 0,
      }));

      // Once-daily automatic digest email when today had activity
      const todayPrefix = new Date().toISOString().slice(0, 10);
      const latest = await readStore();
      if (
        latest.profile.dailyDigestEnabled &&
        getGmailSmtpConfig() &&
        latest.digest.lastEmailedAt?.slice(0, 10) !== todayPrefix &&
        latest.applications.some((a) => a.submittedAt?.startsWith(todayPrefix))
      ) {
        try {
          const stats = computeStats(latest);
          const digestBody = `CareerRelay Daily Autonomous Digest (${todayPrefix})\n\nStats: ${stats.scouted} scouted · ${stats.submitted} submitted · ${stats.replies} replies · ${stats.captchas} CAPTCHA pauses.\n\nSummary:\n${latest.digest.summaryText}`;
          await sendApplicationViaServerSmtp({
            toEmail: latest.profile.email,
            subject: `CareerRelay Daily Digest — ${todayPrefix}`,
            bodyText: digestBody,
            fromName: 'CareerRelay Autopilot',
          });
          latest.digest = {
            ...latest.digest,
            stats,
            lastEmailedAt: new Date().toISOString(),
          };
          await writeStore(latest);
        } catch (digestErr) {
          console.warn(
            'Auto daily digest email failed:',
            digestErr instanceof Error ? digestErr.message : digestErr
          );
        }
      }

      console.log(
        `Background 15m cycle completed: jobsScouted=${jobOutcome.newJobs.length}, jobsAutoSent=${jobOutcome.autoSentCount}, coldScouted=${coldOutcome.newLeads.length}, coldAutoSent=${coldOutcome.autoSentCount}, coldFollowUps=${coldOutcome.followUpSentCount}, portalResolved=${portalOutcome.resolvedEmailCount}, portalFormApplied=${portalOutcome.formAppliedCount}, portalPaused=${portalOutcome.captchaPausedCount}, inboxReplies=${syncOutcome.autoClassifiedCount}, bounces=${syncOutcome.bouncedCount}`
      );
    } catch (err) {
      console.warn('Background 15m autopilot cycle failed:', err);
    } finally {
      backgroundCycleRunning = false;
    }
  }

  app.get('/api/cron/autopilot', async (req, res) => {
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    const authHeader = req.headers.authorization || '';
    const authorizedByCronSecret =
      Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;
    if (!authorizedByCronSecret && !isRequestAuthenticated(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    await runFullAutonomousBackgroundCycle();
    res.json({ ok: true, ranAt: new Date().toISOString() });
  });

  return { app, runFullAutonomousBackgroundCycle };
}

async function startServer() {
  const { app, runFullAutonomousBackgroundCycle } = await createApp();
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, () => {
    console.log(`CareerRelay server running at http://localhost:${PORT}`);
  });

  // Run one initial autonomous check 45s after boot, then every 15 minutes
  setTimeout(() => {
    void runFullAutonomousBackgroundCycle();
  }, 45 * 1000);

  setInterval(() => {
    void runFullAutonomousBackgroundCycle();
  }, 15 * 60 * 1000);
}

if (!IS_VERCEL) {
  startServer().catch((err) => {
    console.error('Failed to start CareerRelay server:', err);
    process.exit(1);
  });
}
