import { BrowserContext, Page } from 'playwright'
import { createHash } from 'crypto'
import { StoreService, ScannerConfig, ScrapedLead } from '../store.service'
import { Ipv6Service } from '../ipv6.service'
import { LocalProxyService } from '../local-proxy.service'

type PushEvent = (channel: string, data: unknown) => void
type ScannerAccount = ReturnType<StoreService['getAccounts']>[number]
type CreateContext = (account: ScannerAccount, proxyUrl?: string) => Promise<{ context: BrowserContext; page: Page }>

interface RawPost {
  authorName: string
  authorUrl: string
  content: string
  postUrl: string
  postTimeText?: string
}

export function parsePostAgeDays(timeStr?: string, referenceDate: Date = new Date()): number | null {
  if (!timeStr) return null
  const s = timeStr.trim().toLowerCase()

  // Vừa xong / Just now / Vừa đăng
  if (/vừa xong|vừa đăng|just now/i.test(s)) return 0

  // Phút / minutes: "15 phút", "15m", "15 mins", "15min"
  if (/(\d+)\s*(?:phút|phut|p|m|min|mins)(?:\s+trước|[^\w\u00C0-\u1EF9]|$)/i.test(s)) return 0

  // Giờ / hours: "2 giờ", "2h", "2 hrs", "2 hr"
  if (/(\d+)\s*(?:giờ|gio|tiếng|tieng|h|hr|hrs)(?:\s+trước|[^\w\u00C0-\u1EF9]|$)/i.test(s)) return 0

  // Hôm qua / Yesterday
  if (/hôm qua|yesterday/i.test(s)) return 1

  // Ngày / days: "2 ngày", "2d", "2 days", "2 ngày trước"
  const dayMatch = s.match(/(\d+)\s*(?:ngày|ngay|d|day|days)(?:\s+trước|[^\w\u00C0-\u1EF9]|$)/i)
  if (dayMatch) return parseInt(dayMatch[1], 10)

  // Tuần / weeks: "1 tuần", "1w", "1 week", "2 tuần"
  const weekMatch = s.match(/(\d+)\s*(?:tuần|tuan|w|week|weeks)(?:\s+trước|[^\w\u00C0-\u1EF9]|$)/i)
  if (weekMatch) return parseInt(weekMatch[1], 10) * 7

  // Tháng / months: "1 tháng", "1 month"
  const monthMatch = s.match(/(\d+)\s*(?:tháng|thang|month|months)\s*(?:trước|ago)?$/i)
  if (monthMatch) return parseInt(monthMatch[1], 10) * 30

  // Ngày tháng cụ thể: "24 Tháng 10 lúc 14:00" hoặc "24 tháng 10" hoặc "24 thg 10"
  const vnDateMatch = s.match(/(\d{1,2})\s+(?:tháng|thg)\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?/i)
  if (vnDateMatch) {
    const day = parseInt(vnDateMatch[1], 10)
    const month = parseInt(vnDateMatch[2], 10) - 1
    const year = vnDateMatch[3] ? parseInt(vnDateMatch[3], 10) : referenceDate.getFullYear()
    const postDate = new Date(year, month, day)
    const diffMs = referenceDate.getTime() - postDate.getTime()
    return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)))
  }

  return null
}

const MIN_INTERVAL_MINUTES = 5
const MAX_GROUPS = 50
const TARGET_POSTS_PER_GROUP = 150
const MAX_SCROLL_ROUNDS = 30
const STALLED_ROUNDS_LIMIT = 2
const BUSY_RETRY_MS = 60 * 1000
const GROUP_URL_PATTERN = /^https:\/\/(www|m|web)\.facebook\.com\/groups\/[\w.-]+/i
const NUMERIC_OR_SLUG_PATTERN = /^[\w.-]+$/

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const randomBetween = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min))

/** Lowercase and strip Vietnamese diacritics so "tìm việc" matches "tim viec". */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
}

export const DEFAULT_BUYER_INTENT_KEYWORDS: string[] = [
  'cần mua', 'tìm mua', 'cần tìm', 'tìm', 'mua', 'xin giá', 'báo giá',
  'ai có', 'ai bán', 'bác nào có', 'bác nào bán', 'em cần', 'mình cần',
  'pass lại', 'tư vấn giúp', 'cho em hỏi', 'còn không', 'inbox mình',
  'ib mình', 'giá sao', 'bao nhiêu ạ', 'hỏi mua', 'muốn mua', 'cần thuê', 'tìm phòng', 'tìm xe'
]

export const DEFAULT_EXCLUDE_KEYWORDS: string[] = [
  'xả kho', 'sẵn hàng', 'tuyển sỉ', 'tuyển ctv', 'tuyển cộng tác viên',
  'bảng giá', 'free ship', 'freeship', 'ship cod', 'bảo hành', 'chính sách',
  'combo', 'new seal', 'tài xỉu', 'cờ bạc', 'vay vốn', 'việc làm thêm',
  'hoa hồng', 'kiếm tiền online', 'kiếm tiền tại nhà', 'tuyển dụng'
]

