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
    // ĐÃ TẮT HOÀN TOÀN: Không tự động nuôi nick khi rảnh để tránh làm phiền người dùng
    return false
  }
}
