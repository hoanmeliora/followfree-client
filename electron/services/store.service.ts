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
  }
}

export class StoreService {
  private store: Store<AppData>
  public activeIpv4Accounts = new Set<string>()
  private accountsListeners: Array<() => void> = []

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
    }
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
}
