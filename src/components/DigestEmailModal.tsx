import React, { useState, useEffect } from 'react';
import { X, Mail, Send } from 'lucide-react';
import type { DailyDigest, WorkspaceAuthState } from '../types';

interface DigestEmailModalProps {
  open: boolean;
  digest: DailyDigest;
  defaultRecipient: string;
  authState: WorkspaceAuthState;
  sending: boolean;
  onClose: () => void;
  onConfirmSend: (recipientEmail: string, bodyText: string) => Promise<void>;
}

export const DigestEmailModal: React.FC<DigestEmailModalProps> = ({
  open,
  digest,
  defaultRecipient,
  authState,
  sending,
  onClose,
  onConfirmSend,
}) => {
  const [recipientEmail, setRecipientEmail] = useState(defaultRecipient);
  const [bodyText, setBodyText] = useState('');

  useEffect(() => {
    if (open) {
      setRecipientEmail(authState.userEmail || defaultRecipient);
      setBodyText(
        [
          `CareerRelay Daily Feedback Digest (${new Date(digest.generatedAt).toLocaleDateString()})`,
          '',
          `KPIs: ${digest.stats.scouted} Scouted · ${digest.stats.submitted} Submitted · ${digest.stats.captchas} CAPTCHAs · ${digest.stats.replies} Replies`,
          '',
          'SUMMARY',
          digest.summaryText,
          '',
          'RECURRING SKILL GAPS',
          ...digest.recurringSkillGaps.map((g) => `• ${g}`),
          '',
          'RECOMMENDED CV IMPROVEMENTS',
          ...digest.cvImprovements.map((c) => `• ${c}`),
        ].join('\n')
      );
    }
  }, [open, digest, defaultRecipient, authState.userEmail]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-xl rounded-lg border border-[#E2E8F0] bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#E2E8F0] px-6 py-4">
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-[#2563EB]" />
            <h2 className="text-lg font-semibold text-[#0F172A]">
              Confirm Daily Digest Dispatch
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[#475569] hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label className="block text-xs font-medium text-[#475569]">
              Recipient Email
            </label>
            <input
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-[#E2E8F0] px-3 py-2 text-sm text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#475569]">
              Digest Email Body
            </label>
            <textarea
              rows={11}
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              className="mt-1 w-full rounded-md border border-[#E2E8F0] px-3 py-2 font-mono-num text-xs leading-relaxed text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[#E2E8F0] bg-[#F8FAFC] px-6 py-4">
          <span className="text-xs text-[#475569]">
            {authState.gmailAccessToken || authState.serverGmailConfigured
              ? `Will send via live Gmail (${authState.userEmail || defaultRecipient})`
              : 'Sandbox preview mode (no live Gmail configured)'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-medium text-[#0F172A] hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={sending || !recipientEmail.trim()}
              onClick={() => onConfirmSend(recipientEmail, bodyText)}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#2563EB] px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {sending ? 'Sending...' : 'Send Digest'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
