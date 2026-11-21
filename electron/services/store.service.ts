import Store from 'electron-store'

interface Session {
  token: string
  user: {
    id: string
    username: string
    email: string
    role: string
    points: number
    balance: number
  }
}

const HOUR_MS = 60 * 60 * 1000
const RESTRICTION_COOLDOWNS_MS: readonly number[] = [24 * HOUR_MS, 72 * HOUR_MS, 168 * HOUR_MS]

/** Returns how long a restricted account must rest, escalating with consecutive restrictions. */
export function getRestrictionCooldownMs(restrictCount: number): number {
  const index = Math.min(Math.max(restrictCount, 1), RESTRICTION_COOLDOWNS_MS.length) - 1
  return RESTRICTION_COOLDOWNS_MS[index]
}

interface SocialAccount {
  id: string
  platform: string
  username: string
  cookieData: string
  tokenData?: string
  status: string
  isManual?: boolean
  userAgent?: string
  assignedIp?: string   // IPv6 cố định được gán 1 lần duy nhất khi lần đầu nhận từ server
  restrictedAt?: number // Lưu thời điểm bị cấm đăng để có thể thử lại sau cooldown
  restrictCount?: number // Số lần bị hạn chế liên tiếp, dùng để tăng dần thời gian chờ
}

interface AppData {
  session: Session | null
  accounts: SocialAccount[]
  workerStats: {
    tasksCompleted: number
    totalPointsEarned: number
    lastRunAt: string | null
  }
  emailConfig: {
    email: string
    password: string
  } | null
  appSettings: {
    runHeadless: boolean
  }
  scannerConfig: ScannerConfig
  leads: ScrapedLead[]
  autoPostConfig: AutoPostConfig
  aiConfig: AiConfig
}

export interface AutoPostConfig {
  mode: 'SHARE' | 'POST'
  groupIds: string
  interval: string
  repeatEnabled: boolean
  content1: string
  content2: string
  content3: string
  images: Array<{ path: string, preview: string }>
  targetUrl: string
  isAnonymous?: boolean
}

export interface PostStats {
  total: number
  today: number
}

export interface ScrapedLead {
  id: string;              // Unique post ID to avoid duplicates
  groupName?: string;
  authorName: string;
  authorUrl?: string;
  content: string;
  postUrl: string;
  postTimeText?: string;
  matchedKeywords: string[];
  timestamp: number;
  status: 'new' | 'read' | 'contacted';
  suggestedComment?: string;
}

export interface JobItem {
  id: string
  title: string
  location?: string
  salary?: string
  workingHours?: string
  description?: string
  contactInfo?: string
}

export interface AiConfig {
  provider: 'gemini' | 'openai' | 'custom'
  apiKey: string
  modelName: string
  systemPrompt?: string
  maxTokens: number
  jobList?: string[]
  jobsText?: string
  jobs?: JobItem[]
  autoComment: boolean
  commentDelaySeconds: number
  commentAccountSelection: 'random' | 'first_active'
}

export interface ScannerConfig {
  industryMode?: 'RECRUITMENT' | 'SPA_BEAUTY';
  groups: string[];
  keywords: string[];
  intentKeywords?: string[];
  commentKeywords?: string[];
  excludeKeywords?: string[];
  autoFilterSpam?: boolean;
  scanComments?: boolean;
  maxPostAgeDays?: number; // Chỉ quét bài đăng trong vòng N ngày đổ lại (mặc định 3)
  maxPostLength?: number; // Bỏ qua bài viết dài hơn N ký tự (0 = không giới hạn, mặc định 400 để né bài tuyển dụng/JD dài)
  intervalMinutes: number;
  isRunning: boolean;
  notifyRecipient?: string; // Canonical Messenger thread URL that receives new-lead digests
}

interface StoredPostStats {
  total: number
  dayKey: string
  today: number
}

const schema = {
  session: { type: 'object', nullable: true },
  accounts: { type: 'array', default: [] },
  workerStats: {
    type: 'object',
    default: {
      tasksCompleted: 0,
      totalPointsEarned: 0,
    },
  },
  emailConfig: { type: 'object', nullable: true },
  appSettings: {
    type: 'object',
    default: {
      runHeadless: false
    }
  },
  autoPostConfig: {
    type: 'object',
    default: {
      mode: 'POST',
      groupIds: '',
      interval: '180',
      repeatEnabled: true,
      content1: '',
      content2: '',
      content3: '',
      images: [],
      targetUrl: ''
    }
  },
}

