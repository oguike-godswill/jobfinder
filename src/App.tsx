import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Radar,
  ShieldAlert,
  BarChart3,
  RefreshCw,
  Mail,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Send,
  ExternalLink,
  CheckCircle2,
  Bell,
  Database,
  Sparkles,
  Upload,
  FileText,
  Webhook,
  Check,
  Inbox,
  Plus,
  Building2,
  Download,
  Search,
  Copy,
  Lock,
  LogOut,
} from 'lucide-react';
import {
  buildWordDocFromCvText,
  createSeedState,
  encodeUtf8ToBase64,
} from './seedData';
import type {
  AlertItem,
  AppStatePayload,
  ColdEmailLead,
  DailyDigest,
  JobApplication,
  JobStatus,
  MongoConnectionStatus,
  ScoutedJob,
  UserProfile,
  WorkspaceAuthState,
} from './types';
import { sendEmailViaGmail, syncGmailThreads } from './services/gmailService';
import { BatchSendModal } from './components/BatchSendModal';
import { CoverLetterDrawer } from './components/CoverLetterDrawer';
import { AuthConfigModal } from './components/AuthConfigModal';
import { DigestEmailModal } from './components/DigestEmailModal';
import { ReplyAnalyzerModal } from './components/ReplyAnalyzerModal';

type NavView = 'queue' | 'cold' | 'exceptions' | 'digest';
type JobFilter =
  | 'all'
  | 'ready_to_send'
  | 'portal_only'
  | 'captcha_required'
  | 'below_threshold'
  | 'applied';

function formatShortTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function App() {
  const [state, setState] = useState<AppStatePayload>(() => createSeedState());
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [activeView, setActiveView] = useState<NavView>('queue');
  const [jobFilter, setJobFilter] = useState<JobFilter>('all');
  const [jobSearch, setJobSearch] = useState('');
  const [controlsOpen, setControlsOpen] = useState(false);

  // Action & loading states
  const [scouting, setScouting] = useState(false);
  const [syncingGmail, setSyncingGmail] = useState(false);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchSending, setBatchSending] = useState(false);
  const [drawerJobId, setDrawerJobId] = useState<string | null>(null);
  const [digestBuilding, setDigestBuilding] = useState(false);
  const [digestEmailModalOpen, setDigestEmailModalOpen] = useState(false);
  const [digestSending, setDigestSending] = useState(false);
  const [replyModalOpen, setReplyModalOpen] = useState(false);
  const [replyTargetAppId, setReplyTargetAppId] = useState<string | undefined>(undefined);
  const [replyAnalyzing, setReplyAnalyzing] = useState(false);
  const [simulatingCaptcha, setSimulatingCaptcha] = useState(false);
  const [autoApplyingPortal, setAutoApplyingPortal] = useState(false);
  const [autoApplyingJobId, setAutoApplyingJobId] = useState<string | null>(null);
  const [testingWhatsapp, setTestingWhatsapp] = useState(false);
  const [expandedReplyAppId, setExpandedReplyAppId] = useState<string | null>(null);
  const [sendingReplyAppId, setSendingReplyAppId] = useState<string | null>(null);

  // Cold Outreach state
  const [coldScouting, setColdScouting] = useState(false);
  const [coldAdding, setColdAdding] = useState(false);
  const [coldFormOpen, setColdFormOpen] = useState(false);
  const [expandedColdId, setExpandedColdId] = useState<string | null>(null);
  const [sendingFollowUpId, setSendingFollowUpId] = useState<string | null>(null);
  const [coldCompany, setColdCompany] = useState('');
  const [coldEmail, setColdEmail] = useState('');
  const [coldWebsite, setColdWebsite] = useState('');
  const [coldBio, setColdBio] = useState('');
  const [coldSendNow, setColdSendNow] = useState(true);

  // Toast notice
  const [toast, setToast] = useState<{ kind: 'info' | 'success' | 'warn'; text: string } | null>(
    null
  );

  // Browser notification state
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );

  // MongoDB & Gmail OAuth config
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [connectingMongo, setConnectingMongo] = useState(false);
  const [mongoError, setMongoError] = useState<string | null>(null);
  const [authState, setAuthState] = useState<WorkspaceAuthState>({
    mode: 'sandbox',
    mongoStatus: {
      connected: false,
      uriMasked: null,
      dbName: 'careerrelay',
      engine: 'local_fallback',
    },
  });

  // Admin login gate state (active when ADMIN_PASSWORD is set on server)
  const [authChecked, setAuthChecked] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(true);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  // Auto-Scout 15m countdown (900 seconds)
  const [countdownSec, setCountdownSec] = useState(900);

  // Profile editor local buffer
  const [profileDraft, setProfileDraft] = useState<UserProfile>(state.profile);

  const showToast = (kind: 'info' | 'success' | 'warn', text: string) => {
    setToast({ kind, text });
  };

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const loadWorkspaceData = async (activeRef?: { current: boolean }) => {
    try {
      const sessionRes = await fetch('/api/auth/session');
      if (sessionRes.ok) {
        const sessionData = (await sessionRes.json()) as {
          authRequired?: boolean;
          authenticated?: boolean;
        };
        if (activeRef && !activeRef.current) return;
        const reqAuth = Boolean(sessionData.authRequired);
        const authed = Boolean(sessionData.authenticated);
        setAuthRequired(reqAuth);
        setIsAuthenticated(authed);
        if (reqAuth && !authed) {
          setAuthChecked(true);
          setLoadingInitial(false);
          return;
        }
      }

      const [stateRes, mongoRes, gmailRes] = await Promise.all([
        fetch('/api/state'),
        fetch('/api/mongodb/status'),
        fetch('/api/gmail/status'),
      ]);
      if (stateRes.status === 401) {
        if (!activeRef || activeRef.current) {
          setAuthRequired(true);
          setIsAuthenticated(false);
        }
        return;
      }
      if (stateRes.ok) {
        const data = (await stateRes.json()) as AppStatePayload;
        if (!activeRef || activeRef.current) {
          setState(data);
          setProfileDraft(data.profile);
        }
      }
      const mongoStatus = mongoRes.ok
        ? ((await mongoRes.json()) as MongoConnectionStatus)
        : undefined;
      const gmailStatus = gmailRes.ok
        ? ((await gmailRes.json()) as { configured: boolean; email: string | null })
        : undefined;

      if (!activeRef || activeRef.current) {
        setAuthState((prev) => ({
          ...prev,
          mongoStatus: mongoStatus || prev.mongoStatus,
          serverGmailConfigured: gmailStatus?.configured ?? prev.serverGmailConfigured,
          mode:
            gmailStatus?.configured || prev.gmailAccessToken
              ? 'gmail_oauth'
              : 'sandbox',
          userEmail: gmailStatus?.email || prev.userEmail,
        }));
      }
    } catch {
      // Fallback to seed state silently if offline
    } finally {
      if (!activeRef || activeRef.current) {
        setAuthChecked(true);
        setLoadingInitial(false);
      }
    }
  };

  // Initial load from backend /api/auth/session, /api/state, /api/mongodb/status, and /api/gmail/status
  useEffect(() => {
    const activeRef = { current: true };
    void loadWorkspaceData(activeRef);
    return () => {
      activeRef.current = false;
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword }),
      });
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        setLoginError(errData.error || 'Invalid admin password.');
        return;
      }
      setLoginPassword('');
      setLoginError(null);
      setIsAuthenticated(true);
      await loadWorkspaceData();
    } catch {
      setLoginError('Unable to reach server to verify password.');
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore network failure when locking client session
    }
    setIsAuthenticated(false);
  };

  const persistState = async (next: AppStatePayload) => {
    setState(next);
    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
    } catch (err) {
      console.warn('Backend state persist failed:', err);
    }
  };

  const fireBrowserNotification = (title: string, body: string) => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  };

  const requestNotifications = async () => {
    if (typeof Notification === 'undefined') {
      showToast('warn', 'Browser Notifications are not supported in this environment.');
      return;
    }
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    if (perm === 'granted') {
      showToast('success', 'Browser exception notifications enabled.');
    } else {
      showToast('warn', 'Browser notification permission was not granted.');
    }
  };

  // Auto-scout interval handler
  const runScoutRef = useRef<() => Promise<void>>(async () => {});

  const handleRunScout = async () => {
    if (scouting) return;
    setScouting(true);
    try {
      const res = await fetch('/api/jobs/autopilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: state.profile }),
      });
      if (!res.ok) throw new Error('Autopilot request failed');
      const data = (await res.json()) as {
        newJobs: ScoutedJob[];
        newAlerts: AlertItem[];
        autoSentApplications?: JobApplication[];
        autoSentCount?: number;
        usedLiveGemini: boolean;
        lastScoutedAt: string;
        state?: AppStatePayload;
      };

      const nextState: AppStatePayload = data.state || {
        ...state,
        profile: {
          ...state.profile,
          lastScoutedAt: data.lastScoutedAt,
        },
        jobs: [...data.newJobs, ...state.jobs],
        alerts: [...data.newAlerts, ...state.alerts],
      };

      setState(nextState);
      setProfileDraft(nextState.profile);

      if (data.newAlerts.length > 0) {
        fireBrowserNotification(data.newAlerts[0].title, data.newAlerts[0].message);
      }

      const readyAdded = data.newJobs.filter((j) => j.status === 'ready_to_send').length;
      const autoSentCount = data.autoSentCount || 0;
      if (data.newJobs.length === 0) {
        showToast(
          autoSentCount > 0 ? 'success' : 'info',
          autoSentCount > 0
            ? `Auto-sent ${autoSentCount} queued application${autoSentCount === 1 ? '' : 's'} with CV attached.`
            : 'Checked live job feeds — no new unscouted roles found right now.'
        );
      } else {
        showToast(
          'success',
          `Scouted ${data.newJobs.length} live roles · Auto-sent ${autoSentCount} (${readyAdded} queued) ${
            data.usedLiveGemini
              ? 'via Gemini Search Grounding'
              : 'via Live Job Feeds (WeWorkRemotely / Remotive / Jobicy)'
          }.`
        );
      }
      setCountdownSec(900);
    } catch {
      showToast('warn', 'Autopilot scout failed. Check server logs and retry.');
    } finally {
      setScouting(false);
    }
  };

  runScoutRef.current = handleRunScout;

  useEffect(() => {
    if (state.profile.autoScoutCadence !== '15m') {
      setCountdownSec(900);
      return;
    }
    const interval = setInterval(() => {
      setCountdownSec((prev) => {
        if (prev <= 1) {
          runScoutRef.current();
          return 900;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [state.profile.autoScoutCadence]);

  // Derived collections & counts
  const readyJobs = useMemo(
    () => state.jobs.filter((j) => j.status === 'ready_to_send'),
    [state.jobs]
  );

  const captchaJobs = useMemo(
    () => state.jobs.filter((j) => j.status === 'captcha_required'),
    [state.jobs]
  );

  const unreadAlertsCount = useMemo(
    () => state.alerts.filter((a) => !a.read || a.captchaStatus === 'pending').length,
    [state.alerts]
  );

  const portalOnlyJobs = useMemo(
    () => state.jobs.filter((j) => j.status === 'portal_only'),
    [state.jobs]
  );

  const filteredJobs = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    const activeJobs = state.jobs.filter((j) => j.status !== 'dismissed');
    const byTab =
      jobFilter === 'all'
        ? activeJobs
        : activeJobs.filter((j) => j.status === jobFilter);
    if (!q) return byTab;
    return byTab.filter(
      (j) =>
        j.role.toLowerCase().includes(q) ||
        j.company.toLowerCase().includes(q) ||
        j.fitFeedback.toLowerCase().includes(q) ||
        j.location.toLowerCase().includes(q)
    );
  }, [state.jobs, jobFilter, jobSearch]);

  const drawerJob = useMemo(
    () => state.jobs.find((j) => j.id === drawerJobId) || null,
    [state.jobs, drawerJobId]
  );

  const kpis = useMemo(
    () => ({
      scouted: state.jobs.filter((j) => j.status !== 'dismissed').length,
      submitted: state.applications.length,
      captchas: captchaJobs.length,
      replies: state.applications.filter(
        (a) => Boolean(a.latestRecruiterSnippet) || a.status !== 'submitted'
      ).length,
    }),
    [state.jobs, state.applications, captchaJobs]
  );

  // Save profile & re-evaluate match threshold on non-applied/non-captcha jobs
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    let nextProfile = { ...profileDraft };
    if (
      !nextProfile.cvAttachmentName ||
      nextProfile.cvAttachmentName.toLowerCase().endsWith('.doc')
    ) {
      const docName = nextProfile.cvAttachmentName || 'Oguike_Godswill_CV.doc';
      nextProfile = {
        ...nextProfile,
        cvAttachmentName: docName,
        cvAttachmentMime: 'application/msword',
        cvAttachmentBase64: encodeUtf8ToBase64(
          buildWordDocFromCvText(nextProfile.cvText)
        ),
      };
    }

    const updatedJobs: ScoutedJob[] = state.jobs.map((job) => {
      if (
        job.status === 'ready_to_send' ||
        job.status === 'below_threshold' ||
        job.status === 'portal_only'
      ) {
        const nextStatus: JobStatus =
          job.matchScore < nextProfile.matchThreshold
            ? 'below_threshold'
            : job.mxVerified && job.recruiterEmail
              ? 'ready_to_send'
              : 'portal_only';
        return { ...job, status: nextStatus, updatedAt: new Date().toISOString() };
      }
      return job;
    });

    setProfileDraft(nextProfile);
    await persistState({
      ...state,
      profile: nextProfile,
      jobs: updatedJobs,
    });
    setControlsOpen(false);
    showToast('success', 'CV (.doc), Auto-Send & Autopilot criteria saved.');
  };

  const handleCvFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      const next: UserProfile = {
        ...profileDraft,
        cvAttachmentName: file.name,
        cvAttachmentMime: file.type || 'application/octet-stream',
        cvAttachmentBase64: base64,
      };
      if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
        try {
          const decoded = atob(base64);
          if (decoded.trim()) next.cvText = decoded;
        } catch {
          // keep existing text
        }
      }
      setProfileDraft(next);
      showToast('info', `Attached ${file.name}. Click Save Criteria to persist.`);
    };
    reader.readAsDataURL(file);
  };

  const handleSaveJobDraft = async (jobId: string, updates: Partial<ScoutedJob>) => {
    const nextJobs = state.jobs.map((j) => (j.id === jobId ? { ...j, ...updates } : j));
    await persistState({ ...state, jobs: nextJobs });
  };

  const handleFlagCaptcha = async (job: ScoutedJob) => {
    try {
      const res = await fetch('/api/captcha/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id,
          company: job.company,
          role: job.role,
          portalUrl: job.postingUrl,
          details: 'Flagged manually from draft inspector for human verification.',
        }),
      });
      if (!res.ok) throw new Error('CAPTCHA report failed');
      const data = (await res.json()) as { job: ScoutedJob; alert: AlertItem };
      const nextState: AppStatePayload = {
        ...state,
        jobs: state.jobs.map((j) => (j.id === data.job.id ? data.job : j)),
        alerts: [data.alert, ...state.alerts],
      };
      setState(nextState);
      fireBrowserNotification(data.alert.title, data.alert.message);
      showToast('warn', `${job.company} paused into Exceptions & Alerts queue.`);
    } catch {
      showToast('warn', 'Could not report CAPTCHA pause.');
    }
  };

  const handleSimulateWebhookCaptcha = async () => {
    setSimulatingCaptcha(true);
    try {
      const res = await fetch('/api/captcha/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: 'Northstar Security',
          role: 'Staff Platform Engineer',
          portalUrl: 'https://apply.northstarsecurity.example/verify-human',
          recruiterEmail: 'talent@northstarsecurity.example',
          matchScore: 91,
          details:
            'Playwright worker encountered hCaptcha challenge on Step 2 of portal submission.',
        }),
      });
      if (!res.ok) throw new Error('Webhook failed');
      const data = (await res.json()) as { job: ScoutedJob; alert: AlertItem };
      setState((prev) => ({
        ...prev,
        jobs: [data.job, ...prev.jobs],
        alerts: [data.alert, ...prev.alerts],
      }));
      fireBrowserNotification(data.alert.title, data.alert.message);
      showToast('warn', 'Webhook received: Northstar Security paused for CAPTCHA verification.');
    } catch {
      showToast('warn', 'Failed to trigger CAPTCHA webhook simulator.');
    } finally {
      setSimulatingCaptcha(false);
    }
  };

  const handleResolveCaptcha = async (jobId: string) => {
    const now = new Date().toISOString();
    const nextJobs = state.jobs.map((j) =>
      j.id === jobId
        ? {
            ...j,
            status: 'ready_to_send' as const,
            captchaGateDetails: undefined,
            updatedAt: now,
          }
        : j
    );
    const nextAlerts = state.alerts.map((a) =>
      a.jobId === jobId && a.type === 'captcha_required'
        ? { ...a, captchaStatus: 'resolved' as const, read: true }
        : a
    );
    await persistState({ ...state, jobs: nextJobs, alerts: nextAlerts });
    showToast('success', 'Verification marked solved — job moved back into Ready Queue.');
  };

  const handleDismissJob = async (jobId: string) => {
    const nextJobs = state.jobs.map((j) =>
      j.id === jobId ? { ...j, status: 'dismissed' as const } : j
    );
    await persistState({ ...state, jobs: nextJobs });
    showToast('info', 'Job dismissed from queue.');
  };

  const handleConfirmBatchSend = async (
    items: Array<{ job: ScoutedJob; recipientEmail: string; coverLetter: string }>
  ) => {
    setBatchSending(true);
    try {
      const now = new Date().toISOString();
      const newApps: JobApplication[] = [];
      const sentJobIds = new Set<string>();

      for (const item of items) {
        const result = await sendEmailViaGmail({
          accessToken: authState.gmailAccessToken,
          serverGmailConfigured: authState.serverGmailConfigured,
          fromEmail: authState.userEmail || state.profile.email,
          fromName: authState.userName || state.profile.name,
          toEmail: item.recipientEmail,
          subject: `Application: ${item.job.role} — ${state.profile.name}`,
          bodyText: item.coverLetter,
          attachmentName: state.profile.cvAttachmentName,
          attachmentMime: state.profile.cvAttachmentMime,
          attachmentBase64: state.profile.cvAttachmentBase64,
        });

        sentJobIds.add(item.job.id);
        newApps.push({
          id: `app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          jobId: item.job.id,
          company: item.job.company,
          role: item.job.role,
          recipientEmail: item.recipientEmail,
          sentCoverLetter: item.coverLetter,
          gmailMessageId: result.messageId,
          gmailThreadId: result.threadId,
          status: 'submitted',
          latestRecruiterSnippet: '',
          aiReplyStage: 'Acknowledged',
          aiReplyFeedback: 'Application dispatched; awaiting recruiter reply.',
          aiNextStep: 'Run Sync Gmail periodically to capture thread responses.',
          dispatchMode: result.mode,
          submittedAt: now,
          updatedAt: now,
        });
      }

      const nextJobs = state.jobs.map((j) =>
        sentJobIds.has(j.id) ? { ...j, status: 'applied' as const, updatedAt: now } : j
      );

      await persistState({
        ...state,
        jobs: nextJobs,
        applications: [...newApps, ...state.applications],
      });

      setBatchModalOpen(false);
      const isLive = Boolean(
        authState.gmailAccessToken || authState.serverGmailConfigured
      );
      showToast(
        'success',
        `Dispatched ${newApps.length} application${newApps.length === 1 ? '' : 's'} (${
          isLive ? 'Gmail Live' : 'Sandbox Mode'
        }).`
      );
    } catch (err) {
      showToast(
        'warn',
        err instanceof Error ? err.message : 'Batch dispatch encountered an error.'
      );
    } finally {
      setBatchSending(false);
    }
  };

  const handleSyncGmail = async () => {
    setSyncingGmail(true);
    try {
      const {
        candidates,
        bouncedCount = 0,
        mode,
        state: syncedState,
      } = await syncGmailThreads(
        authState.gmailAccessToken,
        state.applications,
        state.profile,
        authState.serverGmailConfigured
      );

      if (syncedState) {
        setState(syncedState);
      }

      if (mode === 'sandbox') {
        showToast(
          'info',
          'Sandbox mode active: connect Google OAuth for live inbox sync, or log a reply in Feedback & Daily Digest.'
        );
        return;
      }

      if (candidates.length === 0) {
        if (bouncedCount > 0) {
          showToast(
            'warn',
            `Gmail synced: detected ${bouncedCount} bounced email(s) and moved them to Web Portal Only.`
          );
        } else {
          showToast('info', 'Gmail synced — no new recruiter replies or bounces.');
        }
        return;
      }

      let updatedApps = syncedState ? [...syncedState.applications] : [...state.applications];
      let updatedAlerts = syncedState ? [...syncedState.alerts] : [...state.alerts];

      for (const cand of candidates) {
        const res = await fetch('/api/replies/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            applicationId: cand.applicationId,
            replyText: cand.snippet,
            fromEmail: cand.from,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            application: JobApplication;
            alert: AlertItem;
          };
          updatedApps = updatedApps.map((a) =>
            a.id === data.application.id ? data.application : a
          );
          updatedAlerts = [data.alert, ...updatedAlerts];
        }
      }

      setState((prev) => ({
        ...prev,
        applications: updatedApps,
        alerts: updatedAlerts,
      }));
      showToast('success', `Synced & analyzed ${candidates.length} Gmail recruiter replies.`);
    } catch (err) {
      showToast('warn', err instanceof Error ? err.message : 'Gmail sync failed.');
    } finally {
      setSyncingGmail(false);
    }
  };

  const handleAnalyzeReply = async (params: {
    applicationId: string;
    replyText: string;
    fromEmail: string;
  }) => {
    setReplyAnalyzing(true);
    try {
      const res = await fetch('/api/replies/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error('Analysis failed');
      const data = (await res.json()) as {
        application: JobApplication;
        alert: AlertItem;
      };
      setState((prev) => ({
        ...prev,
        applications: prev.applications.map((a) =>
          a.id === data.application.id ? data.application : a
        ),
        alerts: [data.alert, ...prev.alerts],
      }));
      fireBrowserNotification(data.alert.title, data.alert.message);
      setReplyModalOpen(false);
      setExpandedReplyAppId(data.application.id);
      showToast(
        'success',
        `${data.application.company} classified as ${data.application.aiReplyStage} — Interview Prep & Reply Draft ready.`
      );
    } catch {
      showToast('warn', 'Could not classify reply.');
    } finally {
      setReplyAnalyzing(false);
    }
  };

  const handleTestWhatsapp = async () => {
    setTestingWhatsapp(true);
    try {
      const res = await fetch('/api/alerts/test-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profileDraft }),
      });
      const data = (await res.json()) as {
        sent?: boolean;
        channel?: string;
        detail?: string;
      };
      if (data.sent) {
        showToast('success', data.detail || 'WhatsApp test alert sent.');
      } else {
        showToast(
          'info',
          data.detail ||
            'Add a CallMeBot API key or Webhook URL above to receive live WhatsApp alerts.'
        );
      }
    } catch {
      showToast('warn', 'Failed to trigger WhatsApp test alert.');
    } finally {
      setTestingWhatsapp(false);
    }
  };

  const handleSendSuggestedReply = async (appItem: JobApplication) => {
    if (!appItem.aiSuggestedReply || !appItem.recipientEmail.includes('@')) {
      showToast('warn', 'No valid recruiter email address found for 1-click reply.');
      return;
    }
    setSendingReplyAppId(appItem.id);
    try {
      await sendEmailViaGmail({
        accessToken: authState.gmailAccessToken,
        serverGmailConfigured: authState.serverGmailConfigured,
        fromEmail: authState.userEmail || state.profile.email,
        fromName: authState.userName || state.profile.name,
        toEmail: appItem.recipientEmail,
        subject: `Re: Application: ${appItem.role} — ${state.profile.name}`,
        bodyText: appItem.aiSuggestedReply,
      });
      showToast('success', `Reply sent to ${appItem.recipientEmail} via Gmail.`);
    } catch (err) {
      showToast('warn', err instanceof Error ? err.message : 'Failed to send reply.');
    } finally {
      setSendingReplyAppId(null);
    }
  };

  const handleRebuildDigest = async () => {
    setDigestBuilding(true);
    try {
      const res = await fetch('/api/digest/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: state.profile,
          jobs: state.jobs,
          applications: state.applications,
        }),
      });
      if (!res.ok) throw new Error('Digest build failed');
      const data = (await res.json()) as { digest: DailyDigest; usedLiveGemini: boolean };
      setState((prev) => ({ ...prev, digest: data.digest }));
      showToast('success', 'Daily Feedback Brief regenerated.');
    } catch {
      showToast('warn', 'Failed to regenerate Daily Feedback Brief.');
    } finally {
      setDigestBuilding(false);
    }
  };

  const handleSendDigestEmail = async (recipientEmail: string, bodyText: string) => {
    setDigestSending(true);
    try {
      await sendEmailViaGmail({
        accessToken: authState.gmailAccessToken,
        serverGmailConfigured: authState.serverGmailConfigured,
        fromEmail: authState.userEmail || state.profile.email,
        fromName: 'CareerRelay Autopilot',
        toEmail: recipientEmail,
        subject: `CareerRelay Daily Digest — ${new Date().toLocaleDateString()}`,
        bodyText,
      });

      const nextDigest: DailyDigest = {
        ...state.digest,
        lastEmailedAt: new Date().toISOString(),
      };
      await persistState({ ...state, digest: nextDigest });
      setDigestEmailModalOpen(false);
      const isLive = Boolean(
        authState.gmailAccessToken || authState.serverGmailConfigured
      );
      showToast(
        'success',
        `Daily Digest sent to ${recipientEmail} (${
          isLive ? 'Gmail Live' : 'Sandbox Mode'
        }).`
      );
    } catch (err) {
      showToast('warn', err instanceof Error ? err.message : 'Failed to send digest.');
    } finally {
      setDigestSending(false);
    }
  };

  const handleMarkAllAlertsRead = async () => {
    const nextAlerts = state.alerts.map((a) => ({ ...a, read: true }));
    await persistState({ ...state, alerts: nextAlerts });
  };

  const handleConnectMongo = async (uri: string, dbName: string) => {
    setConnectingMongo(true);
    setMongoError(null);
    try {
      const res = await fetch('/api/mongodb/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri, dbName }),
      });
      const data = (await res.json()) as {
        status?: MongoConnectionStatus;
        state?: AppStatePayload;
        error?: string;
      };
      if (!res.ok || !data.status) {
        throw new Error(data.error || 'Failed to connect to MongoDB.');
      }
      setAuthState((prev) => ({ ...prev, mongoStatus: data.status! }));
      if (data.state) {
        setState(data.state);
        setProfileDraft(data.state.profile);
      }
      showToast('success', `Connected to MongoDB (${data.status.dbName}).`);
    } catch (err) {
      setMongoError(err instanceof Error ? err.message : 'MongoDB connection failed.');
    } finally {
      setConnectingMongo(false);
    }
  };

  const handleDisconnectMongo = async () => {
    try {
      const res = await fetch('/api/mongodb/disconnect', { method: 'POST' });
      const data = (await res.json()) as { status: MongoConnectionStatus };
      setAuthState((prev) => ({ ...prev, mongoStatus: data.status }));
      showToast('info', 'Disconnected MongoDB; switched to local JSON fallback.');
    } catch {
      showToast('warn', 'Could not disconnect MongoDB cleanly.');
    }
  };

  const handleSaveGmailToken = (params: {
    gmailAccessToken?: string;
    userEmail?: string;
  }) => {
    const hasToken = Boolean(params.gmailAccessToken);
    setAuthState((prev) => ({
      ...prev,
      mode: hasToken || prev.serverGmailConfigured ? 'gmail_oauth' : 'sandbox',
      gmailAccessToken: params.gmailAccessToken,
      userEmail: params.userEmail || prev.userEmail,
    }));
    setAuthModalOpen(false);
    showToast(
      hasToken ? 'success' : 'info',
      hasToken
        ? 'Gmail OAuth token applied in memory for live email dispatch & sync.'
        : 'Cleared custom Gmail OAuth token.'
    );
  };

  const handleRunColdAutopilot = async () => {
    if (coldScouting) return;
    setColdScouting(true);
    try {
      const res = await fetch('/api/cold/autopilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: state.profile }),
      });
      if (!res.ok) throw new Error('Cold outreach run failed');
      const data = (await res.json()) as {
        newLeads: ColdEmailLead[];
        autoSentCount: number;
        followUpSentCount: number;
        state: AppStatePayload;
      };
      setState(data.state);
      showToast(
        'success',
        `Cold Outreach: ${data.newLeads.length} companies found · ${data.autoSentCount} pitched · ${data.followUpSentCount} follow-ups sent.`
      );
    } catch {
      showToast('warn', 'Cold outreach cycle failed.');
    } finally {
      setColdScouting(false);
    }
  };

  const handleAddColdTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!coldCompany.trim() || !coldEmail.trim()) return;
    setColdAdding(true);
    try {
      const res = await fetch('/api/cold/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: coldCompany.trim(),
          contactEmail: coldEmail.trim(),
          websiteUrl: coldWebsite.trim(),
          companyBio: coldBio.trim(),
          sendNow: coldSendNow,
        }),
      });
      const data = (await res.json()) as {
        lead?: ColdEmailLead;
        sent?: boolean;
        state?: AppStatePayload;
        error?: string;
      };
      if (!res.ok || !data.state) throw new Error(data.error || 'Failed to add target');
      setState(data.state);
      setColdCompany('');
      setColdEmail('');
      setColdWebsite('');
      setColdBio('');
      setColdFormOpen(false);
      showToast(
        'success',
        data.sent
          ? `Cold pitch + CV sent to ${data.lead?.company} (${data.lead?.contactEmail}).`
          : `Added ${data.lead?.company} to Cold Outreach queue.`
      );
    } catch (err) {
      showToast('warn', err instanceof Error ? err.message : 'Failed to add cold target.');
    } finally {
      setColdAdding(false);
    }
  };

  const handleSendColdFollowUp = async (leadId: string) => {
    setSendingFollowUpId(leadId);
    try {
      const res = await fetch('/api/cold/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId }),
      });
      const data = (await res.json()) as {
        lead?: ColdEmailLead;
        state?: AppStatePayload;
        error?: string;
      };
      if (!res.ok || !data.state) throw new Error(data.error || 'Follow-up failed');
      setState(data.state);
      showToast('success', `Follow-up sent to ${data.lead?.company}.`);
    } catch (err) {
      showToast('warn', err instanceof Error ? err.message : 'Follow-up failed.');
    } finally {
      setSendingFollowUpId(null);
    }
  };

  const handleCopyAndOpenPortal = async (job: ScoutedJob) => {
    try {
      await navigator.clipboard.writeText(job.coverLetter);
      showToast('success', `Copied tailored cover letter for ${job.company} — opening portal.`);
    } catch {
      showToast('info', `Opening portal for ${job.company} (copy cover letter from Inspect).`);
    }
    window.open(job.postingUrl, '_blank', 'noopener,noreferrer');
  };

  const handleMarkPortalApplied = async (jobId: string) => {
    try {
      const res = await fetch('/api/jobs/mark-applied', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const data = (await res.json()) as { state?: AppStatePayload; error?: string };
      if (!res.ok || !data.state) throw new Error(data.error || 'Failed to update');
      setState(data.state);
      showToast('success', 'Marked application as submitted via web portal.');
    } catch (err) {
      showToast('warn', err instanceof Error ? err.message : 'Failed to mark applied.');
    }
  };

  const handleAutoApplyPortals = async (jobId?: string) => {
    if (jobId) {
      setAutoApplyingJobId(jobId);
    } else {
      setAutoApplyingPortal(true);
    }
    try {
      const res = await fetch('/api/jobs/auto-apply-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(jobId ? { jobId } : {}),
      });
      const data = (await res.json()) as {
        resolvedEmailCount?: number;
        formAppliedCount?: number;
        captchaPausedCount?: number;
        state?: AppStatePayload;
        error?: string;
      };
      if (!res.ok || !data.state) {
        throw new Error(data.error || 'Portal auto-apply failed');
      }
      setState(data.state);
      const emailed = data.resolvedEmailCount || 0;
      const formed = data.formAppliedCount || 0;
      const paused = data.captchaPausedCount || 0;
      if (paused > 0 && emailed === 0 && formed === 0) {
        showToast(
          'warn',
          `${paused} portal(s) paused for human verification or manual form review in Exceptions & Alerts.`
        );
      } else {
        showToast(
          'success',
          `Portal Auto-Apply: ${emailed} emailed via company lookup · ${formed} form-submitted · ${paused} paused for CAPTCHA/review.`
        );
      }
    } catch (err) {
      showToast(
        'warn',
        err instanceof Error ? err.message : 'Portal auto-apply encountered an error.'
      );
    } finally {
      setAutoApplyingPortal(false);
      setAutoApplyingJobId(null);
    }
  };

  const stageColorClass = (stage: string) => {
    switch (stage) {
      case 'Interview':
      case 'Offer':
        return 'text-[#16A34A]';
      case 'Assessment':
      case 'Follow-up':
        return 'text-[#D97706]';
      case 'Rejected':
      case 'Bounced':
        return 'text-[#DC2626]';
      default:
        return 'text-[#475569]';
    }
  };

  const statusLabel = (job: ScoutedJob) => {
    switch (job.status) {
      case 'ready_to_send':
        return { text: 'Ready (MX Verified)', cls: 'text-[#16A34A]' };
      case 'portal_only':
        return { text: 'Web Portal Only', cls: 'text-[#D97706]' };
      case 'captcha_required':
        return { text: 'CAPTCHA Paused', cls: 'text-[#D97706]' };
      case 'below_threshold':
        return { text: 'Below Threshold', cls: 'text-[#475569]' };
      case 'applied':
        return { text: 'Submitted', cls: 'text-[#2563EB]' };
      default:
        return { text: 'Dismissed', cls: 'text-[#475569]' };
    }
  };

  const coldLeads = state.coldLeads || [];
  const todayIsoDate = new Date().toISOString().slice(0, 10);
  const coldSentToday = coldLeads.filter((l) =>
    l.sentAt?.startsWith(todayIsoDate)
  ).length;

  const breadcrumbLabel =
    activeView === 'queue'
      ? 'Autopilot Queue'
      : activeView === 'cold'
        ? 'Cold Outreach'
        : activeView === 'exceptions'
          ? 'Exceptions & Alerts'
          : 'Feedback & Daily Digest';

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] text-xs text-[#475569]">
        Checking workspace session...
      </div>
    );
  }

  if (authRequired && !isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] px-4 text-[#0F172A]">
        <div className="w-full max-w-md rounded-lg border border-[#E2E8F0] bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#2563EB] text-white">
              <Lock className="h-4 w-4" />
            </div>
            <div>
              <h1 className="font-heading text-base font-bold text-[#0F172A]">
                CareerRelay Admin Gate
              </h1>
              <p className="text-xs text-[#475569]">
                Sign in to access your CV, job queue, and Gmail controls
              </p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-[#475569]">
                Admin Password
              </label>
              <input
                type="password"
                required
                autoFocus
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="Enter ADMIN_PASSWORD"
                className="mt-1 w-full rounded-md border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
              />
            </div>

            {loginError && (
              <p className="rounded border border-[#DC2626]/30 bg-red-50 px-3 py-2 text-xs text-[#DC2626]">
                {loginError}
              </p>
            )}

            <button
              type="submit"
              disabled={loggingIn}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-[#2563EB] px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Lock className="h-4 w-4" />
              {loggingIn ? 'Unlocking...' : 'Unlock Workspace'}
            </button>
          </form>

          <div className="mt-5 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2.5 text-[11px] text-[#475569]">
            Server Status: <span className="font-semibold text-[#16A34A]">Autonomous 15m Autopilot Active</span> — background job scouting &amp; scheduled dispatching continue running even while locked.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#F8FAFC] text-[#0F172A]">
      {/* Fixed 240px Sticky Left Navigation Rail */}
      <aside className="sticky top-0 flex h-screen w-[240px] shrink-0 flex-col overflow-y-auto border-r border-[#E2E8F0] bg-white">
        <div className="flex h-14 items-center gap-2.5 border-b border-[#E2E8F0] px-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#2563EB] text-white">
            <Radar className="h-4 w-4" />
          </div>
          <div>
            <div className="font-heading text-sm font-bold tracking-tight text-[#0F172A]">
              CareerRelay
            </div>
            <div className="text-[11px] text-[#475569]">Autopilot Job Hub</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          <button
            type="button"
            onClick={() => setActiveView('queue')}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
              activeView === 'queue'
                ? 'bg-[#2563EB]/10 text-[#2563EB]'
                : 'text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Radar className="h-4 w-4" />
              Autopilot Queue
            </span>
            <span className="font-mono-num text-xs font-semibold">
              {readyJobs.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveView('cold')}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
              activeView === 'cold'
                ? 'bg-[#2563EB]/10 text-[#2563EB]'
                : 'text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Building2 className="h-4 w-4" />
              Cold Outreach
            </span>
            <span className="font-mono-num text-xs font-semibold">
              {coldLeads.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveView('exceptions')}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
              activeView === 'exceptions'
                ? 'bg-[#2563EB]/10 text-[#2563EB]'
                : 'text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <ShieldAlert className="h-4 w-4" />
              Exceptions &amp; Alerts
            </span>
            <span
              className={`font-mono-num text-xs font-semibold ${
                captchaJobs.length > 0 ? 'text-[#DC2626]' : ''
              }`}
            >
              {unreadAlertsCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveView('digest')}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
              activeView === 'digest'
                ? 'bg-[#2563EB]/10 text-[#2563EB]'
                : 'text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <BarChart3 className="h-4 w-4" />
              Feedback &amp; Digest
            </span>
            <span className="font-mono-num text-xs font-semibold">
              {kpis.replies}
            </span>
          </button>
        </nav>

        {/* Bottom Rail Status & Auth */}
        <div className="space-y-2.5 border-t border-[#E2E8F0] p-3 text-xs">
          <div className="rounded-md border border-[#E2E8F0] bg-[#F8FAFC] p-2.5">
            <div className="flex items-center justify-between text-[#475569]">
              <span>Auto-Scout</span>
              <span className="font-mono-num font-medium text-[#0F172A]">
                {state.profile.autoScoutCadence === '15m'
                  ? formatCountdown(countdownSec)
                  : 'Manual'}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[#475569]">
              <span>Threshold</span>
              <span className="font-mono-num font-medium text-[#0F172A]">
                {state.profile.matchThreshold}%+
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[#475569]">
              <span>Auto-Send</span>
              <span
                className={`font-mono-num font-semibold ${
                  state.profile.autoSendEnabled !== false
                    ? 'text-[#16A34A]'
                    : 'text-[#475569]'
                }`}
              >
                {state.profile.autoSendEnabled !== false ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={requestNotifications}
            className="flex w-full items-center justify-between rounded-md border border-[#E2E8F0] bg-white px-2.5 py-2 text-left text-xs text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
          >
            <span className="flex items-center gap-2">
              <Bell className="h-3.5 w-3.5" />
              Push Alerts
            </span>
            <span
              className={`font-medium ${
                notifPermission === 'granted' ? 'text-[#16A34A]' : 'text-[#475569]'
              }`}
            >
              {notifPermission === 'granted' ? 'On' : 'Enable'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setAuthModalOpen(true)}
            className="flex w-full items-center justify-between rounded-md border border-[#E2E8F0] bg-white px-2.5 py-2 text-left text-xs text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
          >
            <span className="flex items-center gap-2">
              <Database className="h-3.5 w-3.5" />
              {authState.mongoStatus.connected ? 'MongoDB' : 'MongoDB URI'}
            </span>
            <span
              className={`font-medium ${
                authState.mongoStatus.connected ? 'text-[#16A34A]' : 'text-[#D97706]'
              }`}
            >
              {authState.mongoStatus.connected ? 'Connected' : 'Fallback'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setAuthModalOpen(true)}
            className="flex w-full items-center justify-between rounded-md border border-[#E2E8F0] bg-white px-2.5 py-2 text-left text-xs text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]"
          >
            <span className="flex items-center gap-2">
              <Mail className="h-3.5 w-3.5" />
              Gmail Dispatch
            </span>
            <span
              className={`font-medium ${
                authState.mode === 'gmail_oauth' ? 'text-[#16A34A]' : 'text-[#2563EB]'
              }`}
            >
              {authState.serverGmailConfigured
                ? 'Live'
                : authState.mode === 'gmail_oauth'
                  ? 'OAuth'
                  : 'Sandbox'}
            </span>
          </button>

          {authRequired && (
            <button
              type="button"
              onClick={handleLogout}
              className="flex w-full items-center justify-between rounded-md border border-[#E2E8F0] bg-white px-2.5 py-2 text-left text-xs text-[#DC2626] hover:bg-red-50"
            >
              <span className="flex items-center gap-2">
                <LogOut className="h-3.5 w-3.5" />
                Lock Workspace
              </span>
              <Lock className="h-3 w-3" />
            </button>
          )}
        </div>
      </aside>

      {/* Main Workspace */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Sticky Single-Row Breadcrumb Top Bar */}
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between border-b border-[#E2E8F0] bg-white px-6">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[#475569]">CareerRelay</span>
            <span className="text-[#E2E8F0]">/</span>
            <h1 className="font-heading font-semibold text-[#0F172A]">
              {breadcrumbLabel}
            </h1>
            <span className="ml-3 hidden text-xs text-[#475569] sm:inline">
              Last scouted{' '}
              <span className="font-mono-num text-[#0F172A]">
                {formatShortTime(state.profile.lastScoutedAt)}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleSyncGmail}
              disabled={syncingGmail}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-50"
            >
              <Mail className="h-3.5 w-3.5 text-[#475569]" />
              {syncingGmail ? 'Syncing...' : 'Sync Gmail'}
            </button>

            <button
              type="button"
              onClick={handleRunScout}
              disabled={scouting}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#2563EB] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scouting ? 'animate-spin' : ''}`} />
              {scouting ? 'Scouting...' : 'Scout Now'}
            </button>
          </div>
        </header>

        {/* Toast Notification Banner */}
        {toast && (
          <div
            className={`flex items-center justify-between border-b px-6 py-2 text-xs font-medium ${
              toast.kind === 'success'
                ? 'border-[#16A34A]/20 bg-emerald-50 text-[#16A34A]'
                : toast.kind === 'warn'
                  ? 'border-[#D97706]/20 bg-amber-50 text-[#D97706]'
                  : 'border-[#2563EB]/20 bg-blue-50 text-[#2563EB]'
            }`}
          >
            <span>{toast.text}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="ml-4 underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* View Content */}
        <main className="mx-auto w-full max-w-6xl flex-1 space-y-5 p-6">
          {loadingInitial ? (
            <div className="rounded-md border border-[#E2E8F0] bg-white p-8 text-center text-sm text-[#475569]">
              Loading CareerRelay workspace...
            </div>
          ) : activeView === 'queue' ? (
            <>
              {/* Set-Once CV & Autopilot Controls (Collapsible Strip) */}
              <section className="rounded-md border border-[#E2E8F0] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <SlidersHorizontal className="h-4 w-4 text-[#475569]" />
                    <span className="font-semibold text-[#0F172A]">
                      {state.profile.name}
                    </span>
                    <span className="text-[#475569]">·</span>
                    <span className="text-[#475569]">{state.profile.targetRole}</span>
                    <span className="text-[#475569]">·</span>
                    <span className="text-[#475569]">{state.profile.targetLocation}</span>
                    <span className="text-[#475569]">·</span>
                    <span className="font-mono-num text-xs font-medium text-[#2563EB]">
                      {state.profile.matchThreshold}%+ Match
                    </span>
                    <span className="text-[#475569]">·</span>
                    <span
                      className={`text-xs font-semibold ${
                        state.profile.autoSendEnabled !== false
                          ? 'text-[#16A34A]'
                          : 'text-[#475569]'
                      }`}
                    >
                      Auto-Send: {state.profile.autoSendEnabled !== false ? 'ON' : 'OFF'}
                    </span>
                    <span className="text-[#475569]">·</span>
                    <span className="text-xs text-[#475569]">
                      CV: {state.profile.cvAttachmentName || 'Oguike_Godswill_CV.doc'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <a
                      href="/api/cv/download"
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-slate-50"
                    >
                      <Download className="h-3.5 w-3.5 text-[#475569]" />
                      Download .doc CV
                    </a>
                    <a
                      href="/api/cv/download-pdf"
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#2563EB]/40 bg-blue-50 px-3 py-1.5 text-xs font-medium text-[#2563EB] hover:bg-blue-100"
                    >
                      <Download className="h-3.5 w-3.5 text-[#2563EB]" />
                      Download .pdf CV
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        setProfileDraft(state.profile);
                        setControlsOpen((prev) => !prev);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-slate-100"
                    >
                      Edit CV &amp; Autopilot
                      {controlsOpen ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                {controlsOpen && (
                  <form
                    onSubmit={handleSaveProfile}
                    className="space-y-4 border-t border-[#E2E8F0] bg-[#F8FAFC] px-5 py-4"
                  >
                    <div className="grid gap-4 md:grid-cols-4">
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Candidate Name
                        </label>
                        <input
                          type="text"
                          required
                          value={profileDraft.name}
                          onChange={(e) =>
                            setProfileDraft({ ...profileDraft, name: e.target.value })
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Reply-To Email
                        </label>
                        <input
                          type="email"
                          required
                          value={profileDraft.email}
                          onChange={(e) =>
                            setProfileDraft({ ...profileDraft, email: e.target.value })
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Target Role
                        </label>
                        <input
                          type="text"
                          required
                          value={profileDraft.targetRole}
                          onChange={(e) =>
                            setProfileDraft({
                              ...profileDraft,
                              targetRole: e.target.value,
                            })
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Preferred Location
                        </label>
                        <input
                          type="text"
                          required
                          value={profileDraft.targetLocation}
                          onChange={(e) =>
                            setProfileDraft({
                              ...profileDraft,
                              targetLocation: e.target.value,
                            })
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-4">
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Match Threshold ({profileDraft.matchThreshold}%)
                        </label>
                        <input
                          type="range"
                          min={50}
                          max={100}
                          value={profileDraft.matchThreshold}
                          onChange={(e) =>
                            setProfileDraft({
                              ...profileDraft,
                              matchThreshold: Number(e.target.value),
                            })
                          }
                          className="mt-2 w-full accent-[#2563EB]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Auto-Scout Cadence
                        </label>
                        <select
                          value={profileDraft.autoScoutCadence}
                          onChange={(e) =>
                            setProfileDraft({
                              ...profileDraft,
                              autoScoutCadence: e.target.value as 'manual' | '15m',
                            })
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm focus:border-[#2563EB] focus:outline-none"
                        >
                          <option value="manual">Manual Trigger Only</option>
                          <option value="15m">Every 15m (Autonomous)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Auto-Send Applications ({profileDraft.matchThreshold}%+)
                        </label>
                        <label className="mt-1 flex cursor-pointer items-center gap-2 rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-xs font-medium text-[#0F172A]">
                          <input
                            type="checkbox"
                            checked={profileDraft.autoSendEnabled !== false}
                            onChange={(e) =>
                              setProfileDraft({
                                ...profileDraft,
                                autoSendEnabled: e.target.checked,
                              })
                            }
                            className="h-4 w-4 rounded border-slate-300 text-[#2563EB] focus:ring-[#2563EB]"
                          />
                          <span>
                            {profileDraft.autoSendEnabled !== false
                              ? 'Enabled (send automatically)'
                              : 'Disabled (review batch)'}
                          </span>
                        </label>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          CV Attachment (.doc, .docx, .pdf, .txt)
                        </label>
                        <label className="mt-1 flex cursor-pointer items-center gap-2 rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-xs text-[#0F172A] hover:bg-slate-50">
                          <Upload className="h-3.5 w-3.5 text-[#475569]" />
                          <span className="truncate">
                            {profileDraft.cvAttachmentName || 'Oguike_Godswill_CV.doc'}
                          </span>
                          <input
                            type="file"
                            accept=".doc,.docx,.pdf,.txt"
                            onChange={handleCvFileUpload}
                            className="hidden"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Daily Job Email Cap
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={30}
                          value={profileDraft.jobDailyLimit ?? 8}
                          onChange={(e) =>
                            setProfileDraft({
                              ...profileDraft,
                              jobDailyLimit: Math.max(1, Number(e.target.value) || 8),
                            })
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 font-mono-num text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Max Emails Per 15m Cycle
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={profileDraft.maxEmailsPerCycle ?? 2}
                          onChange={(e) =>
                            setProfileDraft({
                              ...profileDraft,
                              maxEmailsPerCycle: Math.max(1, Number(e.target.value) || 2),
                            })
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 font-mono-num text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Daily Cold Pitch Cap
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={25}
                          value={profileDraft.coldDailyLimit ?? 5}
                          onChange={(e) =>
                            setProfileDraft({
                              ...profileDraft,
                              coldDailyLimit: Math.max(1, Number(e.target.value) || 5),
                            })
                          }
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 font-mono-num text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="rounded-md border border-[#E2E8F0] bg-white p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold text-[#0F172A]">
                            Instant WhatsApp / Phone Alerts
                          </div>
                          <p className="text-[11px] text-[#475569]">
                            Get real-time WhatsApp pings on interviews, 90%+ matches, and
                            CAPTCHA pauses. For free CallMeBot WhatsApp alerts: message{' '}
                            <span className="font-mono-num">
                              &quot;I allow callmebot to send me messages&quot;
                            </span>{' '}
                            to{' '}
                            <span className="font-mono-num font-semibold text-[#0F172A]">
                              +34 644 51 95 23
                            </span>{' '}
                            and paste the key below (or paste any Webhook URL).
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={testingWhatsapp}
                          onClick={handleTestWhatsapp}
                          className="rounded border border-[#16A34A]/40 bg-emerald-50 px-3 py-1 text-xs font-medium text-[#16A34A] hover:bg-emerald-100 disabled:opacity-50"
                        >
                          {testingWhatsapp ? 'Sending Test...' : 'Send Test WhatsApp Alert'}
                        </button>
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        <div>
                          <label className="block text-[11px] font-medium text-[#475569]">
                            WhatsApp Phone Number
                          </label>
                          <input
                            type="text"
                            value={profileDraft.whatsappPhone ?? '+2347060868353'}
                            onChange={(e) =>
                              setProfileDraft({
                                ...profileDraft,
                                whatsappPhone: e.target.value,
                              })
                            }
                            placeholder="+2347060868353"
                            className="mt-1 w-full rounded border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1.5 font-mono-num text-xs focus:border-[#2563EB] focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-[#475569]">
                            CallMeBot WhatsApp API Key
                          </label>
                          <input
                            type="text"
                            value={profileDraft.whatsappApiKey ?? ''}
                            onChange={(e) =>
                              setProfileDraft({
                                ...profileDraft,
                                whatsappApiKey: e.target.value,
                              })
                            }
                            placeholder="e.g. 1234567"
                            className="mt-1 w-full rounded border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1.5 font-mono-num text-xs focus:border-[#2563EB] focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-[#475569]">
                            Custom WhatsApp Webhook URL (optional)
                          </label>
                          <input
                            type="url"
                            value={profileDraft.whatsappWebhookUrl ?? ''}
                            onChange={(e) =>
                              setProfileDraft({
                                ...profileDraft,
                                whatsappWebhookUrl: e.target.value,
                              })
                            }
                            placeholder="https://your-webhook/whatsapp"
                            className="mt-1 w-full rounded border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1.5 font-mono-num text-xs focus:border-[#2563EB] focus:outline-none"
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-[#475569]">
                        CV / Resume Text (used by Gemini Autopilot for matching &amp; cover
                        letters)
                      </label>
                      <textarea
                        rows={5}
                        value={profileDraft.cvText}
                        onChange={(e) =>
                          setProfileDraft({ ...profileDraft, cvText: e.target.value })
                        }
                        className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-3 py-2 font-mono-num text-xs leading-relaxed focus:border-[#2563EB] focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setControlsOpen(false)}
                        className="rounded-md border border-[#E2E8F0] bg-white px-3.5 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="rounded-md bg-[#2563EB] px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                      >
                        Save Criteria &amp; Re-Score
                      </button>
                    </div>
                  </form>
                )}
              </section>

              {/* Ready-to-Send Batch Bar */}
              <section className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-[#E2E8F0] bg-white px-5 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-50 text-[#16A34A]">
                    <Send className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-[#0F172A]">
                      <span className="font-mono-num">{readyJobs.length}</span> Tailored
                      Application{readyJobs.length === 1 ? '' : 's'} Ready
                    </div>
                    <p className="text-xs text-[#475569]">
                      Pre-drafted cover letters meeting your {state.profile.matchThreshold}%+
                      threshold · 1-click Gmail confirmation
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {captchaJobs.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveView('exceptions')}
                      className="text-xs font-medium text-[#D97706] hover:underline"
                    >
                      <span className="font-mono-num">{captchaJobs.length}</span> CAPTCHA
                      pause pending →
                    </button>
                  )}
                  {portalOnlyJobs.length > 0 && (
                    <button
                      type="button"
                      disabled={autoApplyingPortal}
                      onClick={() => handleAutoApplyPortals()}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#2563EB]/40 bg-white px-3.5 py-2 text-xs font-medium text-[#2563EB] hover:bg-blue-50 disabled:opacity-50"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {autoApplyingPortal
                        ? 'Auto-Applying...'
                        : `Auto-Apply Portals (${portalOnlyJobs.length})`}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={readyJobs.length === 0}
                    onClick={() => setBatchModalOpen(true)}
                    className="inline-flex items-center gap-2 rounded-md bg-[#2563EB] px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Send className="h-4 w-4" />
                    Review &amp; Send All ({readyJobs.length})
                  </button>
                </div>
              </section>

              {/* Matched Jobs Table */}
              <section className="rounded-md border border-[#E2E8F0] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-5 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        { id: 'all', label: 'All' },
                        {
                          id: 'ready_to_send',
                          label: `Ready (Email Verified)`,
                        },
                        {
                          id: 'portal_only',
                          label: `Web Portal Only (${portalOnlyJobs.length})`,
                        },
                        { id: 'captcha_required', label: 'CAPTCHA Paused' },
                        { id: 'below_threshold', label: 'Below Threshold' },
                        { id: 'applied', label: 'Submitted' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setJobFilter(tab.id)}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                          jobFilter === tab.id
                            ? 'bg-[#0F172A] text-white'
                            : 'text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#475569]" />
                      <input
                        type="text"
                        value={jobSearch}
                        onChange={(e) => setJobSearch(e.target.value)}
                        placeholder="Search role, company, skill..."
                        className="w-52 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] py-1 pl-8 pr-2.5 text-xs text-[#0F172A] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                      />
                    </div>
                    <span className="font-mono-num text-xs text-[#475569]">
                      {filteredJobs.length} role{filteredJobs.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>

                {scouting && (
                  <div className="border-b border-[#E2E8F0] bg-blue-50/50 px-5 py-2.5 text-xs text-[#2563EB]">
                    Autopilot is scouting openings and pre-drafting tailored cover letters...
                  </div>
                )}

                {filteredJobs.length === 0 ? (
                  <div className="p-10 text-center">
                    <Inbox className="mx-auto h-8 w-8 text-[#475569]/60" />
                    <p className="mt-2 text-sm font-medium text-[#0F172A]">
                      No jobs in this filter view
                    </p>
                    <p className="mt-1 text-xs text-[#475569]">
                      Switch filter tabs or click Scout Now to discover fresh openings.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-[13px]">
                      <thead>
                        <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-medium text-[#475569]">
                          <th className="px-5 py-2.5">Role &amp; Company</th>
                          <th className="px-4 py-2.5">Score</th>
                          <th className="px-4 py-2.5">CV Fit &amp; Gap Feedback</th>
                          <th className="px-4 py-2.5">State</th>
                          <th className="px-5 py-2.5 text-right">Draft</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E2E8F0]">
                        {filteredJobs.map((job) => {
                          const st = statusLabel(job);
                          return (
                            <tr
                              key={job.id}
                              className="transition-colors hover:bg-[#F8FAFC]"
                            >
                              <td className="px-5 py-3.5 align-top">
                                <div className="font-semibold text-[#0F172A]">
                                  {job.role}
                                </div>
                                <div className="mt-0.5 text-xs text-[#475569]">
                                  {job.company} · {job.location}
                                </div>
                              </td>
                              <td className="px-4 py-3.5 align-top">
                                <span
                                  className={`font-mono-num text-sm font-semibold ${
                                    job.matchScore >= 90
                                      ? 'text-[#16A34A]'
                                      : job.matchScore >= state.profile.matchThreshold
                                        ? 'text-[#2563EB]'
                                        : 'text-[#475569]'
                                  }`}
                                >
                                  {job.matchScore}%
                                </span>
                              </td>
                              <td className="max-w-md px-4 py-3.5 align-top text-xs leading-relaxed text-[#475569]">
                                <p className="text-[#0F172A]">{job.fitFeedback}</p>
                                {job.cvGaps.length > 0 && (
                                  <p className="mt-1 text-[#D97706]">
                                    Gap: {job.cvGaps[0]}
                                  </p>
                                )}
                              </td>
                              <td className="px-4 py-3.5 align-top">
                                <span className={`block text-xs font-medium ${st.cls}`}>
                                  {st.text}
                                </span>
                                {job.mxVerified && job.recruiterEmail ? (
                                  <span className="mt-1 inline-block font-mono-num text-[11px] text-[#16A34A]">
                                    MX Verified ✓
                                  </span>
                                ) : job.status === 'portal_only' ? (
                                  <span className="mt-1 inline-block text-[11px] text-[#475569]">
                                    Web Portal Form
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-5 py-3.5 text-right align-top">
                                <div className="flex flex-wrap items-center justify-end gap-1.5">
                                  {job.status === 'portal_only' && (
                                    <>
                                      <button
                                        type="button"
                                        disabled={autoApplyingJobId === job.id}
                                        onClick={() => handleAutoApplyPortals(job.id)}
                                        className="inline-flex items-center gap-1 rounded border border-[#2563EB]/40 bg-white px-2.5 py-1 text-xs font-medium text-[#2563EB] hover:bg-blue-50 disabled:opacity-50"
                                      >
                                        <Sparkles className="h-3 w-3" />
                                        {autoApplyingJobId === job.id
                                          ? 'Running...'
                                          : 'Auto-Apply'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleCopyAndOpenPortal(job)}
                                        className="inline-flex items-center gap-1 rounded bg-[#2563EB] px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
                                      >
                                        <Copy className="h-3 w-3" />
                                        Copy &amp; Open ↗
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleMarkPortalApplied(job.id)}
                                        className="inline-flex items-center gap-1 rounded border border-[#16A34A]/40 bg-white px-2 py-1 text-xs font-medium text-[#16A34A] hover:bg-emerald-50"
                                      >
                                        Mark Applied
                                      </button>
                                    </>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => setDrawerJobId(job.id)}
                                    className="inline-flex items-center gap-1 rounded border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-medium text-[#0F172A] hover:bg-slate-50"
                                  >
                                    <FileText className="h-3.5 w-3.5 text-[#475569]" />
                                    Inspect
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          ) : activeView === 'cold' ? (
            <>
              {/* Cold Outreach Top Autonomous Bar */}
              <section className="rounded-md border border-[#E2E8F0] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
                  <div>
                    <h2 className="text-base font-semibold text-[#0F172A]">
                      Cold Email Outreach &amp; Auto-Follow-Up
                    </h2>
                    <p className="mt-0.5 text-xs text-[#475569]">
                      <span className="font-mono-num font-semibold text-[#0F172A]">
                        {coldSentToday} / {state.profile.coldDailyLimit ?? 10}
                      </span>{' '}
                      Daily Limit ·{' '}
                      <span className="font-mono-num">
                        {state.profile.coldFollowUpDays ?? 4}-Day
                      </span>{' '}
                      Auto-Follow-Up · CV:{' '}
                      <span className="font-mono-num text-[#0F172A]">
                        {state.profile.cvAttachmentName || 'Oguike_Godswill_CV.doc'}
                      </span>
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setColdFormOpen((prev) => !prev)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-slate-100"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add Target Company
                    </button>
                    <button
                      type="button"
                      disabled={coldScouting}
                      onClick={handleRunColdAutopilot}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#2563EB] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {coldScouting
                        ? 'Scouting & Pitching...'
                        : 'Scout & Send Cold Emails Now'}
                    </button>
                  </div>
                </div>

                {coldFormOpen && (
                  <form
                    onSubmit={handleAddColdTarget}
                    className="space-y-3 border-t border-[#E2E8F0] bg-[#F8FAFC] px-5 py-4"
                  >
                    <div className="grid gap-3 md:grid-cols-3">
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Company Name
                        </label>
                        <input
                          type="text"
                          required
                          value={coldCompany}
                          onChange={(e) => setColdCompany(e.target.value)}
                          placeholder="e.g. Paystack"
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Founder / CTO / Hiring Email
                        </label>
                        <input
                          type="email"
                          required
                          value={coldEmail}
                          onChange={(e) => setColdEmail(e.target.value)}
                          placeholder="cto@company.com"
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569]">
                          Website URL (optional)
                        </label>
                        <input
                          type="text"
                          value={coldWebsite}
                          onChange={(e) => setColdWebsite(e.target.value)}
                          placeholder="https://company.com"
                          className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm focus:border-[#2563EB] focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-[#475569]">
                        What They Build (used to personalize hook)
                      </label>
                      <input
                        type="text"
                        value={coldBio}
                        onChange={(e) => setColdBio(e.target.value)}
                        placeholder="e.g. Digital payments and merchant checkout infrastructure across Africa"
                        className="mt-1 w-full rounded border border-[#E2E8F0] bg-white px-2.5 py-1.5 text-sm focus:border-[#2563EB] focus:outline-none"
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-[#0F172A]">
                        <input
                          type="checkbox"
                          checked={coldSendNow}
                          onChange={(e) => setColdSendNow(e.target.checked)}
                          className="h-4 w-4 rounded border-slate-300 text-[#2563EB]"
                        />
                        Send cold email + .doc CV immediately via Gmail
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setColdFormOpen(false)}
                          className="rounded border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#0F172A]"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={coldAdding}
                          className="rounded bg-[#2563EB] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {coldAdding ? 'Adding...' : 'Save & Pitch'}
                        </button>
                      </div>
                    </div>
                  </form>
                )}
              </section>

              {/* Cold Leads Table */}
              <section className="rounded-md border border-[#E2E8F0] bg-white">
                <div className="flex items-center justify-between border-b border-[#E2E8F0] px-5 py-3.5">
                  <span className="text-sm font-semibold text-[#0F172A]">
                    Target Tech Companies &amp; Sent Pitches
                  </span>
                  <span className="font-mono-num text-xs text-[#475569]">
                    {coldLeads.length} lead{coldLeads.length === 1 ? '' : 's'}
                  </span>
                </div>

                {coldLeads.length === 0 ? (
                  <div className="p-10 text-center">
                    <Building2 className="mx-auto h-8 w-8 text-[#475569]/60" />
                    <p className="mt-2 text-sm font-medium text-[#0F172A]">
                      No cold outreach leads yet
                    </p>
                    <p className="mt-1 text-xs text-[#475569]">
                      Click <strong>Scout &amp; Send Cold Emails Now</strong> to discover
                      Lagos &amp; Nigerian tech companies via GitHub and send your pitch +
                      .doc CV.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-[#E2E8F0]">
                    {coldLeads.map((lead) => {
                      const isExpanded = expandedColdId === lead.id;
                      return (
                        <div key={lead.id} className="px-5 py-4 hover:bg-[#F8FAFC]">
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[#0F172A]">
                                <span>{lead.company}</span>
                                <span className="text-[#475569]">·</span>
                                <span className="font-mono-num text-xs font-normal text-[#2563EB]">
                                  {lead.contactEmail}
                                </span>
                                <span className="text-[#475569]">·</span>
                                <span className="text-xs font-normal text-[#475569]">
                                  {lead.location}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-[#475569]">
                                {lead.subject}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#475569]">
                                <span
                                  className={`font-semibold ${
                                    lead.status === 'followed_up' ||
                                    lead.status === 'replied'
                                      ? 'text-[#16A34A]'
                                      : lead.status === 'sent'
                                        ? 'text-[#2563EB]'
                                        : 'text-[#D97706]'
                                  }`}
                                >
                                  {lead.status === 'followed_up'
                                    ? 'Followed Up'
                                    : lead.status === 'sent'
                                      ? `Sent ${formatShortTime(lead.sentAt)}`
                                      : lead.status === 'replied'
                                        ? 'Replied'
                                        : 'Ready to Pitch'}
                                </span>
                                <span>·</span>
                                <span>{lead.source}</span>
                                {lead.websiteUrl && (
                                  <>
                                    <span>·</span>
                                    <a
                                      href={lead.websiteUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-[#2563EB] hover:underline"
                                    >
                                      Website
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  </>
                                )}
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              {lead.status === 'sent' && (
                                <button
                                  type="button"
                                  disabled={sendingFollowUpId === lead.id}
                                  onClick={() => handleSendColdFollowUp(lead.id)}
                                  className="rounded border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-medium text-[#0F172A] hover:bg-slate-50 disabled:opacity-50"
                                >
                                  {sendingFollowUpId === lead.id
                                    ? 'Sending...'
                                    : 'Send Follow-Up'}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedColdId(isExpanded ? null : lead.id)
                                }
                                className="rounded border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-medium text-[#0F172A] hover:bg-slate-50"
                              >
                                {isExpanded ? 'Hide Pitch' : 'Inspect Pitch'}
                              </button>
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="mt-3 space-y-2 rounded-md border border-[#E2E8F0] bg-white p-3 text-xs text-[#0F172A]">
                              <div className="font-semibold text-[#475569]">
                                Pitch Sent:
                              </div>
                              <pre className="whitespace-pre-wrap font-sans leading-relaxed">
                                {lead.pitchBody}
                              </pre>
                              <div className="border-t border-[#E2E8F0] pt-2 font-semibold text-[#475569]">
                                {state.profile.coldFollowUpDays ?? 4}-Day Auto-Follow-Up
                                Template:
                              </div>
                              <pre className="whitespace-pre-wrap font-sans leading-relaxed text-[#475569]">
                                {lead.followUpBody}
                              </pre>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          ) : activeView === 'exceptions' ? (
            <>
              {/* CAPTCHA Verification Queue */}
              <section className="rounded-md border border-[#E2E8F0] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-5 py-4">
                  <div>
                    <h2 className="text-base font-semibold text-[#0F172A]">
                      Manual CAPTCHA Verification Queue
                    </h2>
                    <p className="mt-0.5 text-xs text-[#475569]">
                      External portal gates requiring human verification. Complete the check
                      in your browser, then resume the job to your Ready Queue.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={simulatingCaptcha}
                    onClick={handleSimulateWebhookCaptcha}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-slate-100 disabled:opacity-50"
                  >
                    <Webhook className="h-3.5 w-3.5 text-[#D97706]" />
                    {simulatingCaptcha
                      ? 'Reporting...'
                      : 'Simulate Worker CAPTCHA Webhook'}
                  </button>
                </div>

                <div className="divide-y divide-[#E2E8F0]">
                  {captchaJobs.length === 0 ? (
                    <div className="p-8 text-center">
                      <CheckCircle2 className="mx-auto h-7 w-7 text-[#16A34A]" />
                      <p className="mt-2 text-sm font-medium text-[#0F172A]">
                        No CAPTCHAs waiting for intervention
                      </p>
                      <p className="mt-1 text-xs text-[#475569]">
                        Headless workers posting to <code>/api/captcha/report</code> will
                        pause here and trigger a push alert.
                      </p>
                    </div>
                  ) : (
                    captchaJobs.map((job) => (
                      <div
                        key={job.id}
                        className="flex flex-wrap items-start justify-between gap-4 px-5 py-4"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-xs font-medium text-[#D97706]">
                            <ShieldAlert className="h-4 w-4" />
                            <span>Human Verification Required</span>
                            <span>·</span>
                            <span className="font-mono-num">{job.matchScore}% match</span>
                          </div>
                          <h3 className="mt-1 text-sm font-semibold text-[#0F172A]">
                            {job.role} · {job.company}
                          </h3>
                          <p className="mt-1 text-xs leading-relaxed text-[#475569]">
                            {job.captchaGateDetails ||
                              'Portal verification pause reported by worker.'}
                          </p>
                          <p className="mt-1 font-mono-num text-[11px] text-[#475569]">
                            Portal: {job.postingUrl}
                          </p>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          <a
                            href={job.postingUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-slate-50"
                          >
                            Open Portal
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                          <button
                            type="button"
                            onClick={() => handleResolveCaptcha(job.id)}
                            className="inline-flex items-center gap-1.5 rounded-md bg-[#16A34A] px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                          >
                            <Check className="h-3.5 w-3.5" />
                            Solved — Resume
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              {/* High-Match & Recruiter Alerts Feed */}
              <section className="rounded-md border border-[#E2E8F0] bg-white">
                <div className="flex items-center justify-between border-b border-[#E2E8F0] px-5 py-3.5">
                  <h2 className="text-sm font-semibold text-[#0F172A]">
                    Exception &amp; High-Match Alerts
                  </h2>
                  <button
                    type="button"
                    onClick={handleMarkAllAlertsRead}
                    className="text-xs font-medium text-[#2563EB] hover:underline"
                  >
                    Mark all read
                  </button>
                </div>

                {state.alerts.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[#475569]">
                    No exception alerts logged yet.
                  </div>
                ) : (
                  <div className="divide-y divide-[#E2E8F0]">
                    {state.alerts.map((alert) => (
                      <div
                        key={alert.id}
                        className={`flex items-start justify-between gap-4 px-5 py-3.5 ${
                          alert.read ? 'bg-white' : 'bg-blue-50/30'
                        }`}
                      >
                        <div>
                          <div className="flex items-center gap-2 text-xs">
                            <span
                              className={`font-semibold ${
                                alert.type === 'captcha_required'
                                  ? 'text-[#DC2626]'
                                  : alert.type === 'high_match'
                                    ? 'text-[#16A34A]'
                                    : 'text-[#2563EB]'
                              }`}
                            >
                              {alert.type === 'captcha_required'
                                ? 'CAPTCHA Gate'
                                : alert.type === 'high_match'
                                  ? '90%+ Match'
                                  : 'Recruiter Reply'}
                            </span>
                            <span className="text-[#475569]">·</span>
                            <span className="font-mono-num text-[#475569]">
                              {formatShortTime(alert.createdAt)}
                            </span>
                            {alert.captchaStatus === 'resolved' && (
                              <>
                                <span className="text-[#475569]">·</span>
                                <span className="text-[#16A34A]">Resolved</span>
                              </>
                            )}
                          </div>
                          <p className="mt-1 text-sm font-medium text-[#0F172A]">
                            {alert.title}
                          </p>
                          <p className="mt-0.5 text-xs text-[#475569]">{alert.message}</p>
                        </div>

                        {alert.jobId && (
                          <button
                            type="button"
                            onClick={() => {
                              setDrawerJobId(alert.jobId!);
                              setActiveView('queue');
                            }}
                            className="shrink-0 rounded border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-medium text-[#0F172A] hover:bg-slate-50"
                          >
                            View Job
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : (
            <>
              {/* Single-Row KPI Ledger */}
              <section className="grid grid-cols-2 divide-x divide-y divide-[#E2E8F0] rounded-md border border-[#E2E8F0] bg-white sm:grid-cols-4 sm:divide-y-0">
                <div className="px-5 py-4">
                  <div className="text-xs font-medium text-[#475569]">Scouted</div>
                  <div className="mt-1 font-mono-num text-2xl font-semibold text-[#0F172A]">
                    {kpis.scouted}
                  </div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs font-medium text-[#475569]">Submitted</div>
                  <div className="mt-1 font-mono-num text-2xl font-semibold text-[#2563EB]">
                    {kpis.submitted}
                  </div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs font-medium text-[#475569]">CAPTCHAs</div>
                  <div className="mt-1 font-mono-num text-2xl font-semibold text-[#D97706]">
                    {kpis.captchas}
                  </div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs font-medium text-[#475569]">Replies</div>
                  <div className="mt-1 font-mono-num text-2xl font-semibold text-[#16A34A]">
                    {kpis.replies}
                  </div>
                </div>
              </section>

              {/* Daily Feedback Brief */}
              <section className="rounded-md border border-[#E2E8F0] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-5 py-4">
                  <div>
                    <h2 className="text-base font-semibold text-[#0F172A]">
                      Daily Feedback Brief
                    </h2>
                    <p className="mt-0.5 text-xs text-[#475569]">
                      Generated{' '}
                      <span className="font-mono-num">
                        {formatShortTime(state.digest.generatedAt)}
                      </span>
                      {state.digest.lastEmailedAt && (
                        <>
                          {' '}
                          · Last emailed{' '}
                          <span className="font-mono-num">
                            {formatShortTime(state.digest.lastEmailedAt)}
                          </span>
                        </>
                      )}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={digestBuilding}
                      onClick={handleRebuildDigest}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-slate-50 disabled:opacity-50"
                    >
                      <Sparkles className="h-3.5 w-3.5 text-[#2563EB]" />
                      {digestBuilding ? 'Updating...' : 'Regenerate Brief'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDigestEmailModalOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#2563EB] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      <Mail className="h-3.5 w-3.5" />
                      Email Daily Digest via Gmail
                    </button>
                  </div>
                </div>

                <div className="space-y-4 px-5 py-4">
                  <p className="text-sm leading-relaxed text-[#0F172A]">
                    {state.digest.summaryText}
                  </p>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-md border border-[#E2E8F0] bg-[#F8FAFC] p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[#D97706]">
                        Recurring Skill Gaps Across Listings
                      </h3>
                      <ul className="mt-2 list-inside list-disc space-y-1.5 text-xs leading-relaxed text-[#475569]">
                        {state.digest.recurringSkillGaps.map((gap, i) => (
                          <li key={i}>{gap}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="rounded-md border border-[#E2E8F0] bg-[#F8FAFC] p-4">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-[#16A34A]">
                        Recommended CV Improvements
                      </h3>
                      <ul className="mt-2 list-inside list-disc space-y-1.5 text-xs leading-relaxed text-[#475569]">
                        {state.digest.cvImprovements.map((tip, i) => (
                          <li key={i}>{tip}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </section>

              {/* Centralized Recruiter Tracker */}
              <section className="rounded-md border border-[#E2E8F0] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-5 py-4">
                  <div>
                    <h2 className="text-base font-semibold text-[#0F172A]">
                      Centralized Recruiter Tracker
                    </h2>
                    <p className="mt-0.5 text-xs text-[#475569]">
                      Submitted applications paired with Gmail recruiter replies and AI
                      stage classification
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={state.applications.length === 0}
                    onClick={() => {
                      setReplyTargetAppId(undefined);
                      setReplyModalOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-slate-100 disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-[#2563EB]" />
                    Analyze Recruiter Reply
                  </button>
                </div>

                {state.applications.length === 0 ? (
                  <div className="p-8 text-center text-xs text-[#475569]">
                    No applications submitted yet. Send a batch from the Autopilot Queue.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-[13px]">
                      <thead>
                        <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-medium text-[#475569]">
                          <th className="px-5 py-2.5">Company &amp; Role</th>
                          <th className="px-4 py-2.5">AI Stage</th>
                          <th className="px-4 py-2.5">Latest Recruiter Snippet</th>
                          <th className="px-4 py-2.5">Recommended Next Step</th>
                          <th className="px-5 py-2.5 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E2E8F0]">
                        {state.applications.map((app) => (
                          <React.Fragment key={app.id}>
                          <tr className="hover:bg-[#F8FAFC]">
                            <td className="px-5 py-3.5 align-top">
                              <div className="font-semibold text-[#0F172A]">
                                {app.company}
                              </div>
                              <div className="mt-0.5 text-xs text-[#475569]">
                                {app.role}
                              </div>
                              <div className="mt-1 font-mono-num text-[11px] text-[#475569]">
                                {app.dispatchMode === 'gmail_oauth' ? 'Gmail' : 'Sandbox'}{' '}
                                · {formatShortTime(app.submittedAt)}
                              </div>
                            </td>
                            <td className="px-4 py-3.5 align-top">
                              <span
                                className={`text-xs font-semibold ${stageColorClass(
                                  app.aiReplyStage
                                )}`}
                              >
                                {app.aiReplyStage}
                              </span>
                            </td>
                            <td className="max-w-xs px-4 py-3.5 align-top text-xs leading-relaxed text-[#475569]">
                              {app.latestRecruiterSnippet ||
                                'Awaiting recruiter response in Gmail thread.'}
                            </td>
                            <td className="max-w-sm px-4 py-3.5 align-top text-xs leading-relaxed text-[#0F172A]">
                              <p>{app.aiNextStep}</p>
                            </td>
                            <td className="px-5 py-3.5 text-right align-top">
                              <div className="flex flex-wrap items-center justify-end gap-1.5">
                                {(app.aiSuggestedReply ||
                                  (app.aiInterviewPrep &&
                                    app.aiInterviewPrep.length > 0)) && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedReplyAppId(
                                        expandedReplyAppId === app.id ? null : app.id
                                      )
                                    }
                                    className="rounded border border-[#2563EB]/40 bg-blue-50 px-2.5 py-1 text-xs font-medium text-[#2563EB] hover:bg-blue-100"
                                  >
                                    {expandedReplyAppId === app.id
                                      ? 'Hide Prep'
                                      : 'Prep & Reply Draft'}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setReplyTargetAppId(app.id);
                                    setReplyModalOpen(true);
                                  }}
                                  className="rounded border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-medium text-[#0F172A] hover:bg-slate-50"
                                >
                                  Log Reply
                                </button>
                              </div>
                            </td>
                          </tr>
                          {expandedReplyAppId === app.id &&
                            (app.aiSuggestedReply ||
                              (app.aiInterviewPrep && app.aiInterviewPrep.length > 0)) && (
                              <tr className="bg-[#F8FAFC]">
                                <td colSpan={5} className="px-5 py-4">
                                  <div className="grid gap-4 md:grid-cols-2">
                                    {app.aiInterviewPrep &&
                                      app.aiInterviewPrep.length > 0 && (
                                        <div className="rounded border border-[#E2E8F0] bg-white p-3.5">
                                          <div className="text-xs font-semibold uppercase tracking-wide text-[#2563EB]">
                                            Role Interview Prep Brief
                                          </div>
                                          <ul className="mt-2 list-inside list-disc space-y-1.5 text-xs leading-relaxed text-[#0F172A]">
                                            {app.aiInterviewPrep.map((tip, idx) => (
                                              <li key={idx}>{tip}</li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                    {app.aiSuggestedReply && (
                                      <div className="rounded border border-[#E2E8F0] bg-white p-3.5">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <div className="text-xs font-semibold uppercase tracking-wide text-[#16A34A]">
                                            1-Click Reply Draft
                                          </div>
                                          <div className="flex items-center gap-1.5">
                                            <button
                                              type="button"
                                              onClick={() => {
                                                navigator.clipboard?.writeText(
                                                  app.aiSuggestedReply || ''
                                                );
                                                showToast(
                                                  'info',
                                                  'Suggested reply copied.'
                                                );
                                              }}
                                              className="inline-flex items-center gap-1 rounded border border-[#E2E8F0] bg-white px-2 py-1 text-[11px] font-medium text-[#0F172A] hover:bg-slate-50"
                                            >
                                              <Copy className="h-3 w-3" />
                                              Copy
                                            </button>
                                            {app.recipientEmail.includes('@') && (
                                              <button
                                                type="button"
                                                disabled={sendingReplyAppId === app.id}
                                                onClick={() =>
                                                  handleSendSuggestedReply(app)
                                                }
                                                className="inline-flex items-center gap-1 rounded bg-[#16A34A] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                                              >
                                                <Send className="h-3 w-3" />
                                                {sendingReplyAppId === app.id
                                                  ? 'Sending...'
                                                  : 'Send Reply via Gmail'}
                                              </button>
                                            )}
                                          </div>
                                        </div>
                                        <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed text-[#0F172A]">
                                          {app.aiSuggestedReply}
                                        </pre>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                        </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      </div>

      {/* Drawers & Modals */}
      <CoverLetterDrawer
        job={drawerJob}
        onClose={() => setDrawerJobId(null)}
        onSaveDraft={handleSaveJobDraft}
        onFlagCaptcha={handleFlagCaptcha}
        onDismissJob={handleDismissJob}
      />

      <BatchSendModal
        open={batchModalOpen}
        jobs={readyJobs}
        profile={state.profile}
        authState={authState}
        sending={batchSending}
        onClose={() => setBatchModalOpen(false)}
        onConfirmSend={handleConfirmBatchSend}
      />

      <AuthConfigModal
        open={authModalOpen}
        authState={authState}
        defaultEmail={state.profile.email}
        connectingMongo={connectingMongo}
        mongoError={mongoError}
        onClose={() => setAuthModalOpen(false)}
        onConnectMongo={handleConnectMongo}
        onDisconnectMongo={handleDisconnectMongo}
        onSaveGmailToken={handleSaveGmailToken}
      />

      <DigestEmailModal
        open={digestEmailModalOpen}
        digest={state.digest}
        defaultRecipient={state.profile.email}
        authState={authState}
        sending={digestSending}
        onClose={() => setDigestEmailModalOpen(false)}
        onConfirmSend={handleSendDigestEmail}
      />

      <ReplyAnalyzerModal
        open={replyModalOpen}
        applications={state.applications}
        initialApplicationId={replyTargetAppId}
        analyzing={replyAnalyzing}
        onClose={() => setReplyModalOpen(false)}
        onAnalyze={handleAnalyzeReply}
      />
    </div>
  );
}
