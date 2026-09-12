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

  async performAction(page: Page, task: any, account?: any): Promise<boolean | string> {
    try {
      const actionType = typeof task === 'string' ? task : task.campaign.actionType;
      switch (actionType) {
        case 'VIEW_VIDEO':
          return await this.simulateWatch(page, 15_000)

        case 'VIEW_LIVE':
          return await this.simulateWatch(page, 30_000)

        case 'LIKE':
          return await this.clickLikeButton(page)

        case 'FOLLOW':
          return await this.clickFollowButton(page)

        default:
          console.warn(`[TikTok] Không hỗ trợ actionType: ${actionType}`)
          return false
      }
    } catch (err) {
      console.error('[TikTok] performAction error:', err)
      return false
    }
  }

  private async simulateWatch(page: Page, durationMs: number): Promise<boolean> {
    await this.automationService.simulateScroll(page, durationMs)
    return true
  }

  private async clickLikeButton(page: Page): Promise<boolean> {
    await this.automationService.simulateScroll(page, 2000)

    const likeSelectors = [
      '[data-e2e="like-icon"]',
      '[data-e2e="browse-like-icon"]',
      '[aria-label="Like video"]'
    ]

    for (const selector of likeSelectors) {
      const clicked = await this.automationService.simulateHumanClick(page, selector)
      if (clicked) return true
    }
    return false
  }

  private async clickFollowButton(page: Page): Promise<boolean> {
    await this.automationService.simulateScroll(page, 1500)

    const followSelectors = [
      '[data-e2e="follow-button"]',
      '[data-e2e="user-page-follow-button"]'
    ]

    for (const selector of followSelectors) {
      const clicked = await this.automationService.simulateHumanClick(page, selector)
      if (clicked) return true
    }
    return false
  }

  async performNurturing(page: Page): Promise<boolean> {
    try {
      console.log('[TikTok Nurturing] Bắt đầu nuôi nick TikTok...');
      await page.goto('https://www.tiktok.com/foryou');
      await this.automationService.wait(5000 + Math.random() * 2000);
      
      const videoCount = 3 + Math.floor(Math.random() * 4);
      
      for (let i = 0; i < videoCount; i++) {
        const watchTime = 10000 + Math.random() * 15000;
        console.log(`[TikTok Nurturing] Đang xem video ${i+1}/${videoCount} trong ${Math.round(watchTime/1000)}s...`);
        
        await this.automationService.wait(watchTime);
        
        if (Math.random() < 0.1) {
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
