import { Page } from 'playwright'
import { AutomationService } from '../automation.service'
import { SelfHealingService } from '../self-healing.service'
import { IPlatformExecutor } from './platform-executor.interface'

export class TikTokExecutor implements IPlatformExecutor {
  readonly platform = 'TIKTOK'

  constructor(
    private readonly automationService: AutomationService,
    private readonly selfHealingService: SelfHealingService,
  ) {}

  /** Tự động đóng các popup mời tải app / đăng nhập / cookie của TikTok nếu xuất hiện */
  private async dismissPopups(page: Page): Promise<void> {
    try {
      const closeSelectors = [
        '[data-e2e="modal-close-inner-button"]',
        'div[aria-label="Close"]',
        'button[aria-label="Close"]',
        'button:has-text("Không phải bây giờ")',
        'button:has-text("Not now")',
        'button:has-text("Hủy")',
        'button:has-text("Cancel")',
        'button:has-text("Để sau")',
        'div[role="dialog"] button:has-text("✕")',
      ]
      for (const sel of closeSelectors) {
        const btn = page.locator(sel).first()
        if (await btn.isVisible().catch(() => false)) {
          await btn.click().catch(() => {})
          await this.automationService.wait(400)
        }
      }
    } catch {}
  }

  async performAction(page: Page, task: any, account?: any): Promise<boolean | string> {
    try {
      await this.dismissPopups(page)
      const actionType = typeof task === 'string' ? task : task.campaign?.actionType || task.actionType;
      const metadata = task?.campaign?.metadata || task?.metadata || {}

      switch (actionType) {
        case 'VIEW_VIDEO': {
          const duration = metadata.durationSeconds ? metadata.durationSeconds * 1000 : 15_000
          return await this.simulateWatchVideo(page, duration)
        }

        case 'VIEW_LIVE': {
          const liveDuration = metadata.liveDurationSeconds 
            ? metadata.liveDurationSeconds * 1000 
            : (metadata.durationMinutes ? metadata.durationMinutes * 60 * 1000 : 30_000)
          return await this.simulateWatchLive(page, liveDuration)
        }

        case 'LIKE':
          return await this.clickLikeButton(page)

        case 'FOLLOW':
          return await this.clickFollowButton(page)

        case 'COMMENT': {
          const commentText = metadata.commentText || metadata.content || 'Tuyệt vời ạ!'
          return await this.postComment(page, commentText)
        }

        default:
          console.warn(`[TikTok] Không hỗ trợ actionType: ${actionType}`)
          return false
      }
    } catch (err) {
      console.error('[TikTok] performAction error:', err)
      return false
    }
  }

  private async simulateWatchVideo(page: Page, durationMs: number): Promise<boolean> {
    console.log(`[TikTok Video] Bắt đầu xem video trong ${Math.round(durationMs / 1000)}s...`)
    await this.automationService.simulateScroll(page, 1500)
    await this.automationService.wait(durationMs)
    return true
  }

  private async simulateWatchLive(page: Page, durationMs: number): Promise<boolean> {
    console.log(`[TikTok Live] Đang xem live trong ${Math.round(durationMs / 1000)}s...`)
    const startTime = Date.now()
    await this.dismissPopups(page)

    // Nhấp vào khung video livestream để kích hoạt âm thanh / stream
    await page.mouse.click(400, 300).catch(() => {})

    while (Date.now() - startTime < durationMs) {
      if (page.isClosed()) break
      // Tap tim ngẫu nhiên vào livestream mỗi 4-7 giây để duy trì heartbeat & gửi tín hiệu mắt thật
      await this.automationService.wait(4000 + Math.random() * 3000)
      if (page.isClosed()) break

      // Nhấp đúp tap tim vào video
      const x = 300 + Math.floor(Math.random() * 150)
      const y = 250 + Math.floor(Math.random() * 150)
      await page.mouse.click(x, y).catch(() => {})
      if (Math.random() < 0.6) {
        await this.automationService.wait(150)
        await page.mouse.click(x, y).catch(() => {})
      }
    }
    return true
  }