export function extractFacebookPostId(url?: string): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null

  const pathMatch = trimmed.match(/\/(?:posts|permalink)\/([a-zA-Z0-9]+)/i)
  if (pathMatch) return pathMatch[1]

  const multiMatch = trimmed.match(/multi_permalinks=([a-zA-Z0-9]+)/i)
  if (multiMatch) return multiMatch[1]

  const storyMatch = trimmed.match(/story_fbid=([a-zA-Z0-9]+)/i)
  if (storyMatch) return storyMatch[1]

  const gmMatch = trimmed.match(/[?&]set=gm\.([a-zA-Z0-9]+)/i)
  if (gmMatch) return gmMatch[1]

  const fbidMatch = trimmed.match(/[?&]fbid=([a-zA-Z0-9]+)/i)
  if (fbidMatch) return fbidMatch[1]

  const videoMatch = trimmed.match(/\/(?:videos|reel)\/([a-zA-Z0-9]+)/i) || trimmed.match(/[?&]v=([a-zA-Z0-9]+)/i)
  if (videoMatch) return videoMatch[1]

  return null
}

export function normalizePostContentForDedup(content?: string): string {
  if (!content) return ''
  return content
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]/g, '')
}

function getCoreContent(content: string): string {
  if (!content) return ''
  const parts = content.split(/💬\s*ỨNG VIÊN BÌNH LUẬN XIN VIỆC|\[Ứng viên bình luận xin việc\]/i)
  return parts[0] || content
}

function normalizeAuthorName(name?: string): string {
  if (!name) return ''
  return name
    .replace(/^📌\s*/, '')
    .replace(/^💬\s*/, '')
    .replace(/\s*\(\d+\s*cmt xin việc\)/i, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]/g, '')
    .trim()
}

