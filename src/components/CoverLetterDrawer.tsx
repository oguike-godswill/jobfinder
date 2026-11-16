import React, { useState, useEffect } from 'react';
import {
  X,
  ExternalLink,
  ShieldAlert,
  CheckCircle2,
  Trash2,
  Save,
} from 'lucide-react';
import type { ScoutedJob } from '../types';

interface CoverLetterDrawerProps {
  job: ScoutedJob | null;
  onClose: () => void;
  onSaveDraft: (jobId: string, updates: Partial<ScoutedJob>) => void;
  onFlagCaptcha: (job: ScoutedJob) => void;
  onDismissJob: (jobId: string) => void;
}

export const CoverLetterDrawer: React.FC<CoverLetterDrawerProps> = ({
  job,
  onClose,
  onSaveDraft,
  onFlagCaptcha,
  onDismissJob,
}) => {
  const [recruiterEmail, setRecruiterEmail] = useState('');
  const [coverLetter, setCoverLetter] = useState('');
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    if (job) {
      setRecruiterEmail(job.recruiterEmail);
      setCoverLetter(job.coverLetter);
      setSavedNotice(false);
    }
  }, [job]);

  if (!job) return null;

  const handleSave = () => {
    onSaveDraft(job.id, {
      recruiterEmail,
      coverLetter,
      updatedAt: new Date().toISOString(),
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30">
      <div className="flex h-full w-full max-w-xl flex-col border-l border-[#E2E8F0] bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[#E2E8F0] px-6 py-4">
          <div className="min-w-0 pr-4">
            <div className="flex items-center gap-2 text-xs text-[#475569]">
              <span className="font-medium text-[#0F172A]">{job.company}</span>
              <span>·</span>
              <span>{job.location}</span>
              <span>·</span>
              <span className="font-mono-num font-semibold text-[#16A34A]">
                {job.matchScore}% match
              </span>
            </div>
            <h2 className="mt-1 text-lg font-semibold text-[#0F172A]">
              {job.role}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[#475569] hover:bg-slate-100 hover:text-[#0F172A]"
            aria-label="Close drawer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="rounded-md border border-[#E2E8F0] bg-[#F8FAFC] p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#475569]">
              AI Fit &amp; CV Gap Assessment
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-[#0F172A]">
              {job.fitFeedback}
            </p>
            {job.cvGaps.length > 0 && (
              <div className="mt-3 border-t border-[#E2E8F0] pt-2.5">
                <p className="text-xs font-medium text-[#D97706]">
                  Spotted CV Gaps:
                </p>
                <ul className="mt-1 list-inside list-disc space-y-1 text-xs text-[#475569]">
                  {job.cvGaps.map((gap, i) => (
                    <li key={i}>{gap}</li>
                  ))}
                </ul>
              </div>
            )}
            {job.cvHighlights.length > 0 && (
              <div className="mt-3 border-t border-[#E2E8F0] pt-2.5">
                <p className="text-xs font-medium text-[#16A34A]">
                  Emphasized CV Highlights:
                </p>
                <ul className="mt-1 list-inside list-disc space-y-1 text-xs text-[#475569]">
                  {job.cvHighlights.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold uppercase tracking-wide text-[#475569]">
                Recruiter / Hiring Email
              </label>
              <a
                href={job.postingUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-[#2563EB] hover:underline"
              >
                Open Listing
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <input
              type="email"
              value={recruiterEmail}
              onChange={(e) => setRecruiterEmail(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-[#475569]">
              Pre-Drafted Cover Letter
            </label>
            <textarea
              rows={11}
              value={coverLetter}
              onChange={(e) => setCoverLetter(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm leading-relaxed text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
            />
          </div>

          {job.source && (
            <p className="text-xs text-[#475569]">
              Source: <span className="font-mono-num">{job.source}</span>
            </p>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E2E8F0] bg-[#F8FAFC] px-6 py-4">
          <div className="flex items-center gap-2">
            {job.status !== 'captcha_required' && job.status !== 'applied' && (
              <button
                type="button"
                onClick={() => {
                  onFlagCaptcha(job);
                  onClose();
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#D97706]/40 bg-white px-3 py-1.5 text-xs font-medium text-[#D97706] hover:bg-amber-50"
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                Report CAPTCHA Gate
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onDismissJob(job.id);
                onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#DC2626] hover:bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Dismiss
            </button>
          </div>

          <div className="flex items-center gap-2">
            {savedNotice && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-[#16A34A]">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Saved
              </span>
            )}
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#2563EB] px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Save className="h-4 w-4" />
              Save Draft
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
