import React, { useState, useEffect } from 'react';
import { X, Mail, Paperclip, CheckCircle2, AlertCircle, Send } from 'lucide-react';
import type { ScoutedJob, UserProfile, WorkspaceAuthState } from '../types';

interface BatchSendModalProps {
  open: boolean;
  jobs: ScoutedJob[];
  profile: UserProfile;
  authState: WorkspaceAuthState;
  sending: boolean;
  onClose: () => void;
  onConfirmSend: (
    selectedItems: Array<{
      job: ScoutedJob;
      recipientEmail: string;
      coverLetter: string;
    }>
  ) => Promise<void>;
}

export const BatchSendModal: React.FC<BatchSendModalProps> = ({
  open,
  jobs,
  profile,
  authState,
  sending,
  onClose,
  onConfirmSend,
}) => {
  const [checkedIds, setCheckedIds] = useState<Record<string, boolean>>({});
  const [draftEdits, setDraftEdits] = useState<
    Record<string, { recipientEmail: string; coverLetter: string }>
  >({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const nextChecked: Record<string, boolean> = {};
      const nextEdits: Record<string, { recipientEmail: string; coverLetter: string }> = {};
      jobs.forEach((job) => {
        nextChecked[job.id] = true;
        nextEdits[job.id] = {
          recipientEmail: job.recruiterEmail,
          coverLetter: job.coverLetter,
        };
      });
      setCheckedIds(nextChecked);
      setDraftEdits(nextEdits);
      setExpandedId(jobs[0]?.id ?? null);
    }
  }, [open, jobs]);

  if (!open) return null;

  const selectedJobs = jobs.filter((j) => checkedIds[j.id]);

  const toggleJob = (id: string) => {
    setCheckedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSubmit = async () => {
    if (selectedJobs.length === 0) return;
    await onConfirmSend(
      selectedJobs.map((job) => ({
        job,
        recipientEmail: draftEdits[job.id]?.recipientEmail || job.recruiterEmail,
        coverLetter: draftEdits[job.id]?.coverLetter || job.coverLetter,
      }))
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-lg border border-[#E2E8F0] bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#E2E8F0] px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[#0F172A]">
              Review &amp; Dispatch Batch Applications
            </h2>
            <p className="mt-0.5 text-sm text-[#475569]">
              Confirm recipients and tailored cover letters before sending via{' '}
              {authState.gmailAccessToken || authState.serverGmailConfigured
                ? `Gmail (${authState.userEmail || profile.email})`
                : 'Sandbox Dispatch (configure Gmail in .env or modal to send real emails)'}
              .
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="rounded-md p-1.5 text-[#475569] hover:bg-slate-100 hover:text-[#0F172A]"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Mode & Attachment Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] bg-[#F8FAFC] px-6 py-2.5 text-xs">
          <div className="flex items-center gap-2 text-[#475569]">
            {authState.gmailAccessToken || authState.serverGmailConfigured ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-[#16A34A]">
                <CheckCircle2 className="h-4 w-4" />
                Live Gmail Dispatch Active ({authState.userEmail || profile.email})
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 font-medium text-[#D97706]">
                <AlertCircle className="h-4 w-4" />
                Sandbox Mode · Applications will log locally without emailing external recipients
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[#475569]">
            <Paperclip className="h-3.5 w-3.5" />
            <span>
              Attachment:{' '}
              <strong className="font-medium text-[#0F172A]">
                {profile.cvAttachmentName || 'No CV file attached'}
              </strong>
            </span>
          </div>
        </div>

        {/* Queue list */}
        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {jobs.length === 0 ? (
            <div className="rounded-md border border-[#E2E8F0] p-6 text-center text-sm text-[#475569]">
              No applications are currently queued for dispatch.
            </div>
          ) : (
            jobs.map((job) => {
              const isChecked = Boolean(checkedIds[job.id]);
              const isExpanded = expandedId === job.id;
              const editState = draftEdits[job.id] || {
                recipientEmail: job.recruiterEmail,
                coverLetter: job.coverLetter,
              };

              return (
                <div
                  key={job.id}
                  className={`rounded-md border transition-colors ${
                    isChecked
                      ? 'border-[#2563EB]/40 bg-white'
                      : 'border-[#E2E8F0] bg-[#F8FAFC] opacity-75'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <label className="flex flex-1 cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleJob(job.id)}
                        className="h-4 w-4 rounded border-slate-300 text-[#2563EB] focus:ring-[#2563EB]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-semibold text-[#0F172A]">
                          <span className="truncate">{job.role}</span>
                          <span className="text-[#475569]">·</span>
                          <span className="text-[#475569]">{job.company}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-[#475569]">
                          <Mail className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate font-mono-num">
                            {editState.recipientEmail}
                          </span>
                          <span>·</span>
                          <span className="font-mono-num font-medium text-[#16A34A]">
                            {job.matchScore}% match
                          </span>
                        </div>
                      </div>
                    </label>
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : job.id)}
                      className="rounded border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-medium text-[#0F172A] hover:bg-slate-50"
                    >
                      {isExpanded ? 'Hide Draft' : 'Inspect / Edit'}
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="space-y-3 border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Recipient Email
                        </label>
                        <input
                          type="email"
                          value={editState.recipientEmail}
                          onChange={(e) =>
                            setDraftEdits((prev) => ({
                              ...prev,
                              [job.id]: {
                                ...editState,
                                recipientEmail: e.target.value,
                              },
                            }))
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Tailored Cover Letter
                        </label>
                        <textarea
                          rows={6}
                          value={editState.coverLetter}
                          onChange={(e) =>
                            setDraftEdits((prev) => ({
                              ...prev,
                              [job.id]: {
                                ...editState,
                                coverLetter: e.target.value,
                              },
                            }))
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-2 text-sm leading-relaxed text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[#E2E8F0] bg-[#F8FAFC] px-6 py-4">
          <span className="text-xs text-[#475569]">
            <strong className="font-mono-num text-[#0F172A]">
              {selectedJobs.length}
            </strong>{' '}
            of {jobs.length} applications selected
          </span>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="rounded-md border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-medium text-[#0F172A] hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={sending || selectedJobs.length === 0}
              className="inline-flex items-center gap-2 rounded-md bg-[#2563EB] px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {sending
                ? 'Dispatching...'
                : `Confirm & Send (${selectedJobs.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
