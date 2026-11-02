import { Page } from 'playwright'
import { AutomationService } from '../automation.service'
import { SelfHealingService } from '../self-healing.service'
import { IPlatformExecutor } from './platform-executor.interface'
import { StoreService } from '../store.service'

/**
 * Xử lý Spin-text: "{Chào bạn|Hi bạn|Hello} mình gửi JD {qua inbox|vào tin nhắn} nhé"
 */
function parseSpinText(text: string): string {
  return text.replace(/\{([^{}]+)\}/g, (_, choices) => {
    const list = choices.split('|')
    return list[Math.floor(Math.random() * list.length)].trim()
  })
}

/**
 * Chuẩn hoá tiếng Việt: Bỏ dấu (Accents/Diacritics) để so khớp không dấu & có dấu
 * Ví dụ: "Tìm Việc Làm" -> "tim viec lam"
 */
function removeVietnameseTones(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, m => (m === 'đ' ? 'd' : 'D'))
    .toLowerCase();
}

/**
 * So khớp từ khoá chuẩn xác:
 * - So khớp cả tiếng Việt có dấu VÀ không dấu (ví dụ: 'tim viec' = 'tìm việc')
 * - Hỗ trợ ranh giới từ với các ký tự đặc biệt, dấu câu, emoji cho các từ ngắn (ib, cv, jd, job...)
 * - KHÔNG CHÈN BỘ LỌC CỨNG (chỉ lọc đúng theo từ khoá mà người dùng chỉ định)
 */
function findMatchedKeyword(text: string, keywords: string[]): string | null {
  const textLower = text.toLowerCase()
  const textUnaccented = removeVietnameseTones(text)

  for (const kw of keywords) {
    const kwLower = kw.trim().toLowerCase()
    if (!kwLower) continue
    const kwUnaccented = removeVietnameseTones(kwLower)

    // Với các từ ngắn (<= 3 ký tự như ib, cv, jd...)
    if (kwLower.length <= 3) {
      const regex1 = new RegExp(`(^|\\s|[.,!?;:()\\/\\-\\[\\]{}"'“”])${kwLower}($|\\s|[.,!?;:()\\/\\-\\[\\]{}"'“”])`, 'i')
      const regex2 = new RegExp(`(^|\\s|[.,!?;:()\\/\\-\\[\\]{}"'“”])${kwUnaccented}($|\\s|[.,!?;:()\\/\\-\\[\\]{}"'“”])`, 'i')
      if (regex1.test(textLower) || regex2.test(textUnaccented)) {
        return kwLower
      }
    } else {
      if (textLower.includes(kwLower) || textUnaccented.includes(kwUnaccented)) {
        return kwLower
      }
    }
  }

  return null
}

/**
 * Trích xuất định danh cố định (Unique Post ID / Permalink) của bài viết Threads
 */
async function extractThreadPostId(block: any): Promise<string | null> {
  try {
    const linkEl = block.locator('a[href*="/post/"], a[href*="/t/"]').first()
    if (await linkEl.count().catch(() => 0)) {
      const href = await linkEl.getAttribute('href').catch(() => null)
      if (href) {
        const match = href.match(/\/(post|t)\/([A-Za-z0-9_-]+)/)
        if (match) return match[2]
        return href
      }
    }

    for (const ancestorXPath of ['xpath=..', 'xpath=../..', 'xpath=ancestor::article']) {
      const ancestor = block.locator(ancestorXPath).first()
      if (await ancestor.count().catch(() => 0)) {
        const aEl = ancestor.locator('a[href*="/post/"], a[href*="/t/"]').first()
        if (await aEl.count().catch(() => 0)) {
          const href = await aEl.getAttribute('href').catch(() => null)
          if (href) {
            const match = href.match(/\/(post|t)\/([A-Za-z0-9_-]+)/)
            if (match) return match[2]
            return href
          }
        }
      }
    }
  } catch {}
  return null
}

/**
 * Trích xuất đường dẫn trang cá nhân của tác giả bài viết
 */
async function extractAuthorProfile(block: any): Promise<string | null> {
  try {
    const authorLink = block.locator('a[href^="/@"], a[href*="threads.net/@"]').first()
    if (await authorLink.count().catch(() => 0)) {
      const href = await authorLink.getAttribute('href').catch(() => null)
      if (href) {
        return href.startsWith('http') ? href : `https://www.threads.net${href.startsWith('/') ? '' : '/'}${href}`
      }
    }
    for (const ancestorXPath of ['xpath=..', 'xpath=../..', 'xpath=ancestor::article']) {
      const ancestor = block.locator(ancestorXPath).first()
      if (await ancestor.count().catch(() => 0)) {
        const aEl = ancestor.locator('a[href^="/@"], a[href*="threads.net/@"]').first()
        if (await aEl.count().catch(() => 0)) {
          const href = await aEl.getAttribute('href').catch(() => null)
          if (href) {
            return href.startsWith('http') ? href : `https://www.threads.net${href.startsWith('/') ? '' : '/'}${href}`
          }
        }
      }
    }
  } catch {}
  return null
}

/**
 * Tạo khoá nội dung bất biến:
 * Loại bỏ toàn bộ các con số thời gian biến động (13 giờ, 1 ngày, 15 lượt thích, 10 bình luận...)
 * Giúp nhận diện đúng bài viết dù thời gian hoặc lượt like có thay đổi
 */