export const SPAM_SELLER_PATTERNS = [
  /(?:hotline|zalo|sđt|sdt|liên hệ|lh)\s*[:.-]?\s*(?:0|\+84)\d{8,10}/i,
  /(?:stk|số tài khoản|ngân hàng|mb bank|vietcombank|techcombank|vietinbank)\s*[:.-]?\s*\d{6,15}/i,
  /(?:địa chỉ shop|địa chỉ kho|showroom|store)\s*[:.-]/i,
  /(?:shopee\.vn|lazada\.vn|tiktok\.com|tiki\.vn)\/[\w./?=&#%-]+/i,
  /#(?:sale|xakho|hangchinhhang|giare|order|shipcod)\b/i,
]

export interface EvaluationResult {
  matched: boolean
  matchedKeywords: string[]
  rejectReason?: string
}

export function evaluatePostMatch(
  content: string,
  config: Pick<ScannerConfig, 'keywords' | 'intentKeywords' | 'excludeKeywords' | 'autoFilterSpam'>
): EvaluationResult {
  const normContent = normalizeText(content)
  if (!normContent) return { matched: false, matchedKeywords: [] }

  // 1. Kiểm tra từ khóa LOẠI TRỪ (Exclude / Blacklist)
  const excludeList = config.excludeKeywords ?? []
  for (const exKw of excludeList) {
    const normEx = normalizeText(exKw.trim())
    if (normEx.length > 0 && normContent.includes(normEx)) {
      return {
        matched: false,
        matchedKeywords: [],
        rejectReason: `Trúng từ khóa loại trừ: "${exKw}"`,
      }
    }
  }

  // 2. Kiểm tra bộ nhận diện bài viết bán hàng của Shop (Seller Heuristics)
  if (config.autoFilterSpam !== false) {
    for (const pattern of SPAM_SELLER_PATTERNS) {
      if (pattern.test(content)) {
        return {
          matched: false,
          matchedKeywords: [],
          rejectReason: 'Phát hiện bài bán hàng/quảng cáo của shop (Hotline/STK/Link sàn TMĐT)',
        }
      }
    }
  }

  // 3. Kiểm tra từ khóa quét bài viết (Keywords)
  const targetMatched = findMatchedKeywords(content, config.keywords)
  if (targetMatched.length === 0) {
    return { matched: false, matchedKeywords: [] }
  }

  return {
    matched: true,
    matchedKeywords: targetMatched,
  }
}

export function findMatchedKeywords(content: string, keywords: string[]): string[] {
  const haystack = normalizeText(content)
  return keywords.filter((keyword) => {
    const needle = normalizeText(keyword.trim())
    return needle.length > 0 && haystack.includes(needle)
  })
}

/** Accepts a full group URL, a group slug or a numeric id, returns a canonical group URL or null. */
export function normalizeGroupInput(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  if (GROUP_URL_PATTERN.test(value)) {
    const match = value.match(/groups\/([\w.-]+)/i)
    return match ? `https://www.facebook.com/groups/${match[1]}` : null
  }
  if (NUMERIC_OR_SLUG_PATTERN.test(value)) return `https://www.facebook.com/groups/${value}`
  // Nếu không phải là URL hay ID, thì nó là một từ khóa (keyword). Trả về nguyên gốc.
  return value
}

const RESERVED_PROFILE_PATHS = new Set(['groups', 'messages', 'pages', 'watch', 'marketplace', 'login', 'profile.php'])
const MAX_LEADS_PER_DIGEST = 10

/**
 * Accepts a profile link, messenger link, username or numeric id.
 * Returns the canonical Messenger thread URL, or null when the input is not a valid target.
 */
export function normalizeRecipientInput(input: string): string | null {
  const value = input.trim()
  if (!value) return null

  if (/^https?:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (!/(^|\.)(facebook|messenger)\.com$/i.test(url.hostname)) return null

    const threadMatch = url.pathname.match(/\/(?:messages\/)?t\/([\w.-]+)/i)
    if (threadMatch) return `https://www.facebook.com/messages/t/${threadMatch[1]}`

    const profileId = url.pathname === '/profile.php' ? url.searchParams.get('id') : null
    if (profileId && /^\d+$/.test(profileId)) return `https://www.facebook.com/messages/t/${profileId}`

    const username = url.pathname.split('/').filter(Boolean)[0]
    if (username && !RESERVED_PROFILE_PATHS.has(username) && NUMERIC_OR_SLUG_PATTERN.test(username)) {
      return `https://www.facebook.com/messages/t/${username}`
    }
    return null
  }

  return NUMERIC_OR_SLUG_PATTERN.test(value) ? `https://www.facebook.com/messages/t/${value}` : null
}

export class ScannerService {
  private timer: NodeJS.Timeout | null = null
  private cycleInProgress = false
  private accountRotation = 0
  private quickScanGroupIndex = 0 // Xoay vòng nhóm khi quét luân phiên
  private currentContext: BrowserContext | null = null

  constructor(
    private readonly store: StoreService,
    private readonly ipv6Service: Ipv6Service,
    private readonly localProxyService: LocalProxyService,
    private readonly createContext: CreateContext,
    private readonly isWorkerBusy: () => boolean,
    private readonly pushEvent: PushEvent,
  ) { }

  getConfig(): ScannerConfig {
    return this.store.getScannerConfig()
  }

  /** Validates and persists config. Returns error message when invalid. */
  saveConfig(input: {
    groups: string[]
    keywords: string[]
    intentKeywords?: string[]
    commentKeywords?: string[]
    excludeKeywords?: string[]
    autoFilterSpam?: boolean
    scanComments?: boolean
    maxPostAgeDays?: number
    intervalMinutes: number
    notifyRecipient?: string
  }): { success: boolean; error?: string } {
    const groups = Array.from(
      new Set(input.groups.map(normalizeGroupInput).filter((g): g is string => g !== null)),
    )
    const keywords = Array.from(new Set(input.keywords.map((k) => k.trim()).filter((k) => k.length > 0)))
    const intentKeywords = Array.from(new Set((input.intentKeywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0)))
    const commentKeywords = Array.from(new Set((input.commentKeywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0)))
    const excludeKeywords = Array.from(new Set((input.excludeKeywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0)))

    if (groups.length === 0) return { success: false, error: 'Cần ít nhất 1 nhóm hợp lệ' }
    if (groups.length > MAX_GROUPS) return { success: false, error: `Tối đa ${MAX_GROUPS} nhóm` }
    if (keywords.length === 0) return { success: false, error: 'Cần ít nhất 1 từ khóa tìm kiếm' }

    const rawRecipient = (input.notifyRecipient ?? '').trim()
    const notifyRecipient = rawRecipient ? normalizeRecipientInput(rawRecipient) : ''
    if (rawRecipient && !notifyRecipient) {
      return { success: false, error: 'Người nhận thông báo không hợp lệ (dán link trang cá nhân Facebook, username hoặc ID)' }
    }

    const intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(input.intervalMinutes) || 15))
    const maxPostAgeDays = Math.max(1, Math.min(30, Math.floor(Number(input.maxPostAgeDays) || 3)))
    this.store.updateScannerConfig({
      groups,
      keywords,
      intentKeywords,
      commentKeywords,
      excludeKeywords,
      autoFilterSpam: input.autoFilterSpam ?? true,
      scanComments: input.scanComments ?? false,
      maxPostAgeDays,
      intervalMinutes,
      notifyRecipient: notifyRecipient || undefined,
    })
    return { success: true }
  }

  isRunning(): boolean {
    return this.store.getScannerConfig().isRunning
  }

  start(): { success: boolean; error?: string } {
    const config = this.store.getScannerConfig()
    if (config.groups.length === 0 || config.keywords.length === 0) {
      return { success: false, error: 'Hãy lưu danh sách nhóm và từ khóa trước' }
    }
    this.store.updateScannerConfig({ isRunning: true })
    this.log('▶️ Bắt đầu săn khách')
    this.scheduleNext(0)
    this.emitStatus()
    return { success: true }
  }

  async stop(): Promise<void> {
    this.store.updateScannerConfig({ isRunning: false })
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.currentContext) {
      try {
        await this.currentContext.close()
      } catch (err) {
        console.warn('[Scanner] Failed to close context:', (err as Error).message)
      }
      this.currentContext = null
    }
    this.log('⏹ Đã dừng săn khách')
    this.emitStatus()
  }

  /** Called on app boot to resume a scan the user left running. */
  resumeIfNeeded(): void {
    if (this.isRunning()) this.scheduleNext(30 * 1000)
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.isRunning()) return
    this.timer = setTimeout(() => {
      this.runCycle().catch((err) => console.error('[Scanner] Cycle crashed:', err))
    }, delayMs)
  }

  private async runCycle(): Promise<void> {
    if (!this.isRunning()) return
    const intervalMs = this.store.getScannerConfig().intervalMinutes * 60 * 1000

    if (this.cycleInProgress || this.isWorkerBusy()) {
      this.scheduleNext(BUSY_RETRY_MS)
      return
    }

    this.cycleInProgress = true
    this.emitStatus()
    try {
      await this.scanAllGroups()
    } catch (err) {
      this.log(`❌ Lỗi khi quét: ${(err as Error).message}`)
    } finally {
      this.cycleInProgress = false
      this.currentContext = null
      this.emitStatus()
      this.scheduleNext(intervalMs)
    }
  }

  private pickAccount() {
    const accounts = this.store
      .getAccounts()
      .filter((a) => (a.platform || '').toUpperCase() === 'FACEBOOK' && a.status === 'ACTIVE')
    if (accounts.length === 0) return null
    return accounts[this.accountRotation++ % accounts.length]
  }

  private async scanAllGroups(): Promise<void> {
    const config = this.store.getScannerConfig()
    const account = this.pickAccount()
    if (!account) {
      this.log('⚠️ Không có tài khoản Facebook ACTIVE để quét')
      return
    }

    this.log(`🔍 Bắt đầu lượt quét ${config.groups.length} nhóm bằng tài khoản ${account.username}`)

    let proxyUrl: string | undefined
    if (this.ipv6Service.isAvailable) {
      const fixedIp = this.ipv6Service.generateFixedIpv6ForAccount(account.id)
      const bound = await this.ipv6Service.bindIpToSystem(fixedIp)
      if (bound) {
        this.localProxyService.start(8888)
        this.localProxyService.setBindIp(fixedIp)
        proxyUrl = 'http://127.0.0.1:8888'
      }
    }

    const { context, page: initialPage } = await this.createContext(account, proxyUrl)
    let page = initialPage
    this.currentContext = context
    let browserClosedExternally = false
    let stoppedByUs = false
    context.on('close', () => {
      if (!stoppedByUs) browserClosedExternally = true
    })

    // Bật chế độ tiết kiệm RAM: chặn video/reels tự tải ngầm
    await this.enableMemorySaver(page)

    let newLeads = 0
    const cycleLeads: ScrapedLead[] = []
    let totalPostsRead = 0
    let groupsScanned = 0

    try {
      // 1. KIỂM TRA VÀ CHUYỂN NGAY VỀ TÀI KHOẢN CÁ NHÂN NẾU ĐANG KẸT Ở FANPAGE
      await this.ensurePersonalProfile(page)

      // Biến đổi danh sách đầu vào (chứa cả URL và Từ khóa) thành danh sách URL nhóm thuần
      const targetGroupUrls = new Set<string>()
      for (const input of config.groups) {
        if (!this.isRunning()) break
        if (input.includes('facebook.com/groups/')) {
          targetGroupUrls.add(input)
          continue
        }

        // Nếu là từ khoá, tiến hành tìm kiếm nhóm
        this.log(`🔍 Tìm kiếm các nhóm cho từ khoá: "${input}"...`)
        try {
          await page.goto(`https://www.facebook.com/groups/search/groups/?q=${encodeURIComponent(input)}`, { waitUntil: 'domcontentloaded' })
          await sleep(3000)

          let foundCount = 0
          for (let i = 0; i < 5; i++) { // Scroll 5 lần để kiếm cỡ 10-20 nhóm là đẹp
            const urls = await page.evaluate(() => {
              const resultUrls: string[] = []
              const groupPattern = /https:\/\/(?:www|m|web)\.facebook\.com\/groups\/([a-zA-Z0-9._-]+)/i

              // 1. Tìm toàn bộ các thẻ <a>
              const allLinks = Array.from(document.querySelectorAll('a[href]'))
              for (const a of allLinks) {
                const href = a.getAttribute('href') || ''
                const match = href.match(groupPattern)
                if (match) {
                  const slug = match[1]
                  if (slug && !['search', 'discover', 'feed', 'joins', 'create'].includes(slug.toLowerCase())) {
                    resultUrls.push(`https://www.facebook.com/groups/${slug}`)
                  }
                }
              }

              // 2. Tìm trong role="link" hoặc các thẻ div chứa thuộc tính data
              const clickableNodes = Array.from(document.querySelectorAll('[role="link"], [data-headline], div[aria-label]'))
              for (const node of clickableNodes) {
                const href = (node as any).href || node.getAttribute('href') || ''
                const match = href.match(groupPattern)
                if (match) {
                  const slug = match[1]
                  if (slug && !['search', 'discover', 'feed', 'joins', 'create'].includes(slug.toLowerCase())) {
                    resultUrls.push(`https://www.facebook.com/groups/${slug}`)
                  }
                }
              }

              return Array.from(new Set(resultUrls))
            })

            for (const url of urls) {
              if (!targetGroupUrls.has(url)) {
                targetGroupUrls.add(url)
                foundCount++
              }
            }
            if (foundCount >= 15) break // Lấy tối đa 15 nhóm tốt nhất mỗi từ khóa
            await page.evaluate(() => window.scrollBy(0, 1500))
            await sleep(2000)
          }
          this.log(`✅ Đã tìm thấy ${foundCount} nhóm cho từ khóa "${input}"`)
        } catch (err) {
          this.log(`⚠️ Lỗi khi tìm nhóm cho từ khóa "${input}": ${(err as Error).message}`)
        }
      }

      const finalGroupList = Array.from(targetGroupUrls)
      this.log(`🚀 Bắt đầu quét tổng cộng ${finalGroupList.length} nhóm...`)

      for (const groupUrl of finalGroupList) {
        if (!this.isRunning()) break
        if (browserClosedExternally) {
          this.log('⚠️ Trình duyệt bị đóng giữa chừng, kết thúc lượt quét sớm')
          break
        }

        // Dọn dẹp DOM & giải phóng RAM định kỳ sau mỗi 2 nhóm
        if (groupsScanned > 0 && groupsScanned % 2 === 0) {
          this.log(`🧹 Đang thu hồi bộ nhớ RAM (${groupsScanned}/${finalGroupList.length} nhóm)...`)
          try {
            await page.close().catch(() => {})
            page = await context.newPage()
            await this.enableMemorySaver(page)
          } catch (e) {
            console.warn('[Scanner] Failed to recycle tab:', (e as Error).message)
          }
        }

        try {
          const result = await this.scanGroup(page, groupUrl, config)
          cycleLeads.push(...result.newLeads)
          newLeads += result.newLeads.length
          totalPostsRead += result.postsRead
          groupsScanned++
        } catch (err) {
          if ((err as Error).message === 'SESSION_EXPIRED') {
            this.log(`🚨 Tài khoản ${account.username} hết phiên đăng nhập/bị yêu cầu xác minh -> đánh dấu CHECKPOINT`)
            this.store.updateAccountStatus(account.id, 'CHECKPOINT')
            break
          }
          this.log(`⚠️ Bỏ qua nhóm ${groupUrl}: ${(err as Error).message}`)
        }
        await sleep(randomBetween(5000, 12000))
      }

      if (this.isRunning() && !browserClosedExternally && cycleLeads.length > 0 && config.notifyRecipient) {
        try {
          await this.sendDigest(page, config.notifyRecipient, cycleLeads)
          this.log(`📨 Đã nhắn Messenger báo ${cycleLeads.length} khách mới`)
        } catch (err) {
          this.log(`⚠️ Không gửi được tin nhắn báo khách: ${(err as Error).message}`)
        }
      }

      if (this.isRunning() && !browserClosedExternally) {
        const cookies = await context.cookies()
        if (cookies.length > 0) this.store.updateAccountCookie(account.id, JSON.stringify(cookies))
      }
    } finally {
      stoppedByUs = true
      try {
        await context.close()
      } catch (err) {
        console.warn('[Scanner] Failed to close context:', (err as Error).message)
      }
    }

    this.log(`✅ Xong lượt quét: ${groupsScanned}/${config.groups.length} nhóm, đọc ${totalPostsRead} bài, ${newLeads} khách mới`)
  }

  private async scanGroup(page: Page, groupUrl: string, config: ScannerConfig): Promise<{ postsRead: number; newLeads: ScrapedLead[] }> {
    await page.goto(`${groupUrl}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await sleep(randomBetween(3000, 5000))

    const isLoginScreen = await page
      .evaluate(() => !!document.querySelector('input[name="email"], input[name="pass"]') || /login|checkpoint/i.test(location.href))
      .catch(() => false)
    if (isLoginScreen) throw new Error('SESSION_EXPIRED')

    const groupName = (await page.title()).replace(/\s*\|\s*Facebook.*$/i, '').trim()
    const newLeads: ScrapedLead[] = []

    // Facebook virtualizes the feed (old posts leave the DOM), so accumulate posts across scroll rounds
    const collected = new Map<string, RawPost>()
    const maxAgeDays = config.maxPostAgeDays ?? 3
    const MAX_CONSECUTIVE_OLD_POSTS = 10
    let consecutiveOldPosts = 0

    const collect = async (): Promise<boolean> => {
      try {
        // Tự động bung chữ "Xem thêm"
        const seeMoreBtns = await page.$$('div[role="button"]')
        for (const btn of seeMoreBtns) {
          const text = await btn.textContent().catch(() => '')
          if (text && (text.trim().toLowerCase() === 'xem thêm' || text.trim().toLowerCase() === 'see more')) {
            if (await btn.isVisible().catch(() => false)) {
              await btn.click().catch(() => { })
            }
          }
        }
        await sleep(500)
      } catch (err) { }

      const posts = await this.extractPosts(page)
      this.log(`[Debug] Lượt này bóc được ${posts.length} bài trên màn hình, tổng đã gom: ${collected.size + posts.length}`)

      // Quét và lọc bài viết ngay lập tức trong từng lượt cuộn (Real-time Stream)
      for (const post of posts) {
        const id = this.buildLeadId(post)
        if (!collected.has(id)) {
          collected.set(id, post)

          // Lọc thời gian đăng bài (bỏ qua nếu đăng cũ hơn maxAgeDays)
          const ageDays = parsePostAgeDays(post.postTimeText)
          if (ageDays !== null && ageDays > maxAgeDays) {
            consecutiveOldPosts++
            this.log(`⏳ [Bỏ qua bài cũ] "${post.authorName}" đăng ${post.postTimeText || `${ageDays} ngày trước`} (${consecutiveOldPosts}/${MAX_CONSECUTIVE_OLD_POSTS} bài liên tiếp)`)
            if (consecutiveOldPosts >= MAX_CONSECUTIVE_OLD_POSTS) {
              return true // Dừng cuộn nhóm khi đủ 10 bài cũ liên tiếp
            }
            continue
          } else if (ageDays !== null) {
            // Gặp bài đăng mới trong hạn quy định -> reset bộ đếm liên tiếp (tránh bị dừng nhầm do bài ghim)
            consecutiveOldPosts = 0
          }

          const evalResult = evaluatePostMatch(post.content, config)
          if (evalResult.matched) {
            const lead: ScrapedLead = {
              id,
              groupName,
              authorName: post.authorName,
              authorUrl: post.authorUrl || undefined,
              content: post.content.slice(0, 2000),
              postUrl: post.postUrl,
              postTimeText: post.postTimeText,
              matchedKeywords: evalResult.matchedKeywords,
              timestamp: Date.now(),
              status: 'new',
            }
            if (this.store.addLead(lead)) {
              newLeads.push(lead)
              this.pushEvent('scanner:new_lead', lead)
              this.log(`🎯 Khách mới: ${lead.authorName} (${evalResult.matchedKeywords.join(', ')})`)
            }
          } else if (evalResult.rejectReason) {
            this.log(`🛡️ [Né bài] "${post.authorName}": ${evalResult.rejectReason}`)
          }
        }
      }

      // Quét thêm bình luận dưới các bài viết nếu bật scanComments hoặc có nhập từ khóa bình luận
      if (config.scanComments || (config.commentKeywords && config.commentKeywords.length > 0)) {
        const comments = await this.extractComments(page)
        // Ô nhập từ khóa quét riêng cho bình luận
        const commentFilterKws = (config.commentKeywords && config.commentKeywords.length > 0)
          ? config.commentKeywords
          : (config.intentKeywords && config.intentKeywords.length > 0 ? config.intentKeywords : config.keywords)

        for (const comment of comments) {
          const normComment = normalizeText(comment.content)
          if (!normComment) continue

          // Kiểm tra loại trừ
          const isExcluded = (config.excludeKeywords ?? []).some((exKw) => {
            const n = normalizeText(exKw.trim())
            return n.length > 0 && normComment.includes(n)
          })
          if (isExcluded) continue

          const matchedKws = findMatchedKeywords(comment.content, commentFilterKws)
          if (matchedKws.length > 0) {
            const commentId = `fb_cmt_${createHash('sha1').update(comment.authorName + comment.content + comment.postUrl).digest('hex').slice(0, 16)}`
            if (!collected.has(commentId)) {
              collected.set(commentId, { authorName: comment.authorName, authorUrl: comment.authorUrl || '', content: comment.content, postUrl: comment.postUrl })
              const lead: ScrapedLead = {
                id: commentId,
                groupName,
                authorName: `💬 ${comment.authorName} (Bình luận)`,
                authorUrl: comment.authorUrl,
                content: `[Bình luận trong bài]: ${comment.content}`,
                postUrl: comment.postUrl,
                matchedKeywords: matchedKws,
                timestamp: Date.now(),
                status: 'new',
              }
              if (this.store.addLead(lead)) {
                newLeads.push(lead)
                this.pushEvent('scanner:new_lead', lead)
                this.log(`🎯 Khớp bình luận: ${comment.authorName} (${matchedKws.join(', ')})`)
              }
            }
          }
        }
      }

      return false
    }

    const initialReachedOld = await collect()
    if (initialReachedOld) {
      this.log(`⏱ Đã phát hiện ${MAX_CONSECUTIVE_OLD_POSTS} bài liên tiếp cũ hơn ${maxAgeDays} ngày ngay từ đầu. Hoàn thành nhóm sớm!`)
      return { postsRead: collected.size, newLeads }
    }

    let stalledRounds = 0
    for (let round = 0; round < MAX_SCROLL_ROUNDS && collected.size < TARGET_POSTS_PER_GROUP; round++) {
      if (!this.isRunning() || page.isClosed()) break
      const sizeBefore = collected.size
      const scrollAmount = randomBetween(1200, 2000)
      await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount)
      await sleep(randomBetween(2500, 4000))
      const reachedOld = await collect()
      if (reachedOld) {
        this.log(`⏱ Đã phát hiện ${MAX_CONSECUTIVE_OLD_POSTS} bài liên tiếp cũ hơn ${maxAgeDays} ngày -> Dừng cuộn nhóm!`)
        break
      }
      stalledRounds = collected.size > sizeBefore ? 0 : stalledRounds + 1
      if (stalledRounds >= STALLED_ROUNDS_LIMIT + 2) {
        this.log(`[Debug] Không có thêm bài mới sau 4 lần cuộn, hoàn thành nhóm.`)
        break
      }
    }

    this.log(`📄 ${groupName || groupUrl}: đọc ${collected.size} bài, ${newLeads.length} khách tiềm năng phù hợp`)
    return { postsRead: collected.size, newLeads }
  }

  /**
   * Quét nhanh một nhóm trực tiếp từ tab Playwright đang mở của Worker (chế độ Luân phiên Đăng bài 🔄 Săn khách)
   * Không mở lại browser mới, tận dụng luôn tab hiện tại.
   */
  async scanQuicklyWithPage(page: Page, maxGroups: number = 2): Promise<number> {
    const config = this.store.getScannerConfig()
    if (!config.isRunning || config.groups.length === 0 || config.keywords.length === 0) {
      return 0
    }

    const groups = config.groups.filter(g => g.includes('facebook.com/groups/'))
    if (groups.length === 0) return 0

    // Đảm bảo chuyển về Tài khoản cá nhân trước khi quét
    await this.ensurePersonalProfile(page)

    // Xoay vòng nhóm thông minh (Round-Robin) thay vì luôn lấy từ đầu
    const selectedGroups: string[] = []
    const totalGroups = groups.length
    const numToPick = Math.min(maxGroups, totalGroups)

    for (let i = 0; i < numToPick; i++) {
      const idx = (this.quickScanGroupIndex + i) % totalGroups
      selectedGroups.push(groups[idx])
    }
    this.quickScanGroupIndex = (this.quickScanGroupIndex + numToPick) % totalGroups

    let foundLeadsCount = 0

    for (const groupUrl of selectedGroups) {
      if (page.isClosed()) break
      try {
        this.log(`🔍 [Luân phiên] Tạm nghỉ đăng, đang quét săn khách tại nhóm (${selectedGroups.indexOf(groupUrl) + 1}/${selectedGroups.length}): ${groupUrl}`)
        const result = await this.scanGroup(page, groupUrl, config)
        foundLeadsCount += result.newLeads.length
      } catch (err) {
        this.log(`⚠️ [Luân phiên] Lỗi quét nhanh nhóm ${groupUrl}: ${(err as Error).message}`)
      }
      await sleep(randomBetween(3000, 5000))
    }

    return foundLeadsCount
  }

  /** Sends ONE summary message per cycle (never one message per lead) to avoid Messenger spam flags. */
  private async sendDigest(page: Page, recipientUrl: string, leads: ScrapedLead[]): Promise<boolean> {
    const shown = leads.slice(0, MAX_LEADS_PER_DIGEST)
    const lines: string[] = [`🎯 Có ${leads.length} khách mới từ FollowFree:`]
    shown.forEach((lead, index) => {
      const snippet = lead.content.replace(/\s+/g, ' ').slice(0, 120)
      lines.push('', `${index + 1}. ${lead.authorName} (${lead.matchedKeywords.join(', ')})`, `"${snippet}"`, lead.postUrl)
    })
    if (leads.length > shown.length) lines.push('', `... và ${leads.length - shown.length} khách khác trong app`)

    // ĐẢM BẢO Ở TƯ CÁCH CÁ NHÂN: Fanpage không có quyền gửi tin nhắn cho profile cá nhân
    await this.ensurePersonalProfile(page)

    await page.goto(recipientUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
    const textbox = page.locator('div[role="textbox"][contenteditable="true"]').last()
    await textbox.waitFor({ state: 'visible', timeout: 25000 })
    await sleep(randomBetween(1500, 3000))
    await textbox.click()

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press('Shift+Enter')
      if (lines[i]) await page.keyboard.insertText(lines[i])
    }
    await sleep(randomBetween(800, 1500))
    await page.keyboard.press('Enter')
    await sleep(randomBetween(2000, 3500))
    return true
  }

  private buildLeadId(post: RawPost): string {
    const idMatch = post.postUrl.match(/(?:posts|permalink)\/(\d+)|story_fbid=(\d+)/)
    const postId = idMatch?.[1] ?? idMatch?.[2]
    if (postId) return `fb_${postId}`
    return `fb_${createHash('sha1').update(post.authorName + post.content.slice(0, 200)).digest('hex').slice(0, 16)}`
  }

  private async extractPosts(page: Page): Promise<RawPost[]> {
    return page.evaluate((): RawPost[] => {
      const results: RawPost[] = []

      const postCards = Array.from(document.querySelectorAll('div[role="article"], div[aria-posinset]')) as HTMLElement[]

      postCards.forEach((postCard) => {
        // Bỏ qua các thẻ nằm lồng bên trong thẻ article khác (bài viết được chia sẻ)
        if (postCard.parentElement?.closest('div[role="article"]')) return

        // Để lấy được nội dung chữ cho mọi loại bài (dài, ngắn nền màu, etc.), ta có thể kết hợp:
        // 1. innerText để lấy text hiển thị bình thường.
        // 2. textContent của các thẻ div/span có font-size lớn hoặc dir="auto" để bắt chữ của nền màu.
        // Nhờ .replace(/[^\w\s\u0102-\u1EF9]/gi, ' ') ta sẽ xoá rác SVG
        let content = postCard.innerText || ''

        // Cố gắng bắt text của các bài nền màu thông qua selector chính xác
        const cometMsg = postCard.querySelector('div[data-ad-preview="message"], div[data-ad-comet-preview="message"]') as HTMLElement;
        if (cometMsg) {
          const text = cometMsg.textContent || '';
          if (!content.includes(text.substring(0, 10))) { // Tránh ghép trùng lặp nếu innerText đã có
            content += ' ' + text;
          }
        }

        // Lọc bỏ rác chữ Facebook lặp lại nếu có
        content = content.replace(/(Facebook\s*){3,}/gi, ' ');

        const cleanContent = content.trim();
        if (cleanContent.length < 5) return;

        const allLinks = Array.from(postCard.querySelectorAll('a[href]')) as HTMLAnchorElement[]

        let postUrl = ''
        let authorName = 'Thành viên nhóm'
        let authorUrl = ''

        // Tìm link bài viết chuẩn xác (bắt buộc phải có ID bài viết hoặc permalink)
        let postLink = allLinks.find(a =>
          /\/groups\/[^/]+\/(posts|permalink)\/\d+/.test(a.href) && !a.href.includes('comment_id')
        )

        if (!postLink) {
          postLink = allLinks.find(a => a.href.includes('multi_permalinks=') || a.href.includes('story_fbid='))
        }

        if (postLink) {
          const cleanUrlMatch = postLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
          postUrl = cleanUrlMatch ? cleanUrlMatch[1] : postLink.href.split('&')[0].split('?')[0]
        } else {
          // Fallback 1: Thử lấy link từ nút "Bình luận" (chứa đường dẫn gốc của bài)
          const commentLink = allLinks.find(a => (a.href.includes('comment_id') || a.innerText.toLowerCase().includes('bình luận') || a.innerText.toLowerCase().includes('comment')) && /\/groups\/[^/]+\/(posts|permalink)\/\d+/.test(a.href))
          if (commentLink) {
            const m = commentLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
            if (m) postUrl = m[1]
          }

          // Fallback 2: Link ở mốc thời gian bài viết (thường chứa link bài gốc)
          if (!postUrl) {
            const timeLink = allLinks.find(a =>
              (a.href.includes('/posts/') || a.href.includes('/permalink/')) &&
              !a.href.includes('/user/') &&
              !a.href.includes('/hashtag/')
            )
            if (timeLink) {
              const m = timeLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
              if (m) postUrl = m[1]
            }
          }

          // Fallback 3: Kiểm tra các link có chứa query parameter ID bài viết
          if (!postUrl) {
            const storyLink = allLinks.find(a => a.href.includes('story_fbid=') || a.href.includes('fbid='))
            if (storyLink) {
              postUrl = storyLink.href
            }
          }
        }

        // Tìm tác giả
        const authorLink = allLinks.find(a =>
          a.href.includes('/user/') ||
          a.href.includes('profile.php') ||
          a.querySelector('strong') ||
          a.querySelector('h2') ||
          a.querySelector('h3')
        )

        if (authorLink && authorLink.innerText.trim()) {
          authorName = authorLink.innerText.trim()
          authorUrl = authorLink.href.split('?')[0]
        } else {
          const strongTag = postCard.querySelector('strong, h2, h3, b') as HTMLElement | null
          if (strongTag && strongTag.innerText.trim()) {
            authorName = strongTag.innerText.trim()
          }
        }

        // Tìm thời gian đăng bài
        let postTimeText = ''
        if (postLink) {
          postTimeText = (postLink.getAttribute('aria-label') || postLink.innerText || '').trim()
        }
        if (!postTimeText) {
          const timeCandidate = allLinks.find(a =>
            /ngày|giờ|phút|hôm qua|tháng|vừa xong|mins?|hrs?|yesterday|just now/i.test(a.innerText || a.getAttribute('aria-label') || '')
          )
          if (timeCandidate) {
            postTimeText = (timeCandidate.getAttribute('aria-label') || timeCandidate.innerText || '').trim()
          }
        }
        if (!postTimeText) {
          const spans = Array.from(postCard.querySelectorAll('span[dir="auto"], span')) as HTMLElement[]
          const timeSpan = spans.find(s =>
            /(?:^\d+\s*(?:ngày|giờ|phút|h|d|m|w|tuần|tháng)|vừa xong|hôm qua)/i.test(s.innerText.trim())
          )
          if (timeSpan) {
            postTimeText = timeSpan.innerText.trim()
          }
        }
        postTimeText = postTimeText.replace(/[·•🌐\n\r]/g, ' ').replace(/\s+/g, ' ').trim()

        if (postUrl) {
          results.push({ authorName, authorUrl, content: cleanContent, postUrl, postTimeText: postTimeText || undefined })
        }
      })

      return results
    })
  }

  private async extractComments(page: Page): Promise<Array<{ authorName: string; authorUrl?: string; content: string; postUrl: string }>> {
    return page.evaluate(() => {
      const results: Array<{ authorName: string; authorUrl?: string; content: string; postUrl: string }> = []
      const commentNodes = Array.from(document.querySelectorAll('div[role="article"]')) as HTMLElement[]

      commentNodes.forEach((node) => {
        // Chỉ lấy article là comment (nằm lồng trong article cha hoặc có nhãn bình luận)
        const isNested = !!node.parentElement?.closest('div[role="article"]')
        const ariaLabel = node.getAttribute('aria-label') || ''
        const isComment = isNested || /bình luận|comment/i.test(ariaLabel)
        if (!isComment) return

        const text = (node.innerText || '').trim()
        if (text.length < 4 || text.length > 500) return

        // Tìm link/tên tác giả bình luận
        const authorLink = node.querySelector('a[href*="/user/"], a[role="link"]') as HTMLAnchorElement | null
        const strongAuthor = node.querySelector('strong, span[dir="auto"]') as HTMLElement | null
        const authorName = authorLink?.innerText?.trim() || strongAuthor?.innerText?.trim() || 'Thành viên'
        const authorUrl = authorLink?.href ? authorLink.href.split('?')[0] : undefined

        // Tìm link bài viết cha
        const parentPost = node.closest('div[aria-posinset]') || node.closest('div[role="feed"] > div')
        let postUrl = location.href
        if (parentPost) {
          const pLink = parentPost.querySelector('a[href*="/posts/"], a[href*="/permalink/"]') as HTMLAnchorElement | null
          if (pLink?.href) {
            const m = pLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
            postUrl = m ? m[1] : pLink.href.split('?')[0]
          }
        }

        results.push({
          authorName,
          authorUrl,
          content: text,
          postUrl,
        })
      })

      return results
    }).catch(() => [])
  }

  /**
   * Đảm bảo tài khoản đang ở tư cách Cá Nhân (Personal Profile) để quét nhóm và nhắn Messenger
   */
  private async ensurePersonalProfile(page: Page): Promise<boolean> {
    try {
      if (page.isClosed()) return false;
      this.log('👤 Đang kiểm tra để đảm bảo ở tư cách Tài khoản cá nhân...');

      // Thử vào link tạo Page. Nếu đang ở Fanpage, Facebook sẽ báo "Bạn hiện không xem được nội dung này" (This content isn't available)
      await page.goto('https://www.facebook.com/pages/creation/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
      await sleep(2500);

      const isPage = await page.getByText(/Bạn hiện không xem được nội dung này|This content isn't available right now/i).isVisible().catch(() => false);

      if (!isPage) {
        this.log('✅ Xác nhận: Đang ở sẵn Tài khoản cá nhân!');
        return true;
      }

      this.log('🔄 Phát hiện đang kẹt ở thân phận Fanpage! Tiến hành tráo đổi về Nick cá nhân...');
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' }).catch(() => { });
      await sleep(3000);

      // Bấm vào Menu Avatar (góc trên cùng bên phải)
      const avatarSelectors = [
        'svg[aria-label="Trang cá nhân của bạn"]',
        'svg[aria-label="Your profile"]',
        'div[aria-label="Tài khoản"][role="button"]',
        'div[aria-label="Account"][role="button"]',
        'div[data-visualcompletion="ignore-dynamic"] image',
        'image'
      ];

      let clicked = false;
      for (const sel of avatarSelectors) {
        const el = page.locator(sel).last();
        if (await el.isVisible().catch(() => false)) {
          const box = await el.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            clicked = true;
            break;
          }
        }
      }

      if (!clicked) {
        this.log('⚠️ Không tìm thấy nút Menu Avatar để đổi nick');
        return false;
      }

      await sleep(2500);

      // Khi ở Page, mở Menu ra thì Nick cá nhân chính luôn nằm ở vị trí thứ 2 (dưới tên Page hiện tại)
      const spans = await page.locator('div[role="dialog"] span[dir="auto"], div[role="menu"] span[dir="auto"]').all();
      const valids: any[] = [];
      for (const span of spans) {
        if (await span.isVisible().catch(() => false)) {
          const text = await span.textContent().catch(() => '');
          if (text && text.trim().length > 0 && text.trim().length < 60) {
            const t = text.toLowerCase();
            const isMenu = t.includes('thông báo') || t.includes('cài đặt') || t.includes('đăng xuất') || t.includes('trợ giúp') || t.includes('xem tất cả') || t.includes('quảng cáo');
            const isNotif = /\d+\s*(unseen|notification|update|tin nhắn|thông báo)/i.test(t);
            if (!isMenu && !isNotif) {
              valids.push(span);
            }
          }
        }
      }

      // Lọc trùng
      const uniqueValids: any[] = [];
      const seen = new Set<string>();
      for (const v of valids) {
        const t = (await v.textContent().catch(() => ''))?.trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          uniqueValids.push(v);
        }
      }

      if (uniqueValids.length > 1) {
        const target = uniqueValids[1];
        const targetName = await target.textContent().catch(() => 'Nick cá nhân');
        this.log(`👉 Bấm chọn chuyển sang Nick cá nhân: "${targetName}"...`);
        const box = await target.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await target.click({ force: true }).catch(() => { });
        }
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => { });
        await sleep(5000);
        this.log(`✅ Đã chuyển thành công về Tài khoản cá nhân: "${targetName}"!`);
        return true;
      } else {
        await page.keyboard.press('Escape');
        this.log('⚠️ Không tìm thấy profile Nick cá nhân trong Menu');
      }

      return false;
    } catch (err) {
      console.warn('[Scanner] Lỗi khi đổi về tài khoản cá nhân:', err);
      return false;
    }
  }

  /**
   * Chặn nạp các tài nguyên video, streaming, và file media nặng để khống chế RAM dưới 500MB
   * Vẫn giữ nguyên 100% tài liệu, HTML, scripts, và API fetch để đọc chữ chính xác tuyệt đối.
   */
  private async enableMemorySaver(page: Page): Promise<void> {
    try {
      if (page.isClosed()) return
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType()
        const url = route.request().url()
        if (
          resourceType === 'media' ||
          /\.(mp4|webm|m3u8|mp3|ogg|wav)(\?.*)?$/i.test(url) ||
          url.includes('video.xx.fbcdn.net') ||
          url.includes('/video_redirect/') ||
          url.includes('/t39.2365-6/')
        ) {
          return route.abort().catch(() => {})
        }
        return route.continue().catch(() => {})
      })
    } catch {
      // Ignore if route already registered or page navigating
    }
  }

  private emitStatus(): void {
    this.pushEvent('scanner:status', { isRunning: this.isRunning(), scanning: this.cycleInProgress })
  }

  private log(message: string): void {
    console.log(`[Scanner] ${message}`)
    this.pushEvent('scanner:log', { time: new Date().toLocaleTimeString('vi-VN'), message })
  }
}
