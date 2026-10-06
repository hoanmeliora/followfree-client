import { io, Socket } from 'socket.io-client'
import { chromium, BrowserContext, Page } from 'playwright'
import { StoreService } from './store.service'
import { Ipv6Service } from './ipv6.service'
import { LocalProxyService } from './local-proxy.service'
import { AutomationService } from './automation.service'
import { SelfHealingService } from './self-healing.service'
import { TargetPreviewService } from './target-preview.service'
import { IPlatformExecutor } from './platforms/platform-executor.interface'
import { FacebookExecutor } from './platforms/facebook.executor'
import { TikTokExecutor } from './platforms/tiktok.executor'
import { NurturingService } from './nurturing/nurturing.service'



const SERVER_URL = process.env.SERVER_URL || 'https://followfree-server.onrender.com'
const HEARTBEAT_INTERVAL_MS = 30_000
const TASK_COOLDOWN_MS = 10 * 60_000

interface TaskPayload {
  id: string
  campaignId?: string
  doneAccountIds?: string[]
  campaign: {
    id?: string
    platform: string
    actionType: string
    targetUrl: string
  }
}

interface WorkerStatus {
  running: boolean
  connected: boolean
  tasksCompleted: number
  totalPointsEarned: number
  currentTask: string | null
  currentAccountName?: string
  accountCount: number
}

type PushEvent = (channel: string, data: any) => void

export class WorkerService {
  private socket: Socket | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private taskCooldownTimer: NodeJS.Timeout | null = null
  private running = false
  private currentTask: string | null = null
  private currentAccountName: string | undefined = undefined
  private taskQueue: TaskPayload[] = []
  private roundRobinIndex: Record<string, number> = {}
  private ipv6Available = false

  private readonly ipv6Service = new Ipv6Service()
  private readonly localProxyService = new LocalProxyService()
  private readonly automationService = new AutomationService()
  private readonly selfHealingService = new SelfHealingService(this.automationService)
  private readonly previewService = new TargetPreviewService()

  private readonly executorRegistry: Map<string, IPlatformExecutor> = new Map<string, IPlatformExecutor>([
    ['FACEBOOK', new FacebookExecutor(this.automationService, this.selfHealingService, this.store)],
    ['TIKTOK',   new TikTokExecutor(this.automationService, this.selfHealingService)],
  ])

  private readonly nurturingService: NurturingService

  constructor(
    private readonly store: StoreService,
    private readonly pushEvent: PushEvent,
  ) {
    this.nurturingService = new NurturingService(
      this.store,
      this.ipv6Service,
      this.localProxyService,
      this.executorRegistry,
      (channel, data) => this.pushEvent(channel, data),
      async (accountId, platform, proxyUrl) => {
         return await this.createBrowserContext(accountId, proxyUrl)
      }
    )
    
    this.store.onAccountsChanged(() => {
      this.reportCapacityUpdate()
    })

    this.store.onBlacklistAdded((url) => {
      if (this.socket?.connected) {
        this.socket.emit('report_blacklist', { url })
      }
    })
  }

  async start() {
    if (this.running) {
       // Báo server quét task ngay lập tức để không phải chờ cronjob 10 giây
       if (this.socket?.connected) {
          this.socket.emit('request_tasks_now')
       }
       return
    }
    this.running = true
    this.localProxyService.start(8888)

    const prefix = await this.ipv6Service.getBasePrefix()
    if (prefix) {
      this.ipv6Available = true
      console.log(`[Worker] ✅ IPv6 khả dụng, prefix: ${prefix}`)
    } else {
      this.ipv6Available = false
      console.warn('[Worker] ⚠️ Mạng không có IPv6 – Tính năng tự động sẽ bị hạn chế')
      this.pushEvent('worker:warning', {
        title: 'Mạng không hỗ trợ IPv6',
        message: 'Mạng Wifi hiện tại chưa bật IPv6. Tính năng cày tự động sẽ không chạy để bảo vệ tài khoản.\n\nVui lòng kết nối Wifi khác hoặc phát 4G từ điện thoại rồi bật lại Worker.',
      })
    }

    const session = this.store.getSession()
    if (!session?.token) return
    this.connect(session.token)
    this.pushEvent('worker:status', this.getStatus())
    
    // Đảm bảo có phản hồi ngay lập tức trên màn hình
    setTimeout(() => {
        this.processNextTask();
    }, 2000);
  }

