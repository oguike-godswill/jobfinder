import type { JobApplication, UserProfile } from '../types';

export interface SendApplicationEmailParams {
  accessToken?: string;
  serverGmailConfigured?: boolean;
  fromEmail: string;
  fromName: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  attachmentName?: string;
  attachmentMime?: string;
  attachmentBase64?: string;
}

export interface SendEmailResult {
  messageId: string;
  threadId: string;
  mode: 'gmail_oauth' | 'sandbox';
}

function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildMimeMessage(params: SendApplicationEmailParams): string {
  const safeFrom = `${params.fromName.replace(/[\r\n"]/g, '')} <${params.fromEmail}>`;
  const boundary = `careerray_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (params.attachmentBase64 && params.attachmentName) {
    const mimeType = params.attachmentMime || 'application/octet-stream';
    const cleanBase64 = params.attachmentBase64.replace(/\s+/g, '');
    const wrappedBase64 = cleanBase64.replace(/(.{76})/g, '$1\r\n');

    return [
      `From: ${safeFrom}`,
      `To: ${params.toEmail}`,
      `Subject: ${params.subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      params.bodyText,
      '',
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${params.attachmentName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${params.attachmentName}"`,
      '',
      wrappedBase64,
      '',
      `--${boundary}--`,
    ].join('\r\n');
  }

  return [
    `From: ${safeFrom}`,
    `To: ${params.toEmail}`,
    `Subject: ${params.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    params.bodyText,
  ].join('\r\n');
}

export async function sendEmailViaGmail(
  params: SendApplicationEmailParams
): Promise<SendEmailResult> {
  if (params.serverGmailConfigured && !params.accessToken) {
    const res = await fetch('/api/gmail/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toEmail: params.toEmail,
        subject: params.subject,
        bodyText: params.bodyText,
        fromName: params.fromName,
        attachmentName: params.attachmentName,
        attachmentMime: params.attachmentMime,
        attachmentBase64: params.attachmentBase64,
      }),
    });
    const data = (await res.json()) as SendEmailResult & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Server Gmail SMTP error (${res.status})`);
    }
    return data;
  }

  if (!params.accessToken) {
    // Sandbox dispatch when neither server Gmail nor Google OAuth is configured
    const suffix = Math.random().toString(36).slice(2, 10);
    return {
      messageId: `sandbox-msg-${suffix}`,
      threadId: `sandbox-thr-${suffix}`,
      mode: 'sandbox',
    };
  }

  const rawMime = buildMimeMessage(params);
  const raw = encodeBase64Url(rawMime);

  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gmail API error (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as { id: string; threadId: string };
  return {
    messageId: data.id,
    threadId: data.threadId,
    mode: 'gmail_oauth',
  };
}

export interface SyncedReplyCandidate {
  applicationId: string;
  company: string;
  role: string;
  from: string;
  subject: string;
  snippet: string;
  gmailMessageId: string;
  gmailThreadId: string;
}

export async function syncGmailThreads(
  accessToken: string | undefined,
  applications: JobApplication[],
  profile: UserProfile,
  serverGmailConfigured?: boolean
): Promise<{
  candidates: SyncedReplyCandidate[];
  bouncedCount?: number;
  mode: 'gmail_oauth' | 'sandbox';
  state?: import('../types').AppStatePayload;
}> {
  if (serverGmailConfigured && !accessToken) {
    const res = await fetch('/api/gmail/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applications }),
    });
    const data = (await res.json()) as {
      candidates: SyncedReplyCandidate[];
      bouncedCount?: number;
      mode: 'gmail_oauth' | 'sandbox';
      state?: import('../types').AppStatePayload;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.error || `Server Gmail sync error (${res.status})`);
    }
    return {
      candidates: data.candidates || [],
      bouncedCount: data.bouncedCount || 0,
      mode: data.mode,
      state: data.state,
    };
  }

  if (!accessToken) {
    return { candidates: [], mode: 'sandbox' };
  }

  const listUrl =
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox%20newer_than:21d&maxResults=20';
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listRes.ok) {
    const errText = await listRes.text();
    throw new Error(`Gmail sync failed (${listRes.status}): ${errText}`);
  }

  const listJson = (await listRes.json()) as {
    messages?: Array<{ id: string; threadId: string }>;
  };
  const messages = listJson.messages || [];
  if (messages.length === 0) {
    return { candidates: [], mode: 'gmail_oauth' };
  }

  const candidates: SyncedReplyCandidate[] = [];

  for (const msg of messages.slice(0, 15)) {
    const detailRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!detailRes.ok) continue;

    const detail = (await detailRes.json()) as {
      id: string;
      threadId: string;
      snippet?: string;
      payload?: {
        headers?: Array<{ name: string; value: string }>;
      };
    };

    const headers = detail.payload?.headers || [];
    const fromHeader =
      headers.find((h) => h.name.toLowerCase() === 'from')?.value || '';
    const subjectHeader =
      headers.find((h) => h.name.toLowerCase() === 'subject')?.value || '';

    // Skip messages sent by the user themselves
    if (profile.email && fromHeader.toLowerCase().includes(profile.email.toLowerCase())) {
      continue;
    }

    const matchedApp = applications.find((app) => {
      if (app.gmailThreadId && app.gmailThreadId === detail.threadId) return true;
      const emailDomain = app.recipientEmail.split('@')[1]?.toLowerCase();
      return (
        fromHeader.toLowerCase().includes(app.recipientEmail.toLowerCase()) ||
        (emailDomain && fromHeader.toLowerCase().includes(emailDomain)) ||
        subjectHeader.toLowerCase().includes(app.company.toLowerCase())
      );
    });

    if (matchedApp && detail.snippet) {
      candidates.push({
        applicationId: matchedApp.id,
        company: matchedApp.company,
        role: matchedApp.role,
        from: fromHeader,
        subject: subjectHeader,
        snippet: detail.snippet,
        gmailMessageId: detail.id,
        gmailThreadId: detail.threadId,
      });
    }
  }

  return { candidates, mode: 'gmail_oauth' };
}
