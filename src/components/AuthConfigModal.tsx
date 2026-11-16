import React, { useEffect, useState } from 'react';
import {
  X,
  Database,
  CheckCircle2,
  Mail,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import type { WorkspaceAuthState } from '../types';

interface AuthConfigModalProps {
  open: boolean;
  authState: WorkspaceAuthState;
  defaultEmail: string;
  connectingMongo: boolean;
  mongoError: string | null;
  onClose: () => void;
  onConnectMongo: (uri: string, dbName: string) => Promise<void>;
  onDisconnectMongo: () => Promise<void>;
  onSaveGmailToken: (params: {
    gmailAccessToken?: string;
    userEmail?: string;
  }) => void;
}

export const AuthConfigModal: React.FC<AuthConfigModalProps> = ({
  open,
  authState,
  defaultEmail,
  connectingMongo,
  mongoError,
  onClose,
  onConnectMongo,
  onDisconnectMongo,
  onSaveGmailToken,
}) => {
  const [mongoUri, setMongoUri] = useState(
    authState.mongoStatus.configuredUriMasked || ''
  );
  const [dbName, setDbName] = useState(authState.mongoStatus.dbName || 'careerrelay');
  const [gmailToken, setGmailToken] = useState(authState.gmailAccessToken || '');
  const [senderEmail, setSenderEmail] = useState(authState.userEmail || defaultEmail);

  useEffect(() => {
    if (open) {
      setMongoUri(authState.mongoStatus.configuredUriMasked || '');
      setDbName(authState.mongoStatus.dbName || 'careerrelay');
      setSenderEmail(authState.userEmail || defaultEmail);
    }
  }, [
    open,
    authState.mongoStatus.configuredUriMasked,
    authState.mongoStatus.dbName,
    authState.userEmail,
    defaultEmail,
  ]);

  if (!open) return null;

  const handleMongoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onConnectMongo(mongoUri.trim(), dbName.trim());
  };

  const handleGmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveGmailToken({
      gmailAccessToken: gmailToken.trim() || undefined,
      userEmail: senderEmail.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-lg border border-[#E2E8F0] bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#E2E8F0] px-6 py-4">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-[#2563EB]" />
            <h2 className="text-lg font-semibold text-[#0F172A]">
              MongoDB &amp; Gmail OAuth Configuration
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[#475569] hover:bg-slate-100"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto px-6 py-5">
          {/* Section 1: MongoDB Persistence */}
          <section className="space-y-3 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-[#2563EB]" />
                <h3 className="text-sm font-semibold text-[#0F172A]">
                  MongoDB Persistence
                </h3>
              </div>
              <span
                className={`text-xs font-semibold ${
                  authState.mongoStatus.connected
                    ? 'text-[#16A34A]'
                    : 'text-[#D97706]'
                }`}
              >
                {authState.mongoStatus.connected
                  ? 'Connected (MongoDB)'
                  : 'Local JSON Fallback'}
              </span>
            </div>

            <p className="text-xs text-[#475569]">
              Collections: <code>profiles</code>, <code>jobs</code>,{' '}
              <code>applications</code>, <code>alerts</code>, <code>digests</code>.
            </p>

            {authState.mongoStatus.connected ? (
              <div className="space-y-3 rounded-md border border-[#16A34A]/30 bg-white p-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#16A34A]">
                  <CheckCircle2 className="h-4 w-4" />
                  Active MongoDB Database: {authState.mongoStatus.dbName}
                </div>
                {authState.mongoStatus.uriMasked && (
                  <p className="font-mono-num text-[11px] text-[#475569]">
                    URI: {authState.mongoStatus.uriMasked}
                  </p>
                )}
                {authState.mongoStatus.counts && (
                  <p className="font-mono-num text-[11px] text-[#475569]">
                    Synced Docs: {authState.mongoStatus.counts.jobs} jobs ·{' '}
                    {authState.mongoStatus.counts.applications} applications ·{' '}
                    {authState.mongoStatus.counts.alerts} alerts
                  </p>
                )}
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={onDisconnectMongo}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#DC2626] hover:bg-red-50"
                  >
                    <Unplug className="h-3.5 w-3.5" />
                    Disconnect MongoDB
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {authState.mongoStatus.configuredUriMasked && (
                  <div className="space-y-2 rounded-md border border-[#E2E8F0] bg-white p-3">
                    <div className="text-xs font-medium text-[#0F172A]">
                      Configured in <code>.env.local</code>
                    </div>
                    <p className="font-mono-num text-[11px] text-[#475569]">
                      {authState.mongoStatus.configuredUriMasked}
                    </p>
                    <button
                      type="button"
                      disabled={connectingMongo}
                      onClick={() => onConnectMongo('env', dbName.trim() || 'careerrelay')}
                      className="rounded-md bg-[#2563EB] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {connectingMongo ? 'Connecting...' : 'Reconnect .env.local MongoDB'}
                    </button>
                  </div>
                )}

                <form onSubmit={handleMongoSubmit} className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-[#475569]">
                      MongoDB Connection URI (Local or MongoDB Atlas)
                    </label>
                    <input
                      type="text"
                      required
                      value={mongoUri}
                      onChange={(e) => setMongoUri(e.target.value)}
                      placeholder="mongodb+srv://user:pass@cluster.mongodb.net/careerrelay"
                      className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 font-mono-num text-xs text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#475569]">
                      Database Name
                    </label>
                    <input
                      type="text"
                      required
                      value={dbName}
                      onChange={(e) => setDbName(e.target.value)}
                      placeholder="careerrelay"
                      className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 font-mono-num text-xs text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
                    />
                  </div>

                  {mongoError && (
                    <p className="rounded border border-[#DC2626]/30 bg-red-50 px-3 py-2 text-xs text-[#DC2626]">
                      {mongoError}
                    </p>
                  )}

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={connectingMongo}
                      className="rounded-md border border-[#E2E8F0] bg-white px-3.5 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-slate-50 disabled:opacity-50"
                    >
                      {connectingMongo ? 'Connecting...' : 'Connect MongoDB'}
                    </button>
                  </div>
                </form>
              </div>
            )}
          </section>

          {/* Section 2: Gmail Dispatch & Inbox Sync */}
          <section className="space-y-3 rounded-md border border-[#E2E8F0] bg-white p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-[#2563EB]" />
                <h3 className="text-sm font-semibold text-[#0F172A]">
                  Gmail Dispatch &amp; Inbox Sync
                </h3>
              </div>
              <span
                className={`text-xs font-semibold ${
                  authState.mode === 'gmail_oauth'
                    ? 'text-[#16A34A]'
                    : 'text-[#475569]'
                }`}
              >
                {authState.serverGmailConfigured
                  ? 'Live SMTP/IMAP'
                  : authState.mode === 'gmail_oauth'
                    ? 'Live Gmail OAuth'
                    : 'Sandbox Mode'}
              </span>
            </div>

            {authState.serverGmailConfigured ? (
              <div className="space-y-3 rounded-md border border-[#16A34A]/30 bg-emerald-50/50 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-[#16A34A]">
                  <CheckCircle2 className="h-4 w-4" />
                  Server Gmail SMTP &amp; IMAP Active ({authState.userEmail || defaultEmail})
                </div>
                <p className="text-[#475569]">
                  Batch application sends (<code>smtp.gmail.com:465</code>) and inbox reply
                  syncing (<code>imap.gmail.com:993</code>) are connected via your{' '}
                  <code>.env.local</code> / <code>.env</code> App Password.
                </p>
                {authState.gmailAccessToken && (
                  <p className="font-medium text-[#2563EB]">
                    Browser OAuth override is currently active in memory.
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-start gap-2 rounded bg-[#F8FAFC] p-2.5 text-xs text-[#475569]">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#2563EB]" />
                  <span>
                    Paste a Google OAuth2 Access Token (with <code>gmail.send</code> &amp;{' '}
                    <code>gmail.readonly</code> scopes) to dispatch real batch emails and
                    sync recruiter inbox threads in browser memory.
                  </span>
                </div>

                <form onSubmit={handleGmailSubmit} className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-[#475569]">
                      Sender Gmail Address
                    </label>
                    <input
                      type="email"
                      value={senderEmail}
                      onChange={(e) => setSenderEmail(e.target.value)}
                      placeholder="you@gmail.com"
                      className="mt-1 w-full rounded border border-[#E2E8F0] px-2.5 py-1.5 text-xs text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#475569]">
                      OAuth2 Bearer Access Token
                    </label>
                    <input
                      type="password"
                      value={gmailToken}
                      onChange={(e) => setGmailToken(e.target.value)}
                      placeholder="ya29.a0..."
                      className="mt-1 w-full rounded border border-[#E2E8F0] px-2.5 py-1.5 font-mono-num text-xs text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    {authState.gmailAccessToken && (
                      <button
                        type="button"
                        onClick={() => {
                          setGmailToken('');
                          onSaveGmailToken({
                            gmailAccessToken: undefined,
                            userEmail: senderEmail,
                          });
                        }}
                        className="rounded-md border border-[#E2E8F0] px-3 py-1.5 text-xs font-medium text-[#DC2626] hover:bg-red-50"
                      >
                        Clear Token
                      </button>
                    )}
                    <button
                      type="submit"
                      className="rounded-md border border-[#E2E8F0] bg-[#0F172A] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                    >
                      Apply Gmail Token
                    </button>
                  </div>
                </form>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