  stop() {
    this.running = false
    this.socket?.disconnect()
    this.socket = null
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.taskCooldownTimer) clearTimeout(this.taskCooldownTimer)
    this.nurturingService.stopNurturing()
    this.currentTask = null
    this.localProxyService.stop()
    this.pushEvent('worker:status', this.getStatus())
  }

  getStatus(): WorkerStatus {
    const stats = this.store.getWorkerStats()
    const accounts = this.store.getAccounts()
    return {
      running: this.running,
      connected: this.socket?.connected ?? false,
      tasksCompleted: stats.tasksCompleted,
      totalPointsEarned: stats.totalPointsEarned,
      currentTask: this.currentTask,
      currentAccountName: this.currentAccountName,
      accountCount: accounts.length,
    }
  }

  async previewTarget(url: string, actionType: string): Promise<number | null> {
    const allAccounts = this.store.getAccounts().filter((a) => a.status === 'ACTIVE')
    const account = allAccounts.find((a) => a.isManual) || allAccounts[0] || null
    return this.previewService.previewTarget(url, actionType, account)
  }

  private connect(token: string) {
    this.socket = io(`${SERVER_URL}/worker`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 5000,
    })

    this.socket.on('connect', () => {
      console.log('✅ Connected to FollowFree Server')
      this.pushEvent('worker:connected', true)
      this.reportCapacityUpdate()
      // Yêu cầu task ngay lập tức khi vừa kết nối
      this.socket?.emit('request_tasks_now')
    })

    this.socket.on('disconnect', () => {
      console.log('📴 Disconnected from server')
      this.pushEvent('worker:connected', false)
    })

    this.socket.on('new_task', async (task: TaskPayload) => {
      this.taskQueue.push(task)
      if (this.nurturingService.isRunning()) {
         await this.nurturingService.stopNurturing()
         // Đợi Chromium nhả file lock hoàn toàn để tránh crash khi mở lại profile
         await new Promise(r => setTimeout(r, 3000))
      }
      this.processNextTask()
    })

    this.socket.on('sync_blacklist', (list: string[]) => {
      const current = this.store.getGroupBlacklist()
      const merged = Array.from(new Set([...current, ...list]))
      ;(this.store as any).store.set('groupBlacklist', merged)
      console.log(`[Worker] Đã đồng bộ Global Blacklist từ Server (${list.length} nhóm cấm)`)
    })

    this.socket.on('add_blacklist', (url: string) => {
      this.store.addToGroupBlacklist(url)
    })
  }

  reportCapacityUpdate() {
    if (!this.socket?.connected) return
    const accounts = this.store.getAccounts()
    const machineId = this.getMachineId()
    const accountIds = accounts.map(a => a.id)
    const supportedPlatforms = [...new Set(accounts.map((a) => a.platform))]

    this.socket.emit('worker_update', {
      machineId,
      platform: process.platform,
      accountCount: accounts.length,
      supportedPlatforms,
      accountIds,
      currentTask: this.currentTask,
      cpuUsage: 0,
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    })
    this.pushEvent('worker:status', this.getStatus())
  }

  private async processNextTask() {
    if (!this.running || this.currentTask) return
    if (this.taskQueue.length === 0) {
        this.nurturingService.performIdleNurturing().catch(e => console.error(e))
        return
    }
    const task = this.taskQueue.shift()!

    // FIX #1: Nếu không có IPv6 VÀ không có proxy → giới hạn 3 tài khoản luân phiên
    if (!this.ipv6Available) {
      console.warn('[Worker] 🚨 Mạng không có IPv6 - Bật chế độ giới hạn 3 tài khoản luân phiên')
    }

    const executor = this.executorRegistry.get(task.campaign.platform)
    if (!executor) {
      this.reportTaskResult(task.id, '', false, `Unsupported platform: ${task.campaign.platform}`)
      this.finishTask()
      return
    }

    this.currentTask = task.id
    this.currentAccountName = undefined
    this.pushEvent('worker:status', this.getStatus())
    console.log(`▶️ Executing task ${task.id}: ${task.campaign.actionType}`)

    try {
      const accounts = this.store.getAccounts()
      const doneIds = new Set(task.doneAccountIds || [])
      let matchingAccounts = accounts.filter(
        (a) => (a.platform || '').toUpperCase() === (task.campaign.platform || '').toUpperCase() && a.status === 'ACTIVE' && !doneIds.has(a.id),
      )

      if (!this.ipv6Available) {
        matchingAccounts = matchingAccounts.filter((a) => {
          if (this.store.activeIpv4Accounts.has(a.id)) return true
          if (this.store.activeIpv4Accounts.size < 3) {
            this.store.activeIpv4Accounts.add(a.id)
            return true
          }
          return false
        })
      }

      if (matchingAccounts.length === 0) {
        console.log(`[Worker] 🚨 Task ${task.id} bị từ chối do không có tài khoản phù hợp!`);
        console.log(`[Worker] Danh sách tài khoản hiện có:`, accounts.map((a: any) => ({ platform: a.platform, status: a.status })));
        console.log(`[Worker] Yêu cầu của task: platform=${task.campaign.platform}, doneIds=`, Array.from(doneIds));
        
        this.reportTaskResult(task.id, '', false, 'All accounts already participated in this campaign')
        this.finishTask()
        return
      }

      const platform = task.campaign.platform
      if (this.roundRobinIndex[platform] === undefined) {
        this.roundRobinIndex[platform] = 0
      }
      const index = this.roundRobinIndex[platform] % matchingAccounts.length
      const account = matchingAccounts[index]
      this.roundRobinIndex[platform]++

      this.currentAccountName = account.username
      this.pushEvent('worker:status', this.getStatus())

      const result = await this.executeWithPlaywright(task, account, executor)
      
      if (result === 'ALREADY_DONE') {
         this.reportTaskResult(task.id, account.id, false, 'ALREADY_DONE')
      } else {
         const success = result === true;
         this.reportTaskResult(task.id, account.id, success)
         if (success) {
           const stats = this.store.getWorkerStats()
           this.store.updateWorkerStats({
             tasksCompleted: stats.tasksCompleted + 1,
             totalPointsEarned: stats.totalPointsEarned + 1,
             lastRunAt: new Date().toISOString(),
           })
           this.pushEvent('worker:task_completed', { taskId: task.id, accountName: account.username })
         }
      }
    } catch (err: any) {
      console.error('Task execution error:', err)
      this.reportTaskResult(task.id, '', false, err.message)
    } finally {
      this.finishTask()
    }
  }

  private finishTask() {
    this.currentTask = null
    this.currentAccountName = undefined
    this.pushEvent('worker:status', this.getStatus())
    if (this.taskQueue.length > 0) {
      this.taskCooldownTimer = setTimeout(() => this.processNextTask(), TASK_COOLDOWN_MS)
    } else {
      this.nurturingService.performIdleNurturing().catch(e => console.error(e))
    }
  }

  private async createBrowserContext(accountId: string, proxyUrl?: string): Promise<{ context: BrowserContext, page: Page }> {
    const { FingerprintGenerator } = require('fingerprint-generator');
    const { app } = require('electron');
    const path = require('path');
    const fs = require('fs');
    
    const profilePath = path.join(app.getPath('userData'), 'profiles', accountId);
    
    // FIX #4: Đảm bảo thư mục profile tồn tại trước khi Playwright dùng (Windows cần mkdir explicit)
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    } else {
      // Xoá lock file nếu trình duyệt trước đó crash, tránh lỗi treo about:blank
      const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
      for (const lf of lockFiles) {
        const lfPath = path.join(profilePath, lf);
        if (fs.existsSync(lfPath)) {
           try { fs.unlinkSync(lfPath); } catch {}
        }
      }
    }

    const fingerprintGenerator = new FingerprintGenerator({
        browsers: [{ name: 'chrome', minVersion: 110 }],
        devices: ['desktop'],
        operatingSystems: ['windows', 'macos'],
    });
    const fingerprint = fingerprintGenerator.getFingerprint();
    
    const settings = this.store.getSettings();
    const isHeadless = settings?.runHeadless ?? false;

    // FIX #3: headless phải nằm trực tiếp trong options của launchPersistentContext
    const contextOptions: any = {
       headless: isHeadless,
       colorScheme: 'dark',
       viewport: { width: 1280, height: 800 },
       userAgent: (() => {
           const accUserAgent = accountId ? this.store.getAccounts().find(a => a.id === accountId)?.userAgent : null;
           if (accUserAgent && !accUserAgent.includes('Mobile') && !accUserAgent.includes('Android') && !accUserAgent.includes('iPhone')) {
               return accUserAgent;
           }
           return fingerprint.fingerprint.navigator.userAgent;
       })(),
       executablePath: (() => {
           const fs = require('fs');
           if (process.platform === 'win32') {
               const paths = [
                   'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                   'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                   'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
               ];
               for (const p of paths) if (fs.existsSync(p)) return p;
           } else if (process.platform === 'darwin') {
               const paths = [
                   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                   '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
               ];
               for (const p of paths) if (fs.existsSync(p)) return p;
           }
           return undefined;
       })(),
       args: [
         '--disable-gpu',
         '--no-sandbox',
         '--disable-setuid-sandbox',
         '--disable-dev-shm-usage',
         '--disable-web-security',
         '--disk-cache-size=15000000' // Giới hạn Cache 15MB để chống phình to ổ cứng
       ]
    }

    // TẠM THỜI TẮT PROXY ĐỂ TEST XEM CÓ PHẢI DO PROXY GÂY TREO KHÔNG
    proxyUrl = undefined;
    
    if (proxyUrl) {
       contextOptions.proxy = { server: proxyUrl }
    }

    console.log('[Worker] Đang mở trình duyệt qua Playwright với options:', { ...contextOptions, proxy: proxyUrl });
    
    // Dùng Môi trường cứng (Persistent Context) để lưu Cache, LocalStorage chống Checkpoint
    const context = await chromium.launchPersistentContext(profilePath, contextOptions);
    console.log('[Worker] Đã mở trình duyệt thành công!');
    
    // Bỏ qua FingerprintInjector vì nó gây treo (hang) với playwright-extra stealth,
    // stealth plugin đã lo việc evasion, ta chỉ cần userAgent từ FingerprintGenerator.

    // Lấy trang đầu tiên có sẵn trong context
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    
    return { context, page }
  }

  private async executeWithPlaywright(
    task: TaskPayload,
    account: any,
    executor: IPlatformExecutor,
  ): Promise<boolean | string> {
    let bound = false
    try {
      if (this.ipv6Available) {
        const fixedIp = this.ipv6Service.generateFixedIpv6ForAccount(account.id)
        if (fixedIp) {
          bound = await this.ipv6Service.bindIpToSystem(fixedIp)
          if (bound) {
            this.localProxyService.setBindIp(fixedIp)
            await new Promise(r => setTimeout(r, 3000))
          } else {
            this.localProxyService.setBindIp(null)
          }
        }
      } else {
        this.localProxyService.setBindIp(null)
      }
    } catch (e: any) {
      this.localProxyService.setBindIp(null)
    }

    const proxyUrl = bound ? 'http://127.0.0.1:8888' : undefined
    const { context, page } = await this.createBrowserContext(account.id, proxyUrl)

    try {
      const existingCookies = await context.cookies();
      const hasSession = existingCookies.some(c => c.name === 'c_user' || c.name === 'sessionid');

      if (!hasSession && account.cookieData) {
        let parsedCookies: any[] = []
        try {
           parsedCookies = JSON.parse(account.cookieData)
           // Xử lý lỗi sameSite của Playwright (chỉ chấp nhận Strict, Lax, None)
           parsedCookies = parsedCookies.map(cookie => {
              if (cookie.sameSite) {
                 const sameSiteLower = cookie.sameSite.toLowerCase()
                 if (['strict', 'lax', 'none'].includes(sameSiteLower)) {
                    cookie.sameSite = cookie.sameSite.charAt(0).toUpperCase() + cookie.sameSite.slice(1).toLowerCase()
                 } else {
                    delete cookie.sameSite
                 }
              }
              return cookie
           })
        } catch {
           const domain = task.campaign.platform === 'TIKTOK' ? '.tiktok.com' : '.facebook.com'
           parsedCookies = account.cookieData.split(';').map((pair: string) => {
              const [name, ...rest] = pair.trim().split('=')
              return { name, value: rest.join('='), domain, path: '/' }
           })
        }
        await context.addCookies(parsedCookies)
      }

      // Với SHARE_GROUP và POST_GROUP, không nên vào targetUrl trước vì kịch bản sẽ tự xử lý.
      // Thay vào đó, vào trang chủ Facebook để check login.
      const initialUrl = (task.campaign.actionType === 'SHARE_GROUP' || task.campaign.actionType === 'POST_GROUP') 
        ? 'https://www.facebook.com' 
        : task.campaign.targetUrl;
      console.log(`[Worker] Đang điều hướng đến: ${initialUrl}...`)
      try {
        await page.goto(initialUrl, { timeout: 30000 });
        console.log(`[Worker] Điều hướng thành công!`)
      } catch (err: any) {
        console.error(`[Worker] Lỗi điều hướng (Có thể do proxy hoặc mạng yếu):`, err.message)
        throw err;
      }
      await page.waitForTimeout(4000)

      const isLoginScreen = await page.evaluate(() => {
         return !!document.querySelector('input[name="email"], input[name="pass"]') || window.location.href.includes('login')
      }).catch(() => false)

      if (isLoginScreen) {
        console.error('❌ Session cookie hết hạn! Cập nhật status → CHECKPOINT')
        this.store.updateAccountStatus(account.id, 'CHECKPOINT')
        return false
      }

      try {
        const cookies = await context.cookies()
        if (cookies.length > 0) {
           this.store.updateAccountCookie(account.id, JSON.stringify(cookies))
        }
      } catch {}

      const result = await executor.performAction(page, task, account)
      await page.waitForTimeout(5000)

      return result
    } finally {
      // FIX #2: Với launchPersistentContext, context IS the browser → phải dùng context.close()
      // context.browser()?.close() sẽ trả về null và browser không bao giờ đóng gây memory leak
      await context.close().catch(() => {})
    }
  }

  private reportTaskResult(taskId: string, accountId: string, success: boolean, errorMessage?: string) {
    this.socket?.emit('task_result', { taskId, accountId, success, errorMessage })
  }

  private getMachineId(): string {
    const os = require('os')
    const crypto = require('crypto')
    const raw = `${os.hostname()}-${os.platform()}-${os.arch()}`
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
  }
}
