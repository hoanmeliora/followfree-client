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
      for (const post of posts) {
        const id = this.buildLeadId(post)
        collected.set(id, post)
      }
    }

    await collect()
    let stalledRounds = 0
    for (let round = 0; round < MAX_SCROLL_ROUNDS && collected.size < TARGET_POSTS_PER_GROUP; round++) {
      const sizeBefore = collected.size
      const scrollAmount = randomBetween(1200, 2000)
      await page.evaluate((amount) => window.scrollBy(0, amount), scrollAmount)
      await sleep(randomBetween(2500, 4000))
      await collect()
      stalledRounds = collected.size > sizeBefore ? 0 : stalledRounds + 1
      if (stalledRounds >= STALLED_ROUNDS_LIMIT + 2) {
        this.log(`[Debug] Không có thêm bài mới sau 4 lần cuộn, thoát.`)
        break
      }
    }
    const posts = Array.from(collected.values())

    const groupName = (await page.title()).replace(/\s*\|\s*Facebook.*$/i, '').trim()
    const newLeads: ScrapedLead[] = []

    for (const post of posts) {
      const matched = findMatchedKeywords(post.content, keywords)
      if (matched.length === 0) continue

      const lead: ScrapedLead = {
        id: this.buildLeadId(post),
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
      }
    }

    this.log(`📄 ${groupName || groupUrl}: đọc ${posts.length} bài, ${newLeads.length} bài mới khớp từ khóa`)
    return { postsRead: posts.length, newLeads }
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

        // Tìm link bài viết chuẩn xác
        let postLink = allLinks.find(a => 
            /\/groups\/[^/]+\/(posts|permalink)\/\d+/.test(a.href) && !a.href.includes('comment_id')
        )
        
        if (!postLink) {
            postLink = allLinks.find(a => a.href.includes('multi_permalinks='))
        }

        if (postLink) {
            const cleanUrlMatch = postLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
            postUrl = cleanUrlMatch ? cleanUrlMatch[1] : postLink.href.split('?')[0]
        } else {
            // Fallback 1: Thử lấy link từ nút "Bình luận" (thường chứa đường dẫn gốc của bài)
            const commentLink = allLinks.find(a => a.href.includes('comment_id') || a.innerText.toLowerCase().includes('bình luận') || a.innerText.toLowerCase().includes('comment'))
            if (commentLink && /\/groups\/[^/]+\/(posts|permalink)\/\d+/.test(commentLink.href)) {
                 const m = commentLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
                 if (m) postUrl = m[1]
            }
            
            // Fallback 2: Lấy link thời gian (thường có __cft__)
            if (!postUrl) {
                const timeLink = allLinks.find(a => a.href.includes('__cft__') && (a.innerText.includes(' ') || a.innerText.match(/\d/)) && !a.href.includes('/user/'))
                if (timeLink) postUrl = timeLink.href.split('?')[0]
            }
            
            // Fallback 3: Lấy bừa link đầu tiên trỏ vào nhóm (tránh link user)
            if (!postUrl) {
                const groupLink = allLinks.find(a => a.href.includes('/groups/') && !a.href.includes('/user/'))
                if (groupLink) postUrl = groupLink.href.split('?')[0]
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

  private emitStatus(): void {
    this.pushEvent('scanner:status', { isRunning: this.isRunning(), scanning: this.cycleInProgress })
  }

  private log(message: string): void {
    console.log(`[Scanner] ${message}`)
    this.pushEvent('scanner:log', { time: new Date().toLocaleTimeString('vi-VN'), message })
  }
}