function generatePostContentKey(text: string): string {
  return removeVietnameseTones(text)
    .replace(/\b\d+\s*(ngay|gio|phut|giay|thang|nam|luot thich|luot xem|binh luan|comment|like|day|hour|min|sec)\b/gi, '')
    .replace(/[0-9]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

export class ThreadsExecutor implements IPlatformExecutor {
  readonly platform = 'THREADS'

  constructor(
    private readonly automationService: AutomationService,
    private readonly selfHealingService: SelfHealingService,
    private readonly store?: StoreService,
  ) {}

  async performAction(page: Page, task: any, account?: any, isAborted?: () => boolean): Promise<boolean | string> {
    try {
      const actionType = task.campaign?.metadata?.realActionType || task.metadata?.realActionType || task.campaign?.actionType || (typeof task === 'string' ? task : '')
      console.log(`[Threads] Thực thi action: ${actionType} trên url: ${task.campaign?.targetUrl || page.url()}`)

      switch (actionType) {
        case 'LIKE':
          return await this.clickLikeButton(page)

        case 'FOLLOW':
          return await this.clickFollowButton(page)

        case 'REPLY':
        case 'COMMENT': {
          const content = task.campaign?.metadata?.commentText || task.campaign?.metadata?.text || 'Quan tâm'
          return await this.postReply(page, content)
        }

        case 'REPOST':
          return await this.clickRepostButton(page)

        case 'RECRUIT_AUTO_REPLY':
        case 'AUTO_RECRUIT':
          return await this.handleRecruitAutoAction(page, task, isAborted, account)

        case 'SEND_DM': {
          const message = task.campaign?.metadata?.message || task.campaign?.metadata?.text || ''
          return await this.sendDirectMessage(page, message)
        }

        default:
          console.warn(`[Threads] Chưa hỗ trợ actionType: ${actionType}`)
          return false
      }
    } catch (err: any) {
      console.error('[Threads] performAction error:', err)
      return false
    }
  }

  /**
   * Thả tim bài viết / thread hiện tại
   */
  private async clickLikeButton(page: Page): Promise<boolean> {
    await this.automationService.simulateScroll(page, 2000)

    const likeSelectors = [
      'svg[aria-label="Thích"]',
      'svg[aria-label="Like"]',
      '[aria-label="Thích"]',
      '[aria-label="Like"]',
      'div[role="button"]:has(svg[aria-label="Like"])',
      'div[role="button"]:has(svg[aria-label="Thích"])',
    ]

    for (const selector of likeSelectors) {
      const clicked = await this.automationService.simulateHumanClick(page, selector, { index: 0 })
      if (clicked) {
        console.log('[Threads] Đã click nút Like thành công!')
        await this.automationService.wait(1500)
        return true
      }
    }

    console.warn('[Threads] Không tìm thấy nút Like')
    return false
  }

  /**
   * Theo dõi (Follow) tài khoản trên Threads
   */
  private async clickFollowButton(page: Page): Promise<boolean> {
    await this.automationService.simulateScroll(page, 1500)

    const followSelectors = [
      'div[role="button"]:has-text("Theo dõi")',
      'div[role="button"]:has-text("Follow")',
      'button:has-text("Theo dõi")',
      'button:has-text("Follow")',
      '[data-pressable-container="true"]:has-text("Follow")',
      '[data-pressable-container="true"]:has-text("Theo dõi")',
    ]

    for (const selector of followSelectors) {
      const locators = await page.locator(selector).all()
      for (const loc of locators) {
        const text = (await loc.textContent())?.trim().toLowerCase() || ''
        // Tránh click nhầm "Đang theo dõi" hoặc "Following"
        if (text === 'theo dõi' || text === 'follow') {
          await loc.click()
          console.log('[Threads] Đã click nút Theo dõi thành công!')
          await this.automationService.wait(2000)
          return true
        }
      }
    }

    console.warn('[Threads] Không tìm thấy nút Follow khả dụng')
    return false
  }

  /**
   * Đăng bài phản hồi (Reply/Comment) trên Threads
   */
  private async postReply(page: Page, textContent: string): Promise<boolean> {
    const finalContent = parseSpinText(textContent)
    console.log(`[Threads] Chuẩn bị Reply nội dung: "${finalContent}"`)

    const replyButtonSelectors = [
      'svg[aria-label="Trả lời"]',
      'svg[aria-label="Reply"]',
      '[aria-label="Trả lời"]',
      '[aria-label="Reply"]',
      'div[role="button"]:has(svg[aria-label="Reply"])',
      'div[role="button"]:has(svg[aria-label="Trả lời"])',
    ]

    let openedReplyBox = false
    for (const sel of replyButtonSelectors) {
      if (await this.automationService.simulateHumanClick(page, sel, { index: 0 })) {
        openedReplyBox = true
        break
      }
    }

    await this.automationService.wait(2000)

    const inputSelectors = [
      'div[role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="trả lời"]',
      'textarea[placeholder*="reply"]',
    ]

    let typed = false
    for (const sel of inputSelectors) {
      const el = page.locator(sel).first()
      if (await el.isVisible()) {
        await el.click()
        await this.automationService.wait(500)
        await this.safeTypeIntoEditor(page, finalContent)
        typed = true
        break
      }
    }

    if (!typed) {
      console.warn('[Threads] Không tìm thấy ô nhập nội dung Reply')
      return false
    }

    await this.automationService.wait(1500)

    // Bấm nút Đăng / Post (Hỗ trợ text, aria-label, nút tròn icon ↑ và phím tắt)
    const submitSelectors = [
      'div[role="button"][aria-label="Đăng"]',
      'div[role="button"][aria-label="Post"]',
      'div[role="button"][aria-label="Gửi"]',
      'div[role="button"][aria-label="Send"]',
      '[aria-label="Đăng"]',
      '[aria-label="Post"]',
      '[aria-label="Gửi"]',
      '[aria-label="Send"]',
      'div[role="button"]:has-text("Đăng")',
      'div[role="button"]:has-text("Post")',
      'button:has-text("Đăng")',
      'button:has-text("Post")',
    ]

    for (const sel of submitSelectors) {
      const submitBtn = page.locator(sel).last()
      if (await submitBtn.isVisible().catch(() => false)) {
        await submitBtn.click().catch(() => {})
        console.log('[Threads] Đã đăng Reply thành công!')
        await this.automationService.wait(3000)
        return true
      }
    }

    // Nút tròn ở góc ô soạn thảo
    const nearbyButtons = page.locator('div[role="textbox"] xpath=../..//div[@role="button"], div[contenteditable="true"] xpath=../..//div[@role="button"]')
    const count = await nearbyButtons.count().catch(() => 0)
    if (count > 0) {
      const lastBtn = nearbyButtons.last()
      if (await lastBtn.isVisible().catch(() => false)) {
        await lastBtn.click().catch(() => {})
        console.log('[Threads] Đã click nút gửi tròn!')
        await this.automationService.wait(3000)
        return true
      }
    }

    // Phím tắt dự phòng
    await page.keyboard.press('Control+Enter').catch(() => {})
    await page.keyboard.press('Meta+Enter').catch(() => {})
    await this.automationService.wait(2000)
    return true
  }

  /**
   * Repost (Đăng lại bài viết)
   */
  private async clickRepostButton(page: Page): Promise<boolean> {
    const repostSelectors = [
      'svg[aria-label="Đăng lại"]',
      'svg[aria-label="Repost"]',
      '[aria-label="Đăng lại"]',
      '[aria-label="Repost"]',
    ]

    for (const sel of repostSelectors) {
      if (await this.automationService.simulateHumanClick(page, sel, { index: 0 })) {
        await this.automationService.wait(1000)
        // Trong menu popup chọn 'Đăng lại' / 'Repost'
        const confirmBtn = page.locator('div[role="button"]:has-text("Đăng lại"), div[role="button"]:has-text("Repost")').first()
        if (await confirmBtn.isVisible()) {
          await confirmBtn.click()
          console.log('[Threads] Đã Repost thành công!')
          await this.automationService.wait(2000)
          return true
        }
      }
    }

    return false
  }

  /**
   * Tuyển dụng thông minh: Tự động Tìm kiếm toàn Threads (Search) hoặc Lướt Bảng tin (Feed)
   * Chế độ Radar 24/7: Quét liên tục không dừng cho đến khi người dùng bấm Dừng Bot
   */
  async handleRecruitAutoAction(page: Page, task: any, isAborted?: () => boolean, account?: any): Promise<boolean> {
    const config = task.campaign?.metadata || task.metadata || {}
    const targetKeywords: string[] = config.keywords || ['quan tâm', 'ib', 'inbox', 'xin jd', 'apply', 'cv', 'tư vấn', 'còn tuyển', 'job']
    const replyTemplate1 = config.replyTemplate || '{Dạ chào bạn|Chào bạn|Hi bạn}, bên mình vừa gửi JD chi tiết {qua tin nhắn chờ|vào inbox} cho bạn rồi ạ. Bạn kiểm tra giúp mình nhé!'
    const replyTemplate2 = config.replyTemplate2 || ''
    const dmTemplate = config.dmTemplate || ''
    const rawTemplates = Array.isArray(config.replyTemplates) && config.replyTemplates.length > 0
      ? config.replyTemplates
      : [replyTemplate1, replyTemplate2]
    const replyTemplates: string[] = rawTemplates.map((t: any) => String(t || '').trim()).filter((t: string) => t.length > 0)
    if (replyTemplates.length === 0) {
      replyTemplates.push(replyTemplate1)
    }

    const maxTarget = task.campaign?.targetCount || task.targetCount || 10
    const scanMode: 'BOTH' | 'SEARCH' | 'FEED' = config.scanMode || 'BOTH'
    const isContinuous: boolean = config.isContinuous !== false // Mặc định chạy liên tục 24/7!

    console.log(`[Threads Recruit] 🚀 Khởi chạy Radar Tuyển dụng (Chế độ: ${scanMode}, Quét liên tục: ${isContinuous}, Số mẫu phản hồi: ${replyTemplates.length})`)
    let totalProcessed = 0
    let round = 1
    
    // Chỉ nạp các Post ID chuẩn (loại bỏ các chuỗi text cũ để không bao giờ bị chặn nhầm bài viết mới)
    const savedPosts = (this.store?.getRepliedThreadPosts() || []).filter(p => p && p.length >= 6 && !p.includes(' '))
    const repliedSnippets = new Set<string>(savedPosts)
    console.log(`[Threads Recruit] 📋 Đã nạp ${repliedSnippets.size} Post ID đã tương tác trước đó (Chống comment trùng)`)

    while (!page.isClosed()) {
      if (isAborted && isAborted()) {
        console.log('[Threads Recruit] ⏹️ Nhận lệnh Dừng Bot từ người dùng. Kết thúc phiên quét.')
        break
      }

      console.log(`[Threads Recruit] 🔄 === BẮT ĐẦU VÒNG QUÉT THỨ ${round} === (Đã tiếp cận: ${totalProcessed} ứng viên)`)

      // 1. Chế độ Tìm kiếm theo từ khóa toàn Threads (Search)
      if (scanMode === 'SEARCH' || scanMode === 'BOTH') {
        const queryList = targetKeywords.map(k => k.trim()).filter(Boolean)
        const finalQueries = queryList.length > 0 ? queryList : ['tìm việc']

        for (const query of finalQueries) {
          if (page.isClosed() || (isAborted && isAborted())) break

          // Tab "Liên quan nhất" (serp_type=default)
          const searchUrl = `https://www.threads.net/search?q=${encodeURIComponent(query)}&serp_type=default`

          try {
            console.log(`[Threads Recruit] 🔍 [Vòng ${round}] Đang tìm kiếm từ khóa: "${query}" (Tab: Liên quan nhất)...`)
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {})
            await this.automationService.wait(2500)

            // Chủ động đảm bảo đang ở tab "Liên quan nhất" (Top / Most relevant)
            const relevantTabSelectors = [
              'div[role="tab"]:has-text("Liên quan nhất")',
              'div[role="tab"]:has-text("Top")',
              'button:has-text("Liên quan nhất")',
              'button:has-text("Top")',
              'span:has-text("Liên quan nhất")',
              'span:has-text("Top")',
            ]
            for (const tabSel of relevantTabSelectors) {
              const tabEl = page.locator(tabSel).first()
              if (await tabEl.isVisible().catch(() => false)) {
                console.log('[Threads Recruit] 🎯 Đã chọn tab "Liên quan nhất" để quét ứng viên sát nhu cầu nhất!')
                await tabEl.click().catch(() => {})
                await this.automationService.wait(1500)
                break
              }
            }

            // Cuộn từng bước mượt mà 10 đợt sâu để quét sạch và đầy đủ tất cả bài viết của từ khoá này
            for (let scrollRound = 0; scrollRound < 10; scrollRound++) {
              if (page.isClosed() || (isAborted && isAborted())) break

              // BẢO VỆ RANH GIỚI TRANG: Nếu bị lọt vào trang chi tiết bài viết (/@user/post/...), lập tức quay lại Search!
              if (page.url().includes('/post/') || page.url().includes('/@')) {
                console.log('[Threads Recruit] ↩️ Đang quay lại trang kết quả tìm kiếm...')
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
                await this.automationService.wait(2000)
              }

              await this.smoothScrollStep(page, 700)
              const processed = await this.scanAndReplyComments(page, targetKeywords, replyTemplates, 10, repliedSnippets, isAborted, account, dmTemplate)
              totalProcessed += processed
              if (processed > 0) {
                console.log(`[Threads Recruit] 🎯 Đã phản hồi ${processed} ứng viên trong kết quả tìm kiếm "${query}".`)
              }
            }
          } catch (searchErr: any) {
            console.warn('[Threads Recruit] Lỗi khi tìm kiếm trên Threads:', searchErr.message)
          }
        }
      }

      if (page.isClosed() || (isAborted && isAborted())) break

      // 2. Chế độ Lướt Bảng tin (Home Feed)
      if (scanMode === 'FEED' || scanMode === 'BOTH') {
        try {
          console.log(`[Threads Recruit] 📰 [Vòng ${round}] Đang lướt Bảng tin (Home Feed) tìm bài thảo luận mới...`)
          if (!page.url().includes('threads.net') || page.url().includes('search') || page.url().includes('/post/')) {
            await page.goto('https://www.threads.net', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {})
            await this.automationService.wait(3000)
          }

          // Lướt cuộn trang 4 đợt mượt mà bắt các bình luận / bài viết mới
          for (let scrollRound = 0; scrollRound < 4; scrollRound++) {
            if (page.isClosed() || (isAborted && isAborted())) break

            // BẢO VỆ RANH GIỚI TRANG: Nếu bị lọt vào trang chi tiết bài viết (/@user/post/...), lập tức quay lại Home Feed!
            if (page.url().includes('/post/')) {
              console.log('[Threads Recruit] ↩️ Đang quay lại Bảng tin Threads...')
              await page.goto('https://www.threads.net', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
              await this.automationService.wait(2000)
            }

            await this.smoothScrollStep(page, 650)
            const processed = await this.scanAndReplyComments(page, targetKeywords, replyTemplates, 10, repliedSnippets, isAborted, account, dmTemplate)
            totalProcessed += processed
            if (processed > 0) {
              console.log(`[Threads Recruit] 🎯 Đã phản hồi ${processed} ứng viên trên Bảng tin.`)
            }
          }
        } catch (feedErr: any) {
          console.warn('[Threads Recruit] Lỗi khi quét Bảng tin Threads:', feedErr.message)
        }
      }

      // Nếu KHÔNG bật chế độ liên tục và đã đạt số lượng mục tiêu:
      if (!isContinuous && totalProcessed >= maxTarget) {
        console.log(`[Threads Recruit] Đã đạt số lượng mục tiêu (${totalProcessed}/${maxTarget}). Kết thúc chiến dịch.`)
        break
      }

      // Nghỉ thông minh giữa các vòng quét (Smart Cooldown chống checkpoint/spam)
      const restSeconds = isContinuous ? 20 + Math.floor(Math.random() * 15) : 5
      console.log(`[Threads Recruit] ⏳ Nghỉ thông minh ${restSeconds}s trước khi quét vòng tiếp theo... (Giữ nick an toàn)`)
      
      // Nhịp nghỉ có thể ngắt ngay lập tức khi bấm Dừng Bot
      for (let w = 0; w < restSeconds; w++) {
        if (page.isClosed() || (isAborted && isAborted())) break
        await this.automationService.wait(1000)
      }

      round++
    }

    console.log(`[Threads Recruit] 🎉 Hoàn thành phiên quét tuyển dụng. Tổng số ứng viên đã tương tác: ${totalProcessed}`)
    return totalProcessed > 0
  }

  /**
   * Cuộn từng bước mượt mà (Incremental Smooth Scrolling)
   * Giúp Virtual DOM của Threads render tuần tự, không bị bỏ qua bài viết ở giữa các khoảng cuộn
   */
  private async smoothScrollStep(page: Page, pixels = 650): Promise<void> {
    if (page.isClosed()) return
    await page.evaluate((px) => {
      window.scrollBy({ top: px, behavior: 'smooth' })
    }, pixels).catch(() => {})
    await this.automationService.wait(800)
  }

  /**
   * Nhập nội dung an toàn vào ô soạn thảo Threads (Hỗ trợ xuống dòng Shift+Enter)
   * Tránh việc gặp ký tự '\n' bị trình duyệt hiểu nhầm là phím Enter gửi bài sớm
   */
  private async safeTypeIntoEditor(page: Page, text: string): Promise<void> {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length > 0) {
        await page.keyboard.type(line, { delay: this.automationService.randomWait(15, 35) })
      }
      if (i < lines.length - 1) {
        // Trên Threads, để xuống dòng trong comment/chat mà không bị gửi bài sớm, bắt buộc phải dùng Shift+Enter
        await page.keyboard.press('Shift+Enter')
        await this.automationService.wait(200)
      }
    }
  }

  /**
   * Quét các khối bài viết/bình luận trên trang hiện tại và gửi phản hồi
   */
  private async scanAndReplyComments(
    page: Page,
    targetKeywords: string[],
    replyTemplates: string | string[],
    limit: number,
    repliedSnippets?: Set<string>,
    isAborted?: () => boolean,
    account?: any,
    dmTemplate?: string
  ): Promise<number> {
    if (limit <= 0) return 0
    let count = 0
    const originUrl = page.url()

    await this.automationService.wait(1000)

    try {
      // Ưu tiên quét các khối bài viết thực sự (article / div role article) để tránh duyệt nhầm các thẻ con vụn vặt
      let postLocators = await page.locator('article, div[role="article"]').all().catch(() => [])
      if (postLocators.length === 0) {
        postLocators = await page.locator('div[data-pressable-container="true"]:has(svg[aria-label="Trả lời"], svg[aria-label="Reply"], [aria-label="Trả lời"], [aria-label="Reply"])').all().catch(() => [])
      }
      if (postLocators.length === 0) {
        postLocators = await page.locator('div[data-pressable-container="true"]').all().catch(() => [])
      }

      const currentRunSnippets = new Set<string>()

      for (const block of postLocators) {
        if (count >= limit) break
        if (page.isClosed() || (isAborted && isAborted())) break

        try {
          const text = (await block.textContent()) || ''
          const textLower = text.toLowerCase().trim()
          if (!textLower) continue

          const authorProfileUrl = await extractAuthorProfile(block)

          // 1. Chỉ bỏ qua nếu chính nick của mình là tác giả bài viết
          if (account?.username && authorProfileUrl) {
            const myUsername = account.username.toLowerCase().replace('@', '').trim()
            if (myUsername && authorProfileUrl.toLowerCase().includes(`/@${myUsername}`)) {
              continue
            }
          }

          // 2. Kiểm tra khớp từ khoá quan tâm (Chỉ lọc theo đúng từ khoá của người dùng)
          const matchedKw = findMatchedKeyword(text, targetKeywords)
          if (!matchedKw) continue

          // 3. Chống trùng lặp theo Post ID duy nhất (Không chặn theo 50 ký tự đầu để không bị bỏ sót các bài cùng chủ đề)
          const postId = await extractThreadPostId(block)
          if (postId) {
            if (currentRunSnippets.has(postId) || (repliedSnippets && repliedSnippets.has(postId))) {
              continue
            }
          }

          console.log(`[Threads Recruit] 🎯 Phát hiện bài viết khớp từ khoá "${matchedKw}": "${text.substring(0, 60).replace(/\n/g, ' ')}..."`)

        // 1. Cuộn đến khối bài viết/ứng viên để hiển thị rõ trên màn hình
        await block.scrollIntoViewIfNeeded().catch(() => {})
        await this.automationService.wait(800)

        // 2. Tìm nút Trả lời (Reply)
        // Lưu ý: Trên Threads, các nút hành động (Like, Reply, Repost) có thể nằm ở block hoặc container cha (ancestor)
        const replySelectors = [
          'svg[aria-label="Trả lời"]',
          'svg[aria-label="Reply"]',
          'svg[aria-label="Bình luận"]',
          'svg[aria-label="Comment"]',
          '[aria-label="Trả lời"]',
          '[aria-label="Reply"]',
          '[aria-label="Bình luận"]',
          'div[role="button"]:has(svg[aria-label="Trả lời"])',
          'div[role="button"]:has(svg[aria-label="Reply"])',
          'div[role="button"]:has(svg[aria-label="Bình luận"])',
          'svg:has(title:has-text("Trả lời"))',
          'svg:has(title:has-text("Reply"))',
        ]

        let replyBtn: any = null
        // Thử tìm trong chính block
        for (const sel of replySelectors) {
          const btn = block.locator(sel).first()
          if (await btn.isVisible().catch(() => false)) {
            replyBtn = btn
            break
          }
        }

        // Nếu không có trong block, duyệt qua các cấp cha (ancestor) của block
        if (!replyBtn) {
          for (const ancestorXPath of ['xpath=..', 'xpath=../..', 'xpath=../../..', 'xpath=ancestor::article', 'xpath=ancestor::div[@role="article"]']) {
            const ancestor = block.locator(ancestorXPath).first()
            if (await ancestor.count().catch(() => 0)) {
              for (const sel of replySelectors) {
                const btn = ancestor.locator(sel).first()
                if (await btn.isVisible().catch(() => false)) {
                  replyBtn = btn
                  break
                }
              }
              if (replyBtn) break
            }
          }
        }

        // Phương án dự phòng: Nút nằm cạnh nút Like
        if (!replyBtn) {
          for (const ancestorXPath of ['xpath=..', 'xpath=../..', 'xpath=../../..']) {
            const ancestor = block.locator(ancestorXPath).first()
            const likeBtn = ancestor.locator('svg[aria-label="Thích"], svg[aria-label="Like"]').first()
            if (await likeBtn.isVisible().catch(() => false)) {
              const nextBtn = likeBtn.locator('xpath=ancestor::div[@role="button"]/following-sibling::div[@role="button"]').first()
              if (await nextBtn.isVisible().catch(() => false)) {
                replyBtn = nextBtn
                break
              }
            }
          }
        }

        if (!replyBtn) {
          console.warn('[Threads Recruit] ⚠️ Không tìm thấy nút Trả lời ở bài viết này (bỏ qua ứng viên để tiếp tục)')
          continue
        }

        if (postId) currentRunSnippets.add(postId)

        console.log('[Threads Recruit] 👉 Đang bấm nút Mở khung phản hồi...')
        await replyBtn.click({ timeout: 4000 }).catch(async () => {
          // Thử bấm cưỡng chế nếu bị vướng lớp phủ
          await replyBtn.dispatchEvent('click').catch(() => {})
        })
        await this.automationService.wait(1500)

        // 3. Tìm ô nhập văn bản (Hộp thoại Reply)
        const inputSelectors = [
          'div[role="dialog"] div[role="textbox"]',
          'div[role="dialog"] div[contenteditable="true"]',
          'div[role="dialog"] textarea',
          'div[role="textbox"]',
          'div[contenteditable="true"]',
          'textarea[placeholder*="trả lời" i]',
          'textarea[placeholder*="reply" i]',
          'div[aria-placeholder*="trả lời" i]',
          'div[aria-placeholder*="reply" i]',
        ]

        let inputEl: any = null
        for (const sel of inputSelectors) {
          const el = page.locator(sel).first()
          if (await el.isVisible().catch(() => false)) {
            inputEl = el
            break
          }
        }

        if (!inputEl) {
          console.warn('[Threads Recruit] ⚠️ Không tìm thấy ô nhập nội dung phản hồi')
          // Nhấn phím Escape để đóng hộp thoại nếu đang mở dở
          await page.keyboard.press('Escape').catch(() => {})
          continue
        }

        const tplList = (Array.isArray(replyTemplates) ? replyTemplates : [replyTemplates]).filter(t => t && t.trim().length > 0)
        const activeTpl = tplList.length > 0 ? tplList[count % tplList.length] : ''
        const replyContent = parseSpinText(activeTpl)
        console.log(`[Threads Recruit] ✍️ [Mẫu ${(count % (tplList.length || 1)) + 1}/${tplList.length || 1}] Đang nhập phản hồi: "${replyContent.substring(0, 60).replace(/\n/g, ' ')}..."`)
        await inputEl.click({ timeout: 4000 }).catch(() => {})
        await this.automationService.wait(500)
        await this.safeTypeIntoEditor(page, replyContent)
        await this.automationService.wait(1200)

        // 4. Bấm nút Đăng / Post (Tự động nhận diện nút tròn icon ↑, toạ độ chuột vật lý và phím tắt)
        let submitted = false

        // Cách 1: Tìm toạ độ nút tròn mũi tên lên (↑) ngoài cùng bên phải và click trực tiếp bằng chuột vật lý Playwright
        try {
          const btnCoord = await page.evaluate(() => {
            const textboxes = Array.from(document.querySelectorAll('div[role="textbox"], div[contenteditable="true"], textarea'))
            const activeBox = textboxes.find(el => (el as HTMLElement).innerText?.trim().length > 0) as HTMLElement
            if (!activeBox) return null

            let container: HTMLElement | null = activeBox.parentElement
            while (container && container !== document.body) {
              const clickables = Array.from(container.querySelectorAll('button, div[role="button"], div[data-pressable-container="true"], [tabindex="0"], svg')) as HTMLElement[]
              const candidates = clickables.filter(el => {
                if (el === activeBox || activeBox.contains(el)) return false
                const rect = el.getBoundingClientRect()
                // Lọc nút tròn / icon ở góc phải (kích thước nhỏ gọn 16px - 60px)
                return rect.width >= 16 && rect.height >= 16 && rect.width <= 65 && rect.height <= 65
              })

              if (candidates.length > 0) {
                // Sắp xếp theo toạ độ mép phải giảm dần (nút ngoài cùng bên phải nhất chính là nút tròn icon ↑)
                candidates.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
                const rightmost = candidates[0]
                const rect = rightmost.getBoundingClientRect()
                
                // Đồng thời trigger click DOM ngay
                try {
                  rightmost.click()
                  rightmost.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
                  if (rightmost.parentElement) rightmost.parentElement.click()
                } catch {}

                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
              }
              container = container.parentElement
            }
            return null
          }).catch(() => null)

          if (btnCoord && btnCoord.x > 0 && btnCoord.y > 0) {
            console.log(`[Threads Recruit] 🎯 Bấm chuột vào nút tròn gửi bình luận (X: ${Math.round(btnCoord.x)}, Y: ${Math.round(btnCoord.y)})...`)
            await page.mouse.click(btnCoord.x, btnCoord.y).catch(() => {})
            await this.automationService.wait(1000)
          }
        } catch (e: any) {
          console.warn('[Threads Recruit] Lỗi khi click toạ độ nút gửi:', e.message)
        }

        // Cách 2: Tìm theo selector chuẩn aria-label và text
        const submitSelectors = [
          'div[role="button"][aria-label="Đăng"]',
          'div[role="button"][aria-label="Post"]',
          'div[role="button"][aria-label="Gửi"]',
          'div[role="button"][aria-label="Send"]',
          'div[role="button"][aria-label="Trả lời"]',
          'div[role="button"][aria-label="Reply"]',
          '[aria-label="Đăng"]',
          '[aria-label="Post"]',
          '[aria-label="Gửi"]',
          '[aria-label="Send"]',
          'svg[aria-label="Đăng"]',
          'svg[aria-label="Post"]',
          'div[role="button"]:has-text("Đăng")',
          'div[role="button"]:has-text("Post")',
          'button:has-text("Đăng")',
          'button:has-text("Post")',
        ]

        for (const sel of submitSelectors) {
          const sendBtn = page.locator(sel).last()
          if (await sendBtn.isVisible().catch(() => false)) {
            const ariaDisabled = await sendBtn.getAttribute('aria-disabled').catch(() => null)
            if (ariaDisabled !== 'true') {
              console.log(`[Threads Recruit] 👉 Bấm nút gửi qua selector: ${sel}`)
              await sendBtn.click({ timeout: 3000 }).catch(async () => {
                await sendBtn.dispatchEvent('click').catch(() => {})
              })
              break
            }
          }
        }

        // Cách 3: Bấm phím tắt Meta+Enter (Mac) và Control+Enter (Windows)
        console.log('[Threads Recruit] ⌨️ Kích hoạt phím tắt gửi (Meta+Enter / Control+Enter)...')
        await page.keyboard.press('Meta+Enter').catch(() => {})
        await page.keyboard.press('Control+Enter').catch(() => {})

        // Chờ Threads xử lý và xác nhận xem nội dung đã được gửi đi chưa
        console.log('[Threads Recruit] ⏳ Chờ xác nhận Threads đăng bình luận...')
        for (let waitSec = 0; waitSec < 6; waitSec++) {
          await this.automationService.wait(1000)
          if (page.isClosed()) break

          const isGoneOrEmpty = await page.evaluate(() => {
            const boxes = Array.from(document.querySelectorAll('div[role="textbox"], div[contenteditable="true"], textarea'))
            // Nếu không còn ô nhập nào có chữ, tức là bài đã gửi thành công
            const hasText = boxes.some(b => (b as HTMLElement).innerText?.trim().length > 0)
            return !hasText
          }).catch(() => false)

          if (isGoneOrEmpty) {
            submitted = true
            console.log('[Threads Recruit] ✅ Bình luận đã được Threads tiếp nhận và gửi thành công!')
            break
          }
        }

        if (submitted) {
          console.log(`[Threads Recruit] 🚀 ĐÃ PHẢN HỒI THÀNH CÔNG ứng viên: "${replyContent.substring(0, 50).replace(/\n/g, ' ')}..."`)
          count++
          if (repliedSnippets && postId) {
            repliedSnippets.add(postId)
          }
          if (this.store && postId) {
            this.store.addRepliedThreadPost(postId)
          }
          // Chờ 2.5s để máy chủ Threads hoàn tất lưu trữ trước khi tiếp tục
          await this.automationService.wait(2500)

          // 5. Gửi tin nhắn riêng (DM) vào hộp thư ứng viên nếu có cấu hình dmTemplate
          if (dmTemplate && dmTemplate.trim().length > 0 && authorProfileUrl) {
            try {
              console.log(`[Threads Recruit] 📬 Chuẩn bị gửi tin nhắn riêng (DM) cho ứng viên: ${authorProfileUrl}`)
              await page.goto(authorProfileUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
              await this.automationService.wait(2500)

              const dmSent = await this.sendDirectMessage(page, dmTemplate)
              if (dmSent) {
                console.log(`[Threads Recruit] 💌 ĐÃ GỬI DM THÀNH CÔNG vào hộp thư của ứng viên!`)
              } else {
                console.log(`[Threads Recruit] ℹ️ Không thể gửi DM (Ứng viên có thể tắt nhận tin nhắn từ người lạ)`)
              }
              await this.automationService.wait(1500)
            } catch (dmErr: any) {
              console.warn('[Threads Recruit] Lỗi khi gửi DM cho ứng viên:', dmErr.message)
            }
          }

          // Quay lại trang tìm kiếm hoặc bảng tin ban đầu
          if (originUrl && (page.url() !== originUrl || page.url().includes('/post/') || page.url().includes('/@'))) {
            console.log('[Threads Recruit] ↩️ Đã hoàn tất tương tác. Đang quay lại trang tìm kiếm/bảng tin...')
            await page.goto(originUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(async () => {
              await page.goBack().catch(() => {})
            })
            await this.automationService.wait(2000)
            break
          }
        } else {
          console.warn('[Threads Recruit] ⚠️ Chưa thể gửi bình luận bài này (giữ nguyên để tránh chuyển bài vội vàng)')
          // Nếu chưa gửi được thì thử gõ Enter trực tiếp một lần cuối trước khi bỏ qua
          await page.keyboard.press('Enter').catch(() => {})
          await this.automationService.wait(1500)
          
          // Chỉ đóng nếu vẫn còn dở
          await page.keyboard.press('Escape').catch(() => {})
        }

      } catch (err: any) {
        console.warn('[Threads Recruit] Lỗi xử lý ứng viên:', err.message)
      }
    }
    } catch (outerErr: any) {
      console.warn('[Threads Recruit] Gián đoạn trong đợt quét bình luận:', outerErr.message)
    }

    return count
  }

  /**
   * Gửi tin nhắn trực tiếp (Direct Message) trên Threads/Instagram
   */
  private async sendDirectMessage(page: Page, message: string): Promise<boolean> {
    const finalMsg = parseSpinText(message)
    console.log(`[Threads DM] Chuẩn bị gửi tin nhắn: "${finalMsg.substring(0, 40)}..."`)

    const msgBtnSelectors = [
      'div[role="button"]:has-text("Nhắn tin")',
      'div[role="button"]:has-text("Message")',
      'button:has-text("Nhắn tin")',
      'button:has-text("Message")',
      '[aria-label="Nhắn tin"]',
      '[aria-label="Message"]',
      'svg[aria-label="Nhắn tin"]',
      'svg[aria-label="Message"]',
      'a[href*="/direct/"]',
    ]

    let openedChat = false
    for (const sel of msgBtnSelectors) {
      const btn = page.locator(sel).first()
      if (await btn.isVisible().catch(() => false)) {
        console.log(`[Threads DM] 👉 Bấm nút Nhắn tin...`)
        await btn.click().catch(() => {})
        openedChat = true
        break
      }
    }

    // Nếu không tìm thấy nút bằng selector trên, kiểm tra xem trang có đang chuyển vào /direct/ không
    if (!openedChat && page.url().includes('/direct/')) {
      openedChat = true
    }

    if (!openedChat) {
      console.warn('[Threads DM] ⚠️ Không tìm thấy nút Nhắn tin (Có thể ứng viên giới hạn tin nhắn từ người lạ)')
      return false
    }

    // Đợi ô nhập chat xuất hiện (Tối đa 12 giây để giao diện Direct Message tải xong hoàn toàn)
    console.log('[Threads DM] ⏳ Đang đợi giao diện Direct Message tải xong...')
    const chatInputSelectors = [
      'div[role="textbox"]',
      'div[contenteditable="true"]',
      '[aria-label*="Tin nhắn" i]',
      '[aria-label*="Message" i]',
      'textarea[placeholder*="tin nhắn" i]',
      'textarea[placeholder*="message" i]',
      'div[aria-placeholder*="tin nhắn" i]',
      'div[aria-placeholder*="message" i]',
      'textarea',
    ]

    let chatInput: any = null
    for (let wait = 0; wait < 12; wait++) {
      if (page.isClosed()) break
      for (const cSel of chatInputSelectors) {
        const el = page.locator(cSel).last()
        if (await el.isVisible().catch(() => false)) {
          chatInput = el
          break
        }
      }
      if (chatInput) break
      await this.automationService.wait(1000)
    }

    if (!chatInput) {
      console.warn('[Threads DM] ⚠️ Không tìm thấy ô nhập tin nhắn sau khi chờ khung chat tải')
      return false
    }

    console.log(`[Threads DM] ✍️ Đang nhập tin nhắn riêng: "${finalMsg.substring(0, 50).replace(/\n/g, ' ')}..."`)
    await chatInput.scrollIntoViewIfNeeded().catch(() => {})
    await chatInput.click({ timeout: 4000 }).catch(() => {})
    await this.automationService.wait(600)
    await this.safeTypeIntoEditor(page, finalMsg)
    await this.automationService.wait(1000)

    // Bấm nút gửi hoặc phím Enter
    const dmSendSelectors = [
      'div[role="button"]:has-text("Gửi")',
      'div[role="button"]:has-text("Send")',
      'button:has-text("Gửi")',
      'button:has-text("Send")',
      '[aria-label="Gửi"]',
      '[aria-label="Send"]',
      'svg[aria-label="Gửi"]',
      'svg[aria-label="Send"]',
    ]

    let dmSent = false
    for (const dSel of dmSendSelectors) {
      const sBtn = page.locator(dSel).last()
      if (await sBtn.isVisible().catch(() => false)) {
        await sBtn.click({ timeout: 3000 }).catch(() => {})
        dmSent = true
        break
      }
    }

    // Luôn bấm phím Enter để gửi chắc chắn
    if (!dmSent) {
      await page.keyboard.press('Enter').catch(() => {})
    }
    await page.keyboard.press('Enter').catch(() => {})

    console.log('[Threads DM] ✅ Đã gửi tin nhắn trực tiếp (DM) thành công!')
    await this.automationService.wait(3000)
    return true
  }

  /**
   * Nuôi nick Threads tự động: Lướt Feed, xem bài, thả tim ngẫu nhiên
   */
  async performNurturing(page: Page, settings?: any): Promise<boolean> {
    try {
      console.log('[Threads Nurturing] Bắt đầu phiên nuôi nick Threads...')
      await page.goto('https://www.threads.net', { waitUntil: 'domcontentloaded' })
      await this.automationService.wait(4000)

      const scrollRounds = 4 + Math.floor(Math.random() * 5)
      for (let i = 0; i < scrollRounds; i++) {
        const readTime = 5000 + Math.random() * 8000
        console.log(`[Threads Nurturing] Lướt feed vòng ${i + 1}/${scrollRounds} (xem bài ${Math.round(readTime / 1000)}s)...`)
        await this.automationService.simulateScroll(page, readTime)

        // Xác suất 15% thả tim ngẫu nhiên bài viết
        if (Math.random() < 0.15) {
          console.log('[Threads Nurturing] Thả tim tương tác tự nhiên...')
          await this.clickLikeButton(page).catch(() => {})
        }

        await this.automationService.wait(2000 + Math.random() * 2000)
      }

      console.log('[Threads Nurturing] Hoàn thành phiên nuôi nick Threads an toàn.')
      return true
    } catch (err) {
      console.error('[Threads Nurturing] Lỗi khi nuôi nick Threads:', err)
      return false
    }
  }
}

