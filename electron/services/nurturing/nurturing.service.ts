import { BrowserContext, Page } from 'playwright'
import { StoreService } from '../store.service'
import { Ipv6Service } from '../ipv6.service'
import { LocalProxyService } from '../local-proxy.service'
import { IPlatformExecutor } from '../platforms/platform-executor.interface'

export class NurturingService {
  private lastNurtured: Record<string, number> = {} // accountId -> timestamp
  private isNurturing = false
  private currentBrowserContext: BrowserContext | null = null
  private currentPage: Page | null = null

  // Khoảng thời gian giữa 2 lần nuôi (12 tiếng)
  private readonly NURTURE_COOLDOWN_MS = 12 * 60 * 60 * 1000 

  constructor(
    private readonly store: StoreService,
    private readonly ipv6Service: Ipv6Service,
    private readonly localProxyService: LocalProxyService,
    private readonly executorRegistry: Map<string, IPlatformExecutor>,
    private readonly pushEvent: (channel: string, data: any) => void,
    private readonly createBrowserContext: (accountId: string, platform: string, proxyUrl?: string) => Promise<{ context: BrowserContext; page: Page }>
  ) {}

  public isRunning(): boolean {
    return this.isNurturing
  }

  public async stopNurturing() {
    this.isNurturing = false
    if (this.currentBrowserContext) {
      try {
        await this.currentBrowserContext.close()
      } catch (e) {}
      this.currentBrowserContext = null
      this.currentPage = null
    }
  }

  public async performIdleNurturing(): Promise<boolean> {
    if (this.isNurturing) return false

    const activeAccounts = this.store.getAccounts().filter(a => a.status === 'ACTIVE')
    if (activeAccounts.length === 0) return false

    const now = Date.now()
    const accountToNurture = activeAccounts.find(acc => {
      const last = this.lastNurtured[acc.id] || 0
      return (now - last) > this.NURTURE_COOLDOWN_MS
    })

    if (!accountToNurture) return false 

    this.isNurturing = true
    this.pushEvent('worker:log', { message: `[Nurturing] Đang nuôi tài khoản: ${accountToNurture.username}` })
    
    try {
      const fixedIp = this.ipv6Service.generateFixedIpv6ForAccount(accountToNurture.id)
      const bound = await this.ipv6Service.bindIpToSystem(fixedIp)
      
      const proxyUrl = bound ? 'http://127.0.0.1:8888' : undefined
      if (bound) {
        this.localProxyService.setBindIp(fixedIp)
      } else {
        this.localProxyService.setBindIp(null)
      }

      const { context, page } = await this.createBrowserContext(accountToNurture.id, accountToNurture.platform, proxyUrl)
      this.currentBrowserContext = context
      this.currentPage = page

      const executor = this.executorRegistry.get(accountToNurture.platform)
      if (!executor) {
        throw new Error(`Không tìm thấy executor cho platform ${accountToNurture.platform}`)
      }

      const success = await executor.performNurturing(this.currentPage)
      
      if (success && this.isNurturing) {
         this.pushEvent('worker:log', { message: `[Nurturing] ✅ Nuôi thành công: ${accountToNurture.username}` })
      } else {
         this.pushEvent('worker:log', { message: `[Nurturing] ⚠️ Nuôi thất bại/gián đoạn: ${accountToNurture.username}` })
      }

      if (this.isNurturing && this.currentBrowserContext) {
        const newCookies = await this.currentBrowserContext.cookies()
        if (newCookies.length > 0) {
           this.store.updateAccountCookie(accountToNurture.id, JSON.stringify(newCookies))
        }
      }

    } catch (err) {
      console.error('[Nurturing] Error:', err)
    } finally {
      this.lastNurtured[accountToNurture.id] = Date.now() 
      if (this.currentBrowserContext) {
        try { await this.currentBrowserContext.close() } catch (e) {}
      }
      this.currentBrowserContext = null
      this.currentPage = null
      this.isNurturing = false
    }

    return true
  }
}