function extractGroupIdentifier(url?: string, groupName?: string): string {
  if (url) {
    const m = url.match(/groups\/([^/?#]+)/i)
    if (m) return m[1].toLowerCase()
  }
  if (groupName && groupName !== 'Nhóm') {
    return groupName.trim().toLowerCase()
  }
  return ''
}

export function isSameLead(a: ScrapedLead, b: ScrapedLead): boolean {
  if (!a || !b) return false
  if (a.id && b.id && a.id === b.id) return true

  // Kiểm tra nhóm: Nếu 2 bài thuộc 2 NHÓM KHÁC NHAU RÕ RÀNG -> Cho phép lưu cả hai (nhiều nhóm khác nhau thì được)
  const groupA = extractGroupIdentifier(a.postUrl, a.groupName)
  const groupB = extractGroupIdentifier(b.postUrl, b.groupName)
  if (groupA && groupB && groupA !== groupB) {
    return false
  }

  // TRONG CÙNG MỘT NHÓM: TUYỆT ĐỐI KHÔNG ĐƯỢC TRÙNG 1 BÀI VIẾT
  // 1. So sánh Facebook Post ID (chính xác tuyệt đối)
  const postIdA = extractFacebookPostId(a.postUrl) || (a.id.startsWith('fb_') && !a.id.startsWith('fb_cmt_') ? a.id.replace('fb_', '') : null)
  const postIdB = extractFacebookPostId(b.postUrl) || (b.id.startsWith('fb_') && !b.id.startsWith('fb_cmt_') ? b.id.replace('fb_', '') : null)
  if (postIdA && postIdB && postIdA.toLowerCase() === postIdB.toLowerCase()) {
    return true
  }

  // 2. So sánh URL bài viết gốc đã chuẩn hóa
  const cleanUrlA = (a.postUrl || '').replace(/^https?:\/\//i, '').replace(/^(?:www|m|web)\./i, '').split('?')[0].split('#')[0].replace(/\/+$/, '')
  const cleanUrlB = (b.postUrl || '').replace(/^https?:\/\//i, '').replace(/^(?:www|m|web)\./i, '').split('?')[0].split('#')[0].replace(/\/+$/, '')
  if (cleanUrlA && cleanUrlB && cleanUrlA === cleanUrlB && !cleanUrlA.endsWith('/groups')) {
    return true
  }

  // 3. Nếu một bên là bài viết gốc và một bên là bình luận của bài viết đó trong nhóm -> TRÙNG (bài gốc đã tổng hợp cmt)
  const isCmtA = a.id.startsWith('fb_cmt_') || a.content.includes('[Ứng viên bình luận xin việc]')
  const isCmtB = b.id.startsWith('fb_cmt_') || b.content.includes('[Ứng viên bình luận xin việc]')
  if (isCmtA !== isCmtB) {
    if (postIdA && postIdB && postIdA.toLowerCase() === postIdB.toLowerCase()) return true
    if (cleanUrlA && cleanUrlB && cleanUrlA === cleanUrlB && !cleanUrlA.endsWith('/groups')) return true
  }

  // 4. Nếu cả hai đều là bình luận trong cùng nhóm: trùng nếu cùng bài viết VÀ cùng người bình luận
  if (isCmtA && isCmtB) {
    const authA = normalizeAuthorName(a.authorName)
    const authB = normalizeAuthorName(b.authorName)
    const samePost = (postIdA && postIdB && postIdA.toLowerCase() === postIdB.toLowerCase()) || (cleanUrlA && cleanUrlB && cleanUrlA === cleanUrlB)
    if (samePost && authA && authB && authA === authB) return true
  }

  // 5. So sánh nội dung cốt lõi & tác giả trong cùng một nhóm
  const coreA = normalizePostContentForDedup(getCoreContent(a.content))
  const coreB = normalizePostContentForDedup(getCoreContent(b.content))

  if (coreA.length >= 25 && coreB.length >= 25) {
    if (coreA === coreB) return true
    const minLen = Math.min(coreA.length, coreB.length)
    if (minLen >= 40) {
      const sliceLen = Math.min(minLen, 70)
      if (coreA.slice(0, sliceLen) === coreB.slice(0, sliceLen)) return true
    }
  }

  const normAuthorA = normalizeAuthorName(a.authorName)
  const normAuthorB = normalizeAuthorName(b.authorName)
  const isAnonA = !normAuthorA || /nguoithamgiaandanh|thanhviennhom|anonymous|thanhvienandanh/.test(normAuthorA)
  const isAnonB = !normAuthorB || /nguoithamgiaandanh|thanhviennhom|anonymous|thanhvienandanh/.test(normAuthorB)

  if (!isAnonA && !isAnonB && normAuthorA === normAuthorB) {
    if (coreA.length >= 20 && coreB.length >= 20 && coreA.slice(0, 25) === coreB.slice(0, 25)) {
      return true
    }
  }

  return false
}

export class StoreService {
  private store: Store<AppData>
  public activeIpv4Accounts = new Set<string>()
  private accountsListeners: Array<() => void> = []
  private blacklistListeners: Array<(url: string) => void> = []
  private postStatsListeners: Array<() => void> = []

  constructor() {
    this.store = new Store<AppData>({
      name: 'followfree-data',
      encryptionKey: 'followfree-local-encryption-key', // Mã hóa file lưu trữ
      schema: schema as any,
    })
  }

  getSession(): Session | null {
    const saved = ((this.store as any).get('session') as Session | null) ?? null
    if (saved && saved.user) return saved
    return {
      token: 'local-offline-token',
      user: {
        id: 'local_user',
        username: 'Admin',
        email: 'local@device',
        role: 'ADMIN',
        points: 999999,
        balance: 999999,
      },
    }
  }

  saveSession(session: Session): void {
    (this.store as any).set('session', session)
  }

  clearSession(): void {
    (this.store as any).delete('session')
  }

  getAutoPostConfig(): AutoPostConfig {
    return (this.store as any).get('autoPostConfig') as AutoPostConfig
  }

  updateAutoPostConfig(config: Partial<AutoPostConfig>): void {
    const current = this.getAutoPostConfig()
      ; (this.store as any).set('autoPostConfig', { ...current, ...config })
  }

  getSettings(): { runHeadless: boolean } {
    return (this.store as any).get('appSettings') ?? { runHeadless: false }
  }

  updateSettings(settings: { runHeadless: boolean }): void {
    (this.store as any).set('appSettings', settings)
  }

  getGroupBlacklist(): string[] {
    return (this.store as any).get('groupBlacklist') ?? [];
  }

  addToGroupBlacklist(urlOrId: string): void {
    const list = this.getGroupBlacklist();
    if (!list.includes(urlOrId)) {
      list.push(urlOrId);
      (this.store as any).set('groupBlacklist', list);
      for (const listener of this.blacklistListeners) {
        try { listener(urlOrId) } catch { }
      }
    }
  }

  onBlacklistAdded(listener: (url: string) => void): void {
    this.blacklistListeners.push(listener);
  }

  private static normalizeGroupKey(groupUrl: string): string {
    return groupUrl.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase()
  }

  private static currentDayKey(): string {
    return new Date().toLocaleDateString('en-CA')
  }

  private getGroupPostLog(): Record<string, number> {
    return (this.store as any).get('groupPostLog') ?? {}
  }

  /** True nếu nhóm vừa được đăng trong vòng `cooldownMs` gần nhất. */
  isGroupInCooldown(groupUrl: string, cooldownMs: number): boolean {
    const lastPostedAt = this.getGroupPostLog()[StoreService.normalizeGroupKey(groupUrl)]
    return lastPostedAt !== undefined && Date.now() - lastPostedAt < cooldownMs
  }

  /** Ghi nhận 1 bài đã đăng thành công vào nhóm; dọn các bản ghi đã quá hạn cooldown. */
  recordGroupPost(groupUrl: string, retentionMs: number): void {
    const now = Date.now()
    const log: Record<string, number> = {}
    for (const [key, postedAt] of Object.entries(this.getGroupPostLog())) {
      if (now - postedAt < retentionMs) log[key] = postedAt
    }
    log[StoreService.normalizeGroupKey(groupUrl)] = now
      ; (this.store as any).set('groupPostLog', log)

    const stored = this.readStoredPostStats()
      ; (this.store as any).set('postStats', {
        total: stored.total + 1,
        dayKey: StoreService.currentDayKey(),
        today: stored.today + 1,
      })
    for (const listener of this.postStatsListeners) {
      try { listener() } catch (err) { console.error('[Store] post stats listener failed:', err) }
    }
  }

  private readStoredPostStats(): StoredPostStats {
    const stored = (this.store as any).get('postStats') as StoredPostStats | undefined
    const dayKey = StoreService.currentDayKey()
    if (!stored) return { total: 0, dayKey, today: 0 }
    return stored.dayKey === dayKey ? stored : { total: stored.total, dayKey, today: 0 }
  }

  getPostStats(): PostStats {
    const { total, today } = this.readStoredPostStats()
    return { total, today }
  }

  onPostStatsChanged(listener: () => void): void {
    this.postStatsListeners.push(listener)
  }

  getAccounts(): SocialAccount[] {
    return ((this.store as any).get('accounts') as SocialAccount[]) ?? []
  }

  saveAccounts(accounts: SocialAccount[]): void {
    (this.store as any).set('accounts', accounts)
    this.notifyAccountsChanged()
  }

  /** Đăng ký callback được gọi mỗi khi danh sách nick thay đổi (dùng cho cloud sync). */
  onAccountsChanged(listener: () => void): void {
    this.accountsListeners.push(listener)
  }

  private notifyAccountsChanged(): void {
    for (const listener of this.accountsListeners) {
      try { listener() } catch (err) { console.error('[Store] accounts listener failed:', err) }
    }
  }

  updateAccountStatus(id: string, status: string): void {
    const accounts = this.getAccounts()
    const index = accounts.findIndex(a => a.id === id)
    if (index !== -1) {
      accounts[index].status = status
      if (status === 'RESTRICTED') {
        accounts[index].restrictedAt = Date.now()
        accounts[index].restrictCount = (accounts[index].restrictCount || 0) + 1
      } else if (status === 'ACTIVE') {
        delete accounts[index].restrictedAt
        delete accounts[index].restrictCount
      }
      this.saveAccounts(accounts)
    }
  }

  updateAccountCookie(id: string, cookieData: string): void {
    const accounts = this.getAccounts()
    const index = accounts.findIndex(a => a.id === id)
    if (index !== -1) {
      accounts[index].cookieData = cookieData
      this.saveAccounts(accounts)
    }
  }

  addAccounts(newAccounts: SocialAccount[]): void {
    const existing = this.getAccounts()
    const merged = [...existing]
    for (const acc of newAccounts) {
      if (!merged.find((a) => a.id === acc.id)) {
        merged.push(acc)
      }
    }
    (this.store as any).set('accounts', merged)
    this.notifyAccountsChanged()
  }



  updateWorkerStats(stats: Partial<AppData['workerStats']>): void {
    const current = (this.store as any).get('workerStats') as AppData['workerStats']
    (this.store as any).set('workerStats', { ...current, ...stats })
  }

  getWorkerStats(): AppData['workerStats'] {
    return ((this.store as any).get('workerStats') as AppData['workerStats']) ?? {
      tasksCompleted: 0,
      totalPointsEarned: 0,
      lastRunAt: null,
    }
  }

  getEmailConfig(): AppData['emailConfig'] {
    return ((this.store as any).get('emailConfig') as AppData['emailConfig']) ?? null
  }

  saveEmailConfig(config: AppData['emailConfig']): void {
    (this.store as any).set('emailConfig', config)
  }

  // Scanner methods
  getScannerConfig(): ScannerConfig {
    const defaults: ScannerConfig = {
      industryMode: 'RECRUITMENT',
      groups: [],
      keywords: [],
      intentKeywords: [],
      commentKeywords: [],
      excludeKeywords: [],
      autoFilterSpam: true,
      scanComments: true,
      maxPostAgeDays: 3,
      maxPostLength: 30,
      intervalMinutes: 1,
      isRunning: false,
    }
    return { ...defaults, ...((this.store as any).get('scannerConfig') ?? {}) }
  }

  updateScannerConfig(config: Partial<ScannerConfig>): void {
    const current = this.getScannerConfig();
    (this.store as any).set('scannerConfig', { ...current, ...config });
  }

  getLeads(): ScrapedLead[] {
    const rawLeads: ScrapedLead[] = (this.store as any).get('leads') ?? [];
    // Tự động khử trùng lặp dữ liệu (kể cả dữ liệu cũ đã lưu từ các phiên trước)
    const deduped: ScrapedLead[] = [];
    for (const lead of rawLeads) {
      if (!deduped.some(existing => isSameLead(existing, lead))) {
        deduped.push(lead);
      }
    }
    if (deduped.length !== rawLeads.length) {
      (this.store as any).set('leads', deduped);
    }
    return deduped;
  }

  addLead(lead: ScrapedLead): boolean {
    const leads = this.getLeads();
    const isDuplicate = leads.some(l => isSameLead(l, lead));
    if (isDuplicate) return false;
    leads.unshift(lead);
    if (leads.length > 1000) leads.pop();
    (this.store as any).set('leads', leads);
    return true;
  }

  updateLeadStatus(id: string, status: 'new' | 'read' | 'contacted'): void {
    const leads = this.getLeads();
    const index = leads.findIndex(l => l.id === id);
    if (index !== -1) {
      leads[index].status = status;
      (this.store as any).set('leads', leads);
    }
  }

  clearLeads(): void {
    (this.store as any).set('leads', []);
    (this.store as any).set('scannedPostIds', []);
  }

  getScannedPostIds(): string[] {
    return (this.store as any).get('scannedPostIds') ?? [];
  }

  addScannedPostIds(ids: string[]): void {
    if (!ids || ids.length === 0) return;
    const current = new Set(this.getScannedPostIds());
    ids.forEach(id => {
      if (id) current.add(id);
    });
    const arr = Array.from(current);
    if (arr.length > 5000) arr.splice(0, arr.length - 5000);
    (this.store as any).set('scannedPostIds', arr);
  }

  getAiConfig(): AiConfig {
    const defaults: AiConfig = {
      provider: 'gemini',
      apiKey: '',
      modelName: 'gemini-1.5-flash',
      systemPrompt: '',
      maxTokens: 200,
      jobList: [],
      jobsText: '',
      jobs: [],
      autoComment: false,
      commentDelaySeconds: 60,
      commentAccountSelection: 'first_active',
    }
    return { ...defaults, ...((this.store as any).get('aiConfig') ?? {}) }
  }

  updateAiConfig(config: Partial<AiConfig>): void {
    const current = this.getAiConfig();
    (this.store as any).set('aiConfig', { ...current, ...config });
  }

  // Quản lý danh sách các bài viết Threads đã từng phản hồi (Chống trùng lặp vĩnh viễn)
  getRepliedThreadPosts(): string[] {
    return (this.store as any).get('repliedThreadPosts') ?? []
  }

  addRepliedThreadPost(key: string): void {
    if (!key) return
    const list: string[] = this.getRepliedThreadPosts()
    if (!list.includes(key)) {
      list.push(key)
      if (list.length > 5000) list.shift()
      ;(this.store as any).set('repliedThreadPosts', list)
    }
  }
}
