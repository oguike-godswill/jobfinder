export type AutoScoutCadence = 'manual' | '15m';

export type JobStatus =
  | 'ready_to_send'
  | 'portal_only'
  | 'below_threshold'
  | 'captcha_required'
  | 'applied'
  | 'dismissed';

export type ApplicationStatus =
  | 'submitted'
  | 'replied'
  | 'interviewing'
  | 'assessment'
  | 'follow_up'
  | 'offer'
  | 'rejected'
  | 'bounced';

export type ReplyStage =
  | 'Interview'
  | 'Assessment'
  | 'Follow-up'
  | 'Offer'
  | 'Rejected'
  | 'Acknowledged'
  | 'Bounced';

export type AlertType = 'high_match' | 'captcha_required' | 'recruiter_reply';

export interface UserProfile {
  name: string;
  email: string;
  cvText: string;
  cvAttachmentName?: string;
  cvAttachmentMime?: string;
  cvAttachmentBase64?: string;
  targetRole: string;
  targetLocation: string;
  matchThreshold: number;
  autoScoutCadence: AutoScoutCadence;
  autoSendEnabled?: boolean;
  jobDailyLimit?: number;
  maxEmailsPerCycle?: number;
  coldDailyLimit?: number;
  coldFollowUpDays?: number;
  dailyDigestEnabled: boolean;
  lastScoutedAt?: string;
  whatsappPhone?: string;
  whatsappApiKey?: string;
  whatsappWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  instantAlertsEnabled?: boolean;
}

export type ColdLeadStatus =
  | 'ready_to_pitch'
  | 'sent'
  | 'followed_up'
  | 'replied'
  | 'dismissed';

export interface ColdEmailLead {
  id: string;
  company: string;
  contactEmail: string;
  websiteUrl: string;
  githubUrl?: string;
  location: string;
  companyBio: string;
  subject: string;
  pitchBody: string;
  followUpBody: string;
  status: ColdLeadStatus;
  gmailMessageId?: string;
  sentAt?: string;
  followedUpAt?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScoutedJob {
  id: string;
  role: string;
  company: string;
  location: string;
  postingUrl: string;
  recruiterEmail: string;
  emailSource?: 'job_post' | 'company_site' | 'none';
  mxVerified?: boolean;
  matchScore: number;
  fitFeedback: string;
  cvGaps: string[];
  coverLetter: string;
  cvHighlights: string[];
  status: JobStatus;
  captchaGateDetails?: string;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobApplication {
  id: string;
  jobId: string;
  company: string;
  role: string;
  recipientEmail: string;
  sentCoverLetter: string;
  gmailMessageId: string;
  gmailThreadId: string;
  status: ApplicationStatus;
  latestRecruiterSnippet: string;
  aiReplyStage: ReplyStage;
  aiReplyFeedback: string;
  aiNextStep: string;
  dispatchMode: 'gmail_oauth' | 'sandbox';
  submittedAt: string;
  updatedAt: string;
  aiSuggestedReply?: string;
  aiInterviewPrep?: string[];
  tailoredCvTrack?: 'flutter_first' | 'react_first';
}

export interface AlertItem {
  id: string;
  type: AlertType;
  title: string;
  message: string;
  portalUrl?: string;
  jobId?: string;
  applicationId?: string;
  captchaStatus?: 'pending' | 'resolved';
  read: boolean;
  createdAt: string;
}

export interface DailyDigestStats {
  scouted: number;
  submitted: number;
  captchas: number;
  replies: number;
}

export interface DailyDigest {
  generatedAt: string;
  summaryText: string;
  recurringSkillGaps: string[];
  cvImprovements: string[];
  stats: DailyDigestStats;
  lastEmailedAt?: string;
}

export interface AppStatePayload {
  profile: UserProfile;
  jobs: ScoutedJob[];
  applications: JobApplication[];
  alerts: AlertItem[];
  coldLeads?: ColdEmailLead[];
  digest: DailyDigest;
}

export interface MongoConnectionStatus {
  connected: boolean;
  uriMasked: string | null;
  configuredUriMasked?: string | null;
  dbName: string;
  engine: 'mongodb' | 'local_fallback';
  counts?: {
    jobs: number;
    applications: number;
    alerts: number;
  };
}

export interface WorkspaceAuthState {
  mode: 'sandbox' | 'gmail_oauth';
  userEmail?: string;
  userName?: string;
  gmailAccessToken?: string;
  serverGmailConfigured?: boolean;
  mongoStatus: MongoConnectionStatus;
}
