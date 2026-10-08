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
  matchedKeywords: string[];
  timestamp: number;
  status: 'new' | 'read' | 'contacted';
}

export interface ScannerConfig {
  groups: string[];
  keywords: string[];
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
    return ((this.store as any).get('session') as Session | null) ?? null
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
    ;(this.store as any).set('autoPostConfig', { ...current, ...config })
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
        try { listener(urlOrId) } catch {}
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
    ;(this.store as any).set('groupPostLog', log)

    const stored = this.readStoredPostStats()
    ;(this.store as any).set('postStats', {
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
    return (this.store as any).get('scannerConfig') ?? { groups: [], keywords: [], intervalMinutes: 15, isRunning: false }
  }

  updateScannerConfig(config: Partial<ScannerConfig>): void {
    const current = this.getScannerConfig();
    (this.store as any).set('scannerConfig', { ...current, ...config });
  }

  getLeads(): ScrapedLead[] {
    return (this.store as any).get('leads') ?? [];
  }

  addLead(lead: ScrapedLead): boolean {
    const leads = this.getLeads();
    if (leads.some(l => l.id === lead.id)) return false;
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
  }
}
