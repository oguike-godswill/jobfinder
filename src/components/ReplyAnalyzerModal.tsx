import React, { useState, useEffect } from 'react';
import { X, Sparkles } from 'lucide-react';
import type { JobApplication } from '../types';

interface ReplyAnalyzerModalProps {
  open: boolean;
  applications: JobApplication[];
  initialApplicationId?: string;
  analyzing: boolean;
  onClose: () => void;
  onAnalyze: (params: {
    applicationId: string;
    replyText: string;
    fromEmail: string;
  }) => Promise<void>;
}

export const ReplyAnalyzerModal: React.FC<ReplyAnalyzerModalProps> = ({
  open,
  applications,
  initialApplicationId,
  analyzing,
  onClose,
  onAnalyze,
}) => {
  const [applicationId, setApplicationId] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [replyText, setReplyText] = useState('');

  useEffect(() => {
    if (open) {
      const selected =
        applications.find((a) => a.id === initialApplicationId) || applications[0];
      if (selected) {
        setApplicationId(selected.id);
        setFromEmail(selected.recipientEmail);
      }
      setReplyText('');
    }
  }, [open, applications, initialApplicationId]);

  if (!open) return null;

  const handleSelectApp = (id: string) => {
    setApplicationId(id);
    const app = applications.find((a) => a.id === id);
    if (app) setFromEmail(app.recipientEmail);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!applicationId || !replyText.trim()) return;
    await onAnalyze({ applicationId, replyText: replyText.trim(), fromEmail });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-[#E2E8F0] bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#E2E8F0] px-6 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-[#2563EB]" />
            <h2 className="text-lg font-semibold text-[#0F172A]">
              Analyze Recruiter Reply
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

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-5">
          <div>
            <label className="block text-xs font-medium text-[#475569]">
              Submitted Application
            </label>
            <select
              value={applicationId}
              onChange={(e) => handleSelectApp(e.target.value)}
              className="mt-1 w-full rounded-md border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
            >
              {applications.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.company} — {app.role}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#475569]">
              Sender Email
            </label>
            <input
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-[#E2E8F0] px-3 py-2 text-sm text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-xs font-medium text-[#475569]">
                Recruiter Message Snippet
              </label>
              <button
                type="button"
                onClick={() =>
                  setReplyText(
                    'Hi Jordan, the team reviewed your profile and would love to invite you to a 60-minute final system design interview next Tuesday at 2pm EST. Let us know your availability!'
                  )
                }
                className="text-xs font-medium text-[#2563EB] hover:underline"
              >
                Insert Sample Invite
              </button>
            </div>
            <textarea
              required
              rows={5}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Paste a recruiter email reply to classify stage and generate next steps..."
              className="mt-1 w-full rounded-md border border-[#E2E8F0] px-3 py-2 text-sm text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[#E2E8F0] px-4 py-2 text-sm font-medium text-[#0F172A] hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={analyzing || applications.length === 0 || !replyText.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#2563EB] px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              {analyzing ? 'Classifying...' : 'Classify & Update Stage'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
