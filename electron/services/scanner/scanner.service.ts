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
  private currentContext: BrowserContext | null = null

  constructor(
    private readonly store: StoreService,
    private readonly ipv6Service: Ipv6Service,
    private readonly localProxyService: LocalProxyService,
    private readonly createContext: CreateContext,
    private readonly isWorkerBusy: () => boolean,
    private readonly pushEvent: PushEvent,
  ) {}

  getConfig(): ScannerConfig {
    return this.store.getScannerConfig()
  }

  /** Validates and persists config. Returns error message when invalid. */
  saveConfig(input: { groups: string[]; keywords: string[]; intervalMinutes: number; notifyRecipient?: string }): { success: boolean; error?: string } {
    const groups = Array.from(
      new Set(input.groups.map(normalizeGroupInput).filter((g): g is string => g !== null)),
    )
    const keywords = Array.from(new Set(input.keywords.map((k) => k.trim()).filter((k) => k.length > 0)))

    if (groups.length === 0) return { success: false, error: 'Cần ít nhất 1 nhóm hợp lệ' }
    if (groups.length > MAX_GROUPS) return { success: false, error: `Tối đa ${MAX_GROUPS} nhóm` }
    if (keywords.length === 0) return { success: false, error: 'Cần ít nhất 1 từ khóa' }

    const rawRecipient = (input.notifyRecipient ?? '').trim()
    const notifyRecipient = rawRecipient ? normalizeRecipientInput(rawRecipient) : ''
    if (rawRecipient && !notifyRecipient) {
      return { success: false, error: 'Người nhận thông báo không hợp lệ (dán link trang cá nhân Facebook, username hoặc ID)' }
    }

    const intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(input.intervalMinutes) || 15))
    this.store.updateScannerConfig({ groups, keywords, intervalMinutes, notifyRecipient: notifyRecipient || undefined })
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

    const { context, page } = await this.createContext(account, proxyUrl)
    this.currentContext = context
    let browserClosedExternally = false
    let stoppedByUs = false
    context.on('close', () => {
      if (!stoppedByUs) browserClosedExternally = true
    })

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
              const links = Array.from(document.querySelectorAll('a[href*="/groups/"]'));
              return links
                .map(a => a.getAttribute('href') || '')
                .filter(href => href.includes('/groups/') && !href.includes('/search/') && !href.includes('/discover/') && !href.includes('/feed/'))
                .map(href => href.split('?')[0])
            })
            
            for (const url of urls) {
              if (!targetGroupUrls.has(url)) {
                 targetGroupUrls.add(url)
                 foundCount++
              }
            }
            if (foundCount >= 10) break // Chỉ lấy top 10 nhóm tốt nhất cho mỗi từ khóa mỗi chu kỳ
            
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
        try {
          const result = await this.scanGroup(page, groupUrl, config.keywords)
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

  private async scanGroup(page: Page, groupUrl: string, keywords: string[]): Promise<{ postsRead: number; newLeads: ScrapedLead[] }> {
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
    const collect = async (): Promise<void> => {
      try {
         // Tự động bung chữ "Xem thêm"
         const seeMoreBtns = await page.$$('div[role="button"]')
         for (const btn of seeMoreBtns) {
             const text = await btn.textContent().catch(() => '')
             if (text && (text.trim().toLowerCase() === 'xem thêm' || text.trim().toLowerCase() === 'see more')) {
                 if (await btn.isVisible().catch(() => false)) {
                     await btn.click().catch(() => {})
                 }
             }
         }
         await sleep(500)
      } catch (err) {}

      const posts = await this.extractPosts(page)
      if (posts.length > 0) {
        const first = posts[0]
        this.log(`[Debug] Bài đầu tiên: URL=${first.postUrl}, Author=${first.authorName}, Chữ đầu: ${first.content.slice(0, 50).replace(/\n/g, ' ')}`)
      }
      this.log(`[Debug] Lượt này bóc được ${posts.length} bài trên màn hình, tổng đã gom: ${collected.size + posts.length}`)
      // Quét và bắt lead ngay lập tức trong từng lượt cuộn (Real-time Stream)
      for (const post of posts) {
        const id = this.buildLeadId(post)
        if (!collected.has(id)) {
          collected.set(id, post)
          
          const matched = findMatchedKeywords(post.content, keywords)
          if (matched.length > 0) {
            const lead: ScrapedLead = {
              id,
              groupName,
              authorName: post.authorName,
              authorUrl: post.authorUrl || undefined,
              content: post.content.slice(0, 2000),
              postUrl: post.postUrl,
              matchedKeywords: matched,
              timestamp: Date.now(),
              status: 'new',
            }
            if (this.store.addLead(lead)) {
              newLeads.push(lead)
              this.pushEvent('scanner:new_lead', lead)
              this.log(`🎯 Khách mới: ${lead.authorName} (${matched.join(', ')})`)
            }
          }
        }
      }
    }

    await collect()
    let stalledRounds = 0
    for (let round = 0; round < MAX_SCROLL_ROUNDS && collected.size < TARGET_POSTS_PER_GROUP; round++) {
      if (!this.isRunning() || page.isClosed()) break
      const sizeBefore = collected.size
      const scrollAmount = randomBetween(1200, 2000)
      await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount)
      await sleep(randomBetween(2500, 4000))
      await collect()
      stalledRounds = collected.size > sizeBefore ? 0 : stalledRounds + 1
      if (stalledRounds >= STALLED_ROUNDS_LIMIT + 2) {
        this.log(`[Debug] Không có thêm bài mới sau 4 lần cuộn, hoàn thành nhóm.`)
        break
      }
    }

    this.log(`📄 ${groupName || groupUrl}: đọc ${collected.size} bài, ${newLeads.length} bài khớp từ khóa`)
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

    // Chọn ngẫu nhiên hoặc xoay vòng nhóm để quét
    const selectedGroups = groups.slice(0, maxGroups)
    let foundLeadsCount = 0

    for (const groupUrl of selectedGroups) {
      if (page.isClosed()) break
      try {
        this.log(`🔍 [Luân phiên] Tạm nghỉ đăng, đang quét săn khách tại: ${groupUrl}`)
        const result = await this.scanGroup(page, groupUrl, config.keywords)
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

        if (postUrl) {
            results.push({ authorName, authorUrl, content: cleanContent, postUrl })
        }
      })

      return results
    })
  }

  /**
   * Đảm bảo tài khoản đang ở tư cách Cá Nhân (Personal Profile) để quét nhóm và nhắn Messenger
   */
  private async ensurePersonalProfile(page: Page): Promise<boolean> {
    try {
      if (page.isClosed()) return false;
      this.log('👤 Đang kiểm tra để đảm bảo ở tư cách Tài khoản cá nhân...');

      // Thử vào link tạo Page. Nếu đang ở Fanpage, Facebook sẽ báo "Bạn hiện không xem được nội dung này" (This content isn't available)
      await page.goto('https://www.facebook.com/pages/creation/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await sleep(2500);

      const isPage = await page.getByText(/Bạn hiện không xem được nội dung này|This content isn't available right now/i).isVisible().catch(() => false);

      if (!isPage) {
        this.log('✅ Xác nhận: Đang ở sẵn Tài khoản cá nhân!');
        return true;
      }

      this.log('🔄 Phát hiện đang kẹt ở thân phận Fanpage! Tiến hành tráo đổi về Nick cá nhân...');
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
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
          await target.click({ force: true }).catch(() => {});
        }
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
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

  private emitStatus(): void {
    this.pushEvent('scanner:status', { isRunning: this.isRunning(), scanning: this.cycleInProgress })
  }

  private log(message: string): void {
    console.log(`[Scanner] ${message}`)
    this.pushEvent('scanner:log', { time: new Date().toLocaleTimeString('vi-VN'), message })
  }
}
