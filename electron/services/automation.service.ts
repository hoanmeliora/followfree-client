import { Page, Locator } from 'playwright'

export class AutomationService {
  /**
   * Tạm dừng trong một khoảng thời gian (ms)
   */
  async wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Trả về thời gian ngẫu nhiên giữa min và max
   */
  randomWait(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1) + min)
  }

  /**
   * Cuộn trang mượt mà lên/xuống ngẫu nhiên giống người thật
   */
  async simulateScroll(page: Page, durationMs: number = 3000) {
    let startTime = Date.now()
    let scrollDirection = 1

    while (Date.now() - startTime < durationMs) {
      if (Math.random() > 0.8) scrollDirection *= -1
      
      const step = scrollDirection * (Math.random() * 200 + 50)
      await page.mouse.wheel(0, step)
      
      await this.wait(400)
    }
  }

  /**
   * Giả lập click chuột thật
   */
  async simulateHumanClick(page: Page, selector: string, options?: { index?: number | 'last' | 'smallest' }): Promise<boolean> {
    try {
      const locators = await page.locator(selector).all()
      if (locators.length === 0) return false

      let targets = locators;
      if (options?.index === 'last') {
        targets = [locators[locators.length - 1]];
      } else if (typeof options?.index === 'number') {
        targets = [locators[options.index]];
      }

      let validTarget: Locator | null = null;
      let validBox: any = null;

      for (const target of targets) {
          if (!(await target.isVisible())) continue;

          await target.scrollIntoViewIfNeeded().catch(() => {});
          await this.wait(300);

          // Kiểm tra xem phần tử có bị che khuất không (ví dụ: bị Modal hình ảnh đè lên)
          try {
              await target.click({ trial: true, timeout: 500 });
              // Nếu không ném ra lỗi -> Phần tử này hoàn toàn có thể click được!
              const box = await target.boundingBox();
              if (box) {
                  validTarget = target;
                  validBox = box;
                  break; // Tìm thấy mục tiêu ngon lành rồi thì dừng
              }
          } catch (e) {
              // Bị che khuất, bỏ qua và thử target tiếp theo
              continue;
          }
      }

      if (!validTarget || !validBox) return false;

      const x = validBox.x + validBox.width / 2
      const y = validBox.y + validBox.height / 2

      await page.mouse.move(x, y, { steps: 10 })
      await this.wait(this.randomWait(100, 300))
      await page.mouse.click(x, y, { delay: this.randomWait(50, 150) })

      return true
    } catch (e) {
      console.warn('Simulate click error:', e)
      return false
    }
  }

  /**
   * Giả lập gõ phím từ từ
   */
  async typeText(page: Page, selector: string, text: string): Promise<boolean> {
    const clicked = await this.simulateHumanClick(page, selector)
    if (!clicked) return false

    await this.wait(500)
    await page.keyboard.type(text, { delay: this.randomWait(50, 150) })
    return true
  }
}