  private async clickLikeButton(page: Page): Promise<boolean> {
    await this.dismissPopups(page)
    await this.automationService.simulateScroll(page, 2000)

    const likeSelectors = [
      '[data-e2e="like-icon"]',
      '[data-e2e="browse-like-icon"]',
      '[aria-label="Like video"]',
      '[aria-label="Thích video"]',
      'button:has([data-e2e="like-icon"])',
    ]

    for (const selector of likeSelectors) {
      const clicked = await this.automationService.simulateHumanClick(page, selector)
      if (clicked) {
        await this.automationService.wait(1000)
        return true
      }
    }
    return false
  }

  private async clickFollowButton(page: Page): Promise<boolean> {
    await this.dismissPopups(page)
    await this.automationService.simulateScroll(page, 1500)

    // Nếu đã theo dõi rồi thì không click lại tránh unfollow
    const alreadyFollowedSelectors = [
      'button:has-text("Đang theo dõi")',
      'button:has-text("Following")',
      'button:has-text("Bạn bè")',
      'button:has-text("Friends")',
      'button[data-e2e="user-page-follow-button"]:has-text("Following")',
    ]
    for (const sel of alreadyFollowedSelectors) {
      const el = page.locator(sel).first()
      if (await el.isVisible().catch(() => false)) {
        console.log('[TikTok] Tài khoản này đã được Follow trước đó!')
        return true
      }
    }

    const followSelectors = [
      'button[data-e2e="follow-button"]',
      'button[data-e2e="user-page-follow-button"]',
      'button:has-text("Theo dõi")',
      'button:has-text("Follow")',
    ]

    for (const selector of followSelectors) {
      const clicked = await this.automationService.simulateHumanClick(page, selector)
      if (clicked) {
        await this.automationService.wait(1500)
        return true
      }
    }
    return false
  }

  private async postComment(page: Page, text: string): Promise<boolean> {
    await this.dismissPopups(page)
    const commentInputSelectors = [
      '[data-e2e="comment-input"]',
      'div[contenteditable="true"]',
      'div[role="textbox"]',
      'input[placeholder*="comment" i]',
      'input[placeholder*="bình luận" i]',
    ]

    for (const selector of commentInputSelectors) {
      const el = page.locator(selector).first()
      if (await el.isVisible().catch(() => false)) {
        await el.click().catch(() => {})
        await this.automationService.wait(500)
        await page.keyboard.insertText(text).catch(() => {})
        await this.automationService.wait(800)
        await page.keyboard.press('Enter').catch(() => {})

        const postBtn = page.locator('[data-e2e="comment-post"]').first()
        if (await postBtn.isVisible().catch(() => false)) {
          await postBtn.click().catch(() => {})
        }
        await this.automationService.wait(1500)
        return true
      }
    }
    return false
  }

  async performNurturing(page: Page, settings?: any): Promise<boolean> {
    try {
      console.log('[TikTok Nurturing] Bắt đầu nuôi nick TikTok...');
      await page.goto('https://www.tiktok.com/foryou', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await this.dismissPopups(page);
      await this.automationService.wait(4000 + Math.random() * 2000);
      
      const videoCount = 3 + Math.floor(Math.random() * 4);
      
      for (let i = 0; i < videoCount; i++) {
        if (page.isClosed()) break;
        const watchTime = 10000 + Math.random() * 15000;
        console.log(`[TikTok Nurturing] Đang xem video ${i+1}/${videoCount} trong ${Math.round(watchTime/1000)}s...`);
        
        await this.automationService.wait(watchTime);
        await this.dismissPopups(page);
        
        if (Math.random() < 0.25) {
           console.log('[TikTok Nurturing] Thả tim ngẫu nhiên...');
           await this.clickLikeButton(page);
        }
        
        console.log('[TikTok Nurturing] Cuộn xuống video tiếp theo...');
        await page.keyboard.press('ArrowDown');
        
        await this.automationService.wait(2000 + Math.random() * 2000);
      }

      console.log('[TikTok Nurturing] Hoàn tất phiên nuôi.');
      return true;
    } catch (e) {
      console.error('[TikTok Nurturing] Lỗi:', e);
      return false;
    }
  }
}
