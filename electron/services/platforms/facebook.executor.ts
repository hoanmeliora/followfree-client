import { Page } from 'playwright'
import { AutomationService } from '../automation.service'
import { SelfHealingService } from '../self-healing.service'
import { IPlatformExecutor } from './platform-executor.interface'

export class FacebookExecutor implements IPlatformExecutor {
  readonly platform = 'FACEBOOK'

  // Trạng thái cày theo lô (Batching) của các Page thuộc từng Account
  private accountPageState: Record<string, { mainAccountName: string | null, pageIndex: number, tasksDone: number, maxTasks: number }> = {};

  constructor(
    private readonly automationService: AutomationService,
    private readonly selfHealingService: SelfHealingService,
  ) {}

  async performAction(page: Page, task: any, account?: any): Promise<boolean | string> {
    try {
      const accountId = account?.id || 'default';
      // 1. Tráo đổi thân phận: Chuyển sang tư cách Page để làm bia đỡ đạn
      await this.switchToPageContext(page, accountId);

      // 2. Chuyển Page xong Facebook thường văng về Home, nên phải vào lại Target URL
      if (task.campaign.actionType !== 'SHARE_GROUP' && task.campaign.actionType !== 'POST_GROUP') {
        console.log(`[Facebook] Điều hướng lại tới URL mục tiêu: ${task.campaign.targetUrl}`);
        await page.goto(task.campaign.targetUrl, { waitUntil: 'domcontentloaded' });
        await this.automationService.wait(4000);
      }

      const actionType = task.campaign.actionType;
      switch (actionType) {
        case 'LIKE':
          return await this.clickLikeButton(page)

        case 'LOVE':
        case 'HAHA':
        case 'WOW':
        case 'SAD':
        case 'ANGRY':
          return await this.clickReactionButton(page, actionType)

        case 'FOLLOW':
          return await this.clickFollowButton(page)

        case 'SHARE_GROUP':
          return await this.shareToGroup(page, task, accountId)

        case 'POST_GROUP':
          return await this.postToGroup(page, task, accountId)

        case 'COMMENT':
          console.warn('[Facebook] COMMENT chưa được implement')
          return false

        default:
          console.warn(`[Facebook] Không hỗ trợ actionType: ${actionType}`)
          return false
      }
    } catch (err) {
      console.error('[Facebook] performAction error:', err)
      return false
    }
  }

  private async switchToPageContext(page: Page, accountId: string = 'default'): Promise<boolean> {
    try {
      console.log(`[Facebook] Đang kiểm tra và tráo đổi sang tư cách Page (Account: ${accountId})...`);
      
      // Bấm vào Menu Account (Góc trên phải)
      const accountBtnSelectors = [
        'svg[aria-label="Tài khoản"]',
        'svg[aria-label="Account"]',
        'svg[aria-label^="Trang cá nhân"]',
        'div[aria-label="Tài khoản"][role="button"]',
        'div[aria-label="Account"][role="button"]',
        'image' // Nút avatar góc trên cùng thường là SVG chứa thẻ image
      ];
      
      let accountBtnClicked = false;
      for (const sel of accountBtnSelectors) {
         if (await this.automationService.simulateHumanClick(page, sel)) {
            accountBtnClicked = true;
            break;
         }
      }

      if (!accountBtnClicked) {
         console.log('[Facebook] Không tìm thấy nút Avatar Menu (Account). Có thể do chưa đăng nhập hoặc đổi UI!');
         return false;
      }
      
      await this.automationService.wait(2000);

      // Tìm nút "Xem tất cả trang cá nhân"
      const seeAllBtn = page.locator('div[role="button"]').filter({ hasText: /Xem tất cả trang cá nhân|See all profiles/i });
      if (await seeAllBtn.isVisible()) {
          await seeAllBtn.click();
          await this.automationService.wait(1500);
      }
      
      // Đợi Menu mở ra
      await this.automationService.wait(2000);
      
      // CHIẾN THUẬT SIÊU CHUẨN: Chỉ quét bên trong cái Modal (Menu) vừa bật ra
      // Các Modal của Facebook luôn có role="dialog" hoặc role="menu"
      const textSpans = await page.locator('div[role="dialog"] span[dir="auto"], div[role="menu"] span[dir="auto"]').all();
      
      const validProfiles: any[] = [];
      if (textSpans.length > 0) {
          for (const span of textSpans) {
              if (await span.isVisible()) {
                  const text = await span.textContent();
                  if (text && text.trim().length > 0 && text.trim().length < 60) {
                      const t = text.toLowerCase();
                      if (!t.includes('thông báo') && !t.includes('cài đặt') && !t.includes('đăng xuất') && !t.includes('trợ giúp') && !t.includes('xem tất cả') && !t.includes('quảng cáo')) {
                          validProfiles.push(span);
                      }
                  }
              }
          }
      } else {
          console.log('[Facebook] Không tìm thấy Text nào trong Menu, Facebook có thể đã đổi cấu trúc HTML.');
      }
      
      // Lọc trùng lặp
      const uniqueProfiles: any[] = [];
      const seenTexts = new Set();
      for (const p of validProfiles) {
          const t = (await p.textContent())?.trim();
          if (t && !seenTexts.has(t)) {
              seenTexts.add(t);
              uniqueProfiles.push(p);
          }
      }

      if (uniqueProfiles.length > 1) {
          let state = this.accountPageState[accountId];
          
          if (!state) {
              console.log('[Facebook] Lần đầu khởi tạo Account: Đang xác minh danh tính Nick chính...');
              // Đóng menu avatar để điều hướng
              await page.keyboard.press('Escape');
              await this.automationService.wait(1000);
              
              // Thử vào link tạo Page. Chỉ Nick chính mới vào được.
              await page.goto('https://www.facebook.com/pages/creation/', { waitUntil: 'domcontentloaded' });
              await this.automationService.wait(3000);
              const isPage = await page.getByText(/Bạn hiện không xem được nội dung này|This content isn't available right now/i).isVisible();
              
              let mainName = '';
              if (isPage) {
                  console.log('[Facebook] Trình duyệt đang kẹt ở thân phận Page. Đang tráo đổi về Nick chính để lấy gốc...');
                  await page.goto('https://www.facebook.com/');
                  await this.automationService.wait(3000);
                  
                  // Mở menu và chọn index 1 (vì khi ở Page, Nick chính luôn ở index 1)
                  await this.automationService.simulateHumanClick(page, 'svg[aria-label="Trang cá nhân của bạn"], svg[aria-label="Your profile"]', { index: 'last' });
                  await this.automationService.wait(1500);
                  await this.automationService.wait(2000);
                  
                  const textSpans2 = await page.locator('div[role="dialog"] span[dir="auto"], div[role="menu"] span[dir="auto"]').all();
                  const valids: any[] = [];
                  if (textSpans2.length > 0) {
                      for (const span of textSpans2) {
                          if (await span.isVisible()) {
                              const text = await span.textContent();
                              if (text && text.trim().length > 0 && text.trim().length < 60) {
                                  const t = text.toLowerCase();
                                  if (!t.includes('thông báo') && !t.includes('cài đặt') && !t.includes('đăng xuất') && !t.includes('trợ giúp') && !t.includes('xem tất cả') && !t.includes('quảng cáo')) {
                                      valids.push(span);
                                  }
                              }
                          }
                      }
                  }
                  
                  const uniqueValids: any[] = [];
                  const seenT = new Set();
                  for (const p of valids) {
                      const t = (await p.textContent())?.trim();
                      if (t && !seenT.has(t)) {
                          seenT.add(t);
                          uniqueValids.push(p);
                      }
                  }
                  
                  if (uniqueValids.length > 1) {
                      mainName = await uniqueValids[1].textContent() || 'Unknown';
                      // Dùng toạ độ chuột để click chắc chắn 100% thay vì hàm click ảo
                      const targetBox = await uniqueValids[1].boundingBox();
                      if (targetBox) {
                          await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
                      } else {
                          await uniqueValids[1].click({ force: true });
                      }
                      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
                      await this.automationService.wait(8000);
                  }
              } else {
                  console.log('[Facebook] Đang ở sẵn Nick chính!');
                  // Lấy tên Nick chính
                  await page.goto('https://www.facebook.com/');
                  await this.automationService.wait(3000);
                  await this.automationService.simulateHumanClick(page, 'svg[aria-label="Trang cá nhân của bạn"], svg[aria-label="Your profile"]', { index: 'last' });
                  await this.automationService.wait(1500);
                  const activeProfile = page.locator('div[role="radio"][aria-checked="true"], div[role="menuitemradio"][aria-checked="true"]').first();
                  mainName = await activeProfile.textContent() || 'Unknown';
                  await page.keyboard.press('Escape');
              }

              state = { mainAccountName: mainName, pageIndex: 0, tasksDone: 0, maxTasks: 10 + Math.floor(Math.random() * 3) };
              this.accountPageState[accountId] = state;
              console.log(`[Facebook] ✅ Đã lưu bộ nhớ Nick chính là: "${mainName}"`);
              
              // Return để chạy lại hàm này với thân phận đã reset
              return await this.switchToPageContext(page, accountId);
          }

          // Tạo danh sách CHỈ CHỨA PAGE bằng cách loại bỏ Nick chính
          const pagesOnly: any[] = [];
          for (const p of uniqueProfiles) {
              const name = await p.textContent();
              if (name !== state.mainAccountName) {
                  pagesOnly.push(p);
              }
          }

          if (pagesOnly.length > 0) {
              if (state.tasksDone >= state.maxTasks || state.pageIndex >= pagesOnly.length) {
                  // Hết Quota hoặc Index vượt quá mảng -> Chuyển sang Page tiếp theo theo vòng lặp (Round Robin)
                  state.pageIndex++;
                  if (state.pageIndex >= pagesOnly.length) {
                      state.pageIndex = 0; // Xoay vòng lại từ Page đầu tiên
                  }
                  state.tasksDone = 0;
                  state.maxTasks = 10 + Math.floor(Math.random() * 3);
              }
              
              const targetProfile = pagesOnly[state.pageIndex];
              const profileName = await targetProfile.textContent();
              
              // Kiểm tra xem nó có đang được chọn không (dựa vào aria-checked hoặc icon checkmark)
              const isChecked = await targetProfile.getAttribute('aria-checked');
              const hasCheckmark = await targetProfile.locator('svg').count() > 1; // Thường nick đang chọn sẽ có 2 svg (1 avatar, 1 checkmark)
              
              if (isChecked === 'true' || isChecked === 'mixed' || hasCheckmark) {
                  console.log(`[Facebook] Đã ở tư cách Page (${profileName}), sẵn sàng làm nhiệm vụ (Đã cày ${state.tasksDone}/${state.maxTasks} bài).`);
                  state.tasksDone++;
                  await page.keyboard.press('Escape');
                  return true;
              }

              console.log(`[Facebook] Đang click chuyển sang Page: ${profileName}... (Bắt đầu lô ${state.maxTasks} bài)`);
              
              // Dùng toạ độ chuột để click chắc chắn 100%
              const targetBox = await targetProfile.boundingBox();
              if (targetBox) {
                  await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
              } else {
                  await targetProfile.click({ force: true });
              }
              
              state.tasksDone++;
              
              await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
              await this.automationService.wait(8000); // Tăng thời gian chờ lên 8 giây để chắc chắn FB đã load xong UI mới
              console.log('[Facebook] Đổi thân phận thành Page thành công!');
              return true;
          } else {
              console.log(`[Facebook] Nick này chỉ có nick chính, không có Page nào khác.`);
              await page.keyboard.press('Escape');
              return false;
          }
      } else {
          console.log(`[Facebook] Nick này chưa có Page nào (tìm thấy ${validProfiles.length} profile), sẽ đành lấy thân mình (nick chính) ra đỡ đạn.`);
          await page.keyboard.press('Escape');
          return false;
      }
    } catch (e) {
      console.log('[Facebook] Lỗi khi chuyển Page:', e);
      return false;
    }
  }

  private async clickLikeButton(page: Page): Promise<boolean> {
    console.log('[Facebook] Bắt đầu tìm nút Like...');
    
    // Mở rộng bộ nhận diện nút Like cho cả tiếng Việt, Anh, và UI mới
    // BỎ CÁC SELECTOR `span` ĐỂ TRÁNH CLICK NHẦM VÀO SỐ LƯỢNG LIKE HOẶC CHỮ "THÍCH" TRONG ẢNH
    const likeSelectors = [
      'div[aria-label="Thích"][role="button"][tabindex="0"]',
      'div[aria-label="Like"][role="button"][tabindex="0"]',
      'div[aria-label="Bày tỏ cảm xúc"][role="button"][tabindex="0"]',
      'div[aria-label="Thích"][role="button"]',
      'div[aria-label="Like"][role="button"]'
    ]

    for (const selector of likeSelectors) {
      console.log(`[Facebook] Đang thử selector: ${selector}`);
      
      if (await this.automationService.simulateHumanClick(page, selector)) {
         console.log('[Facebook] Đã click nút Like thành công!');
         return true;
      }
    }

    console.log('[Facebook] Không tìm thấy nút Like ở vùng hiển thị hiện tại. Tiến hành cuộn trang...');
    const viewport = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    
    // Cuộn xuống liên tục 3 lần để chắc chắn kéo qua phần ảnh/video dài
    for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 600);
        await this.automationService.wait(1000);
        
        for (const selector of likeSelectors) {
          if (await this.automationService.simulateHumanClick(page, selector)) {
             console.log('[Facebook] Đã click nút Like thành công sau khi cuộn!');
             return true;
          }
        }
    }
    
    console.log('[Facebook] Thất bại: Không thể tìm thấy nút Like!');
    return false
  }

  private async clickReactionButton(page: Page, reactionType: string): Promise<boolean> {
    const reactionMap: Record<string, string> = {
      LOVE: 'Yêu thích', HAHA: 'Haha', WOW: 'Wow', SAD: 'Buồn', ANGRY: 'Phẫn nộ'
    }
    const label = reactionMap[reactionType] || 'Thích'

    let hovered = await this.automationService.simulateHumanClick(page, 'div[aria-label="Thích"][role="button"]', { index: 'last' })
    if (!hovered) {
       await this.automationService.simulateScroll(page, 2000)
       hovered = await this.automationService.simulateHumanClick(page, 'div[aria-label="Thích"][role="button"]', { index: 'last' })
    }
    if (!hovered) return false
    
    await this.automationService.wait(1500)
    return await this.automationService.simulateHumanClick(page, `div[aria-label="${label}"]`)
  }

  private async clickFollowButton(page: Page): Promise<boolean | string> {
    const followSelectors = ['div[aria-label="Theo dõi"]', 'div[aria-label="Follow"]', 'div[aria-label="Thêm bạn bè"]', 'div[aria-label="Add friend"]']
    for (const selector of followSelectors) {
      if (await this.automationService.simulateHumanClick(page, selector)) return true
    }

    await this.automationService.simulateScroll(page, 2000)
    for (const selector of followSelectors) {
      if (await this.automationService.simulateHumanClick(page, selector)) return true
    }
    return false
  }


  private async shareToGroup(page: Page, task: any, accountId: string = 'default'): Promise<boolean | string> {
    const groupIds = task.metadata?.groupIds || (task.metadata?.groupId ? [task.metadata.groupId] : []);
    
    if (groupIds.length === 0) {
      console.error('[Facebook] Không tìm thấy Link Nhóm trong Task Metadata!');
      return false;
    }

    const state = this.accountPageState[accountId];
    let successCount = 0;

    for (let i = 0; i < groupIds.length; i++) {
      const groupIdUrl = groupIds[i];
      console.log(`\n[Facebook] --- Bắt đầu Share vào nhóm ${i + 1}/${groupIds.length}: ${groupIdUrl} ---`);
      
      try {
        // 1. Chạy thẳng vào link nhóm để lấy tên Nhóm và check Tham gia
        console.log(`[Facebook] Truy cập nhóm: ${groupIdUrl}`);
        await page.goto(groupIdUrl);
        await this.automationService.wait(5000);

        // KIỂM TRA BẢO MẬT: Nhóm này có ép tráo đổi về Nick chính không?
        if (state && state.mainAccountName) {
            console.log('[Facebook] Kiểm tra xem FB có lén lút tráo về Nick chính không...');
            const avatarMenu = page.locator('svg[aria-label="Trang cá nhân của bạn"], svg[aria-label="Your profile"], div[role="navigation"] svg').last();
            await avatarMenu.click({ force: true }).catch(() => {});
            await this.automationService.wait(1500);

            // Đọc tên đang active ở trên cùng menu
            const activeProfileLoc = page.locator('div[role="radio"][aria-checked="true"], div[role="menuitemradio"][aria-checked="true"]').first();
            if (await activeProfileLoc.count() > 0) {
                const activeName = await activeProfileLoc.textContent();
                if (activeName === state.mainAccountName) {
                    console.error(`[Facebook] CẢNH BÁO: Nhóm này không cho Page tham gia! FB đã tự động tráo về Nick chính (${activeName}). Bỏ qua nhóm này để bảo vệ Nick chính!`);
                    await page.keyboard.press('Escape');
                    // Phải quay về trang chủ để khôi phục lại thân phận Page cho các nhóm tiếp theo
                    await page.goto('https://www.facebook.com/');
                    await this.switchToPageContext(page, accountId);
                    continue; // Bỏ qua nhóm này
                }
            }
            await page.keyboard.press('Escape'); // Đóng menu an toàn
            await this.automationService.wait(1000);
        }

        // Lấy tên nhóm từ tiêu đề trang hoặc thẻ h1 hiển thị
        let groupName = 'Nhóm';
        try {
            const titleText = await page.title();
            if (titleText) {
                groupName = titleText.replace(/^\([^)]+\)\s*/, '').replace(/\s*\|\s*Facebook$/, '').trim();
            }
            if (groupName === 'Nhóm' || groupName === 'Facebook') {
                const h1s = await page.$$('h1');
                for (const h1 of h1s) {
                    if (await h1.isVisible()) {
                        const text = await h1.textContent();
                        if (text) {
                            groupName = text.trim();
                            break;
                        }
                    }
                }
            }
        } catch(e) {
            console.error('[Facebook] Không lấy được tên nhóm, dùng mặc định:', e);
        }
        console.log(`[Facebook] Nhận diện tên nhóm: ${groupName}`);

        // 2. Kiểm tra trạng thái tham gia nhóm dựa trên thứ tự DOM (Nút của nhóm chính luôn nằm trên cùng)
        console.log('[Facebook] Đang kiểm tra trạng thái tham gia Nhóm...');
        const membershipState = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('div[role="button"]'));
          for (const btn of btns) {
            const aria = btn.getAttribute('aria-label') || '';
            if (aria === 'Đã tham gia' || aria === 'Joined') return 'JOINED';
            if (aria === 'Hủy yêu cầu' || aria === 'Cancel request') return 'PENDING';
            if (aria === 'Tham gia nhóm' || aria === 'Join Group') return 'NOT_JOINED';
          }
          return 'UNKNOWN';
        });

        if (membershipState === 'PENDING') {
          console.log('[Facebook] Đang ở trạng thái chờ duyệt! Sẽ vẫn thử share...');
        }

        if (membershipState === 'NOT_JOINED' || membershipState === 'UNKNOWN') {
          console.log('[Facebook] Xác nhận chưa tham gia nhóm. Tìm và bấm nút Tham gia...');
          
          const clickedJoin = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], [aria-label]'));
            for (const btn of btns) {
              const aria = btn.getAttribute('aria-label') || '';
              if (aria === 'Tham gia nhóm' || aria === 'Join Group') {
                (btn as HTMLElement).click();
                return true;
              }
            }
            return false;
          });

          if (clickedJoin) {
            console.log('[Facebook] Đã bấm Tham gia nhóm. Chờ modal câu hỏi (nếu có)...');
            await this.automationService.wait(3000);
            
            const hasModal = await page.$('div[aria-label="Trả lời câu hỏi"]');
            if (hasModal) {
               console.log('[Facebook] Nhóm yêu cầu trả lời câu hỏi. Thử tick bừa...');
               const checkboxes = await page.$$('div[role="checkbox"], div[role="radio"]');
               if (checkboxes.length > 0) {
                 await checkboxes[0].click({ force: true });
               }
               const textareas = await page.$$('textarea');
               for (const ta of textareas) {
                 await ta.fill('Đồng ý');
               }
               await this.automationService.simulateHumanClick(page, 'div[aria-label="Gửi"], div[aria-label="Submit"]');
            }
            console.log('[Facebook] Xử lý xong Tham gia nhóm. Sẽ tiếp tục share...');
          }
        } else {
          console.log('[Facebook] Xác nhận đã là thành viên của Nhóm!');
        }

        // 3. Đã là thành viên -> Mở bài viết gốc
        console.log(`[Facebook] Đã tham gia nhóm. Chuyển sang bài viết: ${task.campaign.targetUrl}`);
        await page.goto(task.campaign.targetUrl);
        await this.automationService.wait(6000);

        // 4. Bấm nút Chia sẻ ở bài viết
        console.log('[Facebook] Cuộn thông minh để tải thanh Action Bar (chống Virtualization)...');
        let foundLike = false;
        
        for (let s = 0; s < 10; s++) { // Tối đa 10 lần cuộn
            // Xác định container hiện tại (modal hoặc body)
            const dialogsLoc = page.locator('div[role="dialog"]');
            const dialogCount = await dialogsLoc.count();
            const containerLocator = dialogCount > 0 ? dialogsLoc.nth(dialogCount - 1) : page.locator('body');

            // Tìm nút Like trong phạm vi container hiện tại
            const likeSelectors = [
                'div[aria-label="Thích"][role="button"]',
                'div[aria-label="Like"][role="button"]',
                'div[aria-label="Bày tỏ cảm xúc"][role="button"]'
            ];
            
            for (const selector of likeSelectors) {
                try {
                    // Sửa lỗi: Lấy nút Like ĐẦU TIÊN (của bài viết chính), thay vì nút Cuối cùng (của bình luận)
                    const target = containerLocator.locator(selector).first(); 
                    const isVisible = await target.isVisible();
                    if (isVisible) {
                        await target.scrollIntoViewIfNeeded();
                        console.log(`[Facebook] Đã cuộn màn hình tới thanh Action Bar thành công ở vòng lặp ${s + 1}!`);
                        foundLike = true;
                        break;
                    }
                } catch(e) {}
            }
            
            if (foundLike) {
                await this.automationService.wait(1500);
                break;
            }
            
            // Nếu chưa thấy, cuộn xuống thêm 800px
            const viewport = page.viewportSize() || { width: 1280, height: 720 };
            await page.mouse.move(viewport.width / 2, viewport.height / 2);
            await page.mouse.wheel(0, 800);
            await this.automationService.wait(1000);
        }

        console.log('[Facebook] Dùng thuật toán Action Bar + Đọc Tooltip siêu cấp...');
        let clickedShare = false;
        
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const actionBtns = await page.evaluate(() => {
                    const dialogs = document.querySelectorAll('div[role="dialog"]');
                    const articles = document.querySelectorAll('div[role="article"]');
                    
                    let container: HTMLElement = document.body;
                    if (dialogs.length > 0) {
                        container = dialogs[dialogs.length - 1] as HTMLElement;
                    } else if (articles.length > 0) {
                        container = articles[0] as HTMLElement;
                    }

                    const btns = Array.from(container.querySelectorAll('div[role="button"], span[role="button"]'));
                        
                    const rows: {y: number, buttons: Element[]}[] = [];
                    for (const btn of btns) {
                        const r = btn.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0 || r.y < 60) continue; 
                        
                        let foundRow: {y: number, buttons: Element[]} | null = null;
                        for (const row of rows) {
                            if (Math.abs(row.y - r.y) < 20) { 
                                foundRow = row;
                                break;
                            }
                        }
                        
                        if (foundRow) {
                            foundRow.buttons.push(btn);
                        } else {
                            rows.push({ y: r.y, buttons: [btn] });
                        }
                    }
                    
                    const validRows = rows.filter(r => r.buttons.length >= 2);
                    
                    if (validRows.length > 0) {
                        validRows.sort((a, b) => a.y - b.y);
                        const targetRow = validRows[0];
                        targetRow.buttons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                        
                        return targetRow.buttons.map(b => {
                            const r = b.getBoundingClientRect();
                            return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left };
                        });
                    }
                    return null;
                });
                
                if (actionBtns && actionBtns.length > 0) {
                    console.log(`[Facebook] Tìm thấy thanh Action Bar với ${actionBtns.length} nút.`);
                    let foundTooltip = false;
                    
                    for (let j = actionBtns.length - 1; j >= 0; j--) {
                        const btn = actionBtns[j];
                        await page.mouse.move(btn.x, btn.y);
                        await this.automationService.wait(800);
                        
                        const tooltipText = await page.evaluate(() => {
                            const tooltips = Array.from(document.querySelectorAll('[role="tooltip"]'));
                            return tooltips.map(t => (t.textContent || '').toLowerCase()).join(' ');
                        });
                        
                        if (tooltipText.includes('chia sẻ') || tooltipText.includes('share') || tooltipText.includes('gửi')) {
                            console.log(`[Facebook] Phát hiện Tooltip Chia sẻ tại nút thứ ${j+1}`);
                            await page.mouse.click(btn.x, btn.y);
                            clickedShare = true;
                            foundTooltip = true;
                            break;
                        }
                    }
                    
                    if (!foundTooltip) {
                        console.log('[Facebook] Không bắt được Tooltip, kích hoạt thuật toán Phân tích Khoảng trống...');
                        let targetIndex = actionBtns.length - 1;
                        
                        if (actionBtns.length >= 4) {
                            for (let j = 0; j < actionBtns.length - 1; j++) {
                                if (actionBtns[j+1].left - actionBtns[j].left > 150) {
                                    targetIndex = j;
                                    break;
                                }
                            }
                        }
                        
                        console.log(`[Facebook] Click dự phòng vào nút thứ ${targetIndex + 1}`);
                        const fallbackBtn = actionBtns[targetIndex];
                        await page.mouse.move(fallbackBtn.x, fallbackBtn.y);
                        await page.mouse.click(fallbackBtn.x, fallbackBtn.y);
                        clickedShare = true;
                    }
                } else {
                    console.error('[Facebook] Không tìm thấy Action Bar!');
                }
                
            } catch (e) {
                console.error('[Facebook] Lỗi khi xử lý click nút Share:', e);
            }

            if (clickedShare) {
                await this.automationService.wait(1500);
                const menuVisible = await page.evaluate(() => {
                    const docText = document.body.innerText.toLowerCase();
                    return docText.includes('chia sẻ ngay') || 
                           docText.includes('share now') ||
                           docText.includes('chia sẻ lên') ||
                           docText.includes('share to');
                });
                
                if (menuVisible) {
                    console.log('[Facebook] Đã mở thành công menu Chia sẻ!');
                    break;
                } else {
                    console.log('[Facebook] Menu Chia sẻ chưa mở. Nhấn Escape và thử lại...');
                    await page.keyboard.press('Escape');
                    await this.automationService.wait(1000);
                    clickedShare = false;
                }
            }
            
            await this.automationService.wait(2000);
        }

        if (!clickedShare) {
          console.error('[Facebook] Không tìm thấy nút Chia sẻ ở bài viết! Bỏ qua nhóm này.');
          continue; // Skip to next group
        }

        await this.automationService.wait(3000);

        // 5. Bấm vào "Nhóm" (Group) trong Menu chia sẻ bằng Playwright Locator
        console.log('[Facebook] Chọn Chia sẻ lên Nhóm...');
        let clickedGroupOption = false;
        const groupLocators = [
            page.getByRole('dialog').getByText('Nhóm', { exact: true }),
            page.getByRole('dialog').getByText('Group', { exact: true }),
            page.getByRole('dialog').getByText('Chia sẻ lên nhóm', { exact: true }),
            page.getByRole('dialog').getByText('Share to a group', { exact: true }),
            page.getByText('Nhóm', { exact: true }).last(),
            page.getByText('Group', { exact: true }).last()
        ];

        for (const locator of groupLocators) {
            try {
                if (await locator.count() > 0) {
                    const target = locator.last();
                    await target.hover();
                    await target.click({ force: true });
                    clickedGroupOption = true;
                    break;
                }
            } catch(e) {}
        }

        if (!clickedGroupOption) {
          console.error('[Facebook] Không tìm thấy tuỳ chọn "Nhóm" trong menu chia sẻ! Bỏ qua nhóm này.');
          continue;
        }

        await this.automationService.wait(4000);

        // 6. Tìm nhóm và chọn
        console.log(`[Facebook] Tìm kiếm nhóm: ${groupName}`);
        const searchInputs = [
          'input[aria-label="Tìm kiếm nhóm"]',
          'input[placeholder="Tìm kiếm nhóm"]',
          'input[aria-label="Search for groups"]',
          'input[placeholder="Search for groups"]'
        ];

        let typedSearch = false;
        for (const selector of searchInputs) {
          const input = await page.$(selector);
          if (input) {
            await input.fill(groupName);
            typedSearch = true;
            break;
          }
        }

        if (!typedSearch) {
          console.error('[Facebook] Không tìm thấy ô Tìm kiếm nhóm! Bỏ qua nhóm này.');
          continue;
        }

        await this.automationService.wait(4000);

        // 7. Bấm vào kết quả tìm kiếm đầu tiên (danh sách nhóm)
        console.log('[Facebook] Bấm chọn nhóm đầu tiên trong kết quả tìm kiếm...');
        const resultItemSelector = `span:has-text("${groupName}")`;
        const resultItems = await page.$$(resultItemSelector);
        if (resultItems.length > 0) {
           await resultItems[resultItems.length - 1].click({ force: true });
        } else {
           console.log('[Facebook] Không tìm thấy nhóm trong danh sách kết quả, có thể do chưa duyệt hoặc bị lỗi hiển thị. Bỏ qua nhóm này.');
           continue;
        }

        await this.automationService.wait(3000);

        // 8. Bấm Đăng bài (Post)
        console.log('[Facebook] Kiểm tra xem nhóm có Yêu cầu phê duyệt không...');
        const isApprovalRequired = await page.evaluate(() => {
            const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
            if (dialogs.length > 0) {
                const text = dialogs[dialogs.length - 1].textContent?.toLowerCase() || '';
                return text.includes('phê duyệt') || text.includes('quản trị viên') || text.includes('admin') || text.includes('approval');
            }
            return false;
        });

        if (isApprovalRequired) {
            console.log(`[Facebook] ⚠️ BỎ QUA: Nhóm "${groupName}" yêu cầu Quản trị viên phê duyệt bài viết! (Chống lãng phí tương tác)`);
            await page.keyboard.press('Escape');
            await this.automationService.wait(1000);
            await page.keyboard.press('Escape'); // Nhấn 2 lần cho chắc chắn đóng
            continue; // Chuyển sang nhóm tiếp theo
        }

        console.log('[Facebook] Nhóm mở (Đăng ngay).');

        // CHỨC NĂNG: Xử lý nội dung (Spintax) và kiểm tra từ khoá cấm
        if (task.metadata?.content) {
            let contentStr = task.metadata.content;
            
            // Xử lý Spintax (Nội dung A | Nội dung B | Nội dung C)
            if (contentStr.includes('|')) {
                const parts = contentStr.split('|').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
                if (parts.length > 0) {
                    contentStr = parts[Math.floor(Math.random() * parts.length)];
                }
            }

            // Từ khoá cấm chuẩn Production (Dựa trên chính sách Facebook và kinh nghiệm chạy Ads/Spam)
            const forbiddenWords = [
                // 1. Cờ bạc, Tài xỉu, Lô đề
                'tài xỉu', 'đánh bạc', 'cá độ', 'lô đề', 'soi cầu', 'kubet', 'sunwin', 'baccarat', 'game bài',
                // 2. Tín dụng đen, Vay nặng lãi
                'vay nặng lãi', 'bốc bát họ', 'cầm đồ', 'vay không thế chấp', 'giải ngân nhanh', 'đòi nợ',
                // 3. 18+, Nhạy cảm
                'gái gọi', 'sugar baby', 'sugar daddy', 'kích dục', 'thuốc kích dục', '18+', 'sextoy', 'đồ chơi tình dục',
                // 4. Hàng giả, Hàng nhái, Vi phạm bản quyền
                'hàng fake', 'super fake', 'rep 1:1', 'hàng nhái', 'fake loại 1',
                // 5. Y tế, Thuốc (Cam kết quá đáng)
                'thuốc giảm cân', 'giảm mỡ nhanh', 'chữa bách bệnh', 'cam kết khỏi bệnh 100%', 'thuốc cường dương', 'trị dứt điểm',
                // 6. Vũ khí, Chất kích thích
                'súng', 'đạn', 'dao găm', 'mã tấu', 'thuốc lá', 'vape', 'pod', 'ma tuý', 'cần sa', 'shisha',
                // 7. Lừa đảo, Đa cấp, Scam
                'việc nhẹ lương cao', 'cam kết sinh lời', 'đầu tư lợi nhuận khủng', 'kiếm tiền tại nhà dễ dàng', 'đa cấp',
                // 8. Tương tác giả mạo
                'tăng like', 'mua follow', 'hack like', 'hack sub'
            ];
            
            const hasForbidden = forbiddenWords.some(w => contentStr.toLowerCase().includes(w.toLowerCase()));
            
            if (hasForbidden) {
                console.log(`[Facebook] ⚠️ Nội dung chứa từ khoá nhạy cảm/bị cấm! Bỏ qua nhóm này để bảo vệ tài khoản.`);
                await page.keyboard.press('Escape');
                await this.automationService.wait(1000);
                await page.keyboard.press('Escape');
                continue;
            }

            console.log(`[Facebook] Nhập nội dung chia sẻ: ${contentStr.substring(0, 50)}...`);
            // Tìm ô nhập text
            const textLocators = [
                'div[role="textbox"][aria-label*="Hãy nói gì đó"]',
                'div[role="textbox"][aria-label*="Say something"]',
                'div[role="textbox"][aria-label*="viết"]'
            ];
            
            let typed = false;
            for (const tLoc of textLocators) {
                const box = page.locator(tLoc).first();
                if (await box.isVisible().catch(() => false)) {
                    await box.click();
                    await this.automationService.wait(500);
                    // Dùng type thay vì insertText để giả lập gõ phím từng chữ (tránh lỗi React DraftJS của FB không nhận diện được chữ dẫn tới lỗi đăng)
                    await page.keyboard.type(contentStr, { delay: 15 });
                    await this.automationService.wait(2000);
                    typed = true;
                    break;
                }
            }
            if (!typed) {
                console.log('[Facebook] Không tìm thấy ô nhập nội dung, sẽ chia sẻ không có nội dung.');
            }
        }

        console.log('[Facebook] Bấm nút Đăng để hoàn tất chia sẻ...');
        const postSelectors = [
          'div[aria-label="Đăng"][role="button"]',
          'div[aria-label="Post"][role="button"]',
          'span:has-text("Đăng")',
          'span:has-text("Post")'
        ];

        let posted = false;
        for (const selector of postSelectors) {
          const btn = await page.$(selector);
          if (btn) {
            const isDisabled = await btn.getAttribute('aria-disabled');
            if (isDisabled === 'true') continue;
            
            // Sếp bảo chậm lại: Thêm delay ngẫu nhiên 2-4 giây trước khi bấm Đăng để giả lập người thật đang đọc lại bài
            await this.automationService.wait(2000 + Math.random() * 2000);
            
            if (await this.automationService.simulateHumanClick(page, selector)) {
               // Chờ 3 giây để xem Facebook có phun ra cái bảng đen báo lỗi không
               await this.automationService.wait(3000);
               
               const errorToast = page.locator('span, div').filter({ hasText: /Đã xảy ra lỗi/i }).first();
               if (await errorToast.isVisible().catch(() => false)) {
                   console.log('[Facebook] ⚠️ Phát hiện lỗi "Đã xảy ra lỗi kỹ thuật" từ Facebook! Chờ 5 giây và thử bấm Đăng lại lần 2...');
                   await this.automationService.wait(5000);
                   
                   // Thử bấm lại nút Đăng
                   await this.automationService.simulateHumanClick(page, selector);
                   await this.automationService.wait(4000);
                   
                   if (await errorToast.isVisible().catch(() => false)) {
                       console.log('[Facebook] ❌ Lỗi vẫn ngoan cố xuất hiện! Bỏ qua nhóm này.');
                       await page.keyboard.press('Escape');
                       await this.automationService.wait(1000);
                       await page.keyboard.press('Escape');
                       break; // Bỏ qua, không tính là thành công
                   }
               }

               console.log(`[Facebook] Chia sẻ thành công nhóm ${groupIdUrl}!`);
               successCount++;
               posted = true;
               await this.automationService.wait(5000);
               break;
            }
          }
        }

        if (!posted) {
            console.log('[Facebook] Không thể bấm nút Đăng (có thể nút bị mờ).');
        }

      } catch (e) {
        console.error(`[Facebook] Lỗi không xác định khi share nhóm ${groupIdUrl}:`, e);
      }

      // 9. NHỊP NGHỈ VÀ NUÔI NICK TRƯỚC KHI SHARE NHÓM TIẾP THEO
      if (i < groupIds.length - 1) {
          const delaySecs = 30 + Math.random() * 30; // 30 đến 60 giây
          console.log(`[Facebook] 🛑 Tạm nghỉ ${delaySecs.toFixed(0)} giây và lướt Newfeed để giả lập người thật trước khi share tiếp...`);
          
          await page.goto('https://www.facebook.com/');
          await this.automationService.wait(3000 + Math.random() * 2000);
          
          const scrollCount = 2 + Math.floor(Math.random() * 2); // Cuộn 2-3 lần
          for (let s = 0; s < scrollCount; s++) {
            await this.automationService.simulateScroll(page, 1500);
            await this.automationService.wait(5000 + Math.random() * 5000); // Đợi 5-10s mỗi lần cuộn
          }
      }
    }

    console.log(`[Facebook] --- Hoàn tất Share Group Batch. Thành công: ${successCount}/${groupIds.length} ---`);
    return successCount > 0;
  }

  async performNurturing(page: Page): Promise<boolean> {
    try {
      console.log('[Facebook Nurturing] Bắt đầu nuôi nick Facebook...');
      await page.goto('https://www.facebook.com/');
      await this.automationService.wait(4000 + Math.random() * 2000);
      
      const scrollCount = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < scrollCount; i++) {
        await this.automationService.simulateScroll(page, 1500);
        await this.automationService.wait(3000 + Math.random() * 4000);
        
        if (Math.random() < 0.2) {
          console.log('[Facebook Nurturing] Thả Like dạo Newsfeed...');
          await this.clickLikeButton(page);
        }
      }

      console.log('[Facebook Nurturing] Chuyển sang xem Watch/Video...');
      await page.goto('https://www.facebook.com/watch/');
      await this.automationService.wait(4000 + Math.random() * 2000);
      
      const videoScrollCount = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < videoScrollCount; i++) {
         await this.automationService.simulateScroll(page, 1000);
         await this.automationService.wait(10000 + Math.random() * 15000);
      }

      console.log('[Facebook Nurturing] Hoàn tất phiên nuôi.');
      return true;
    } catch (e) {
      console.error('[Facebook Nurturing] Lỗi:', e);
      return false;
    }
  }

  private async postToGroup(page: Page, task: any, accountId: string = 'default'): Promise<boolean | string> {
    try {
      console.log(`[Facebook] Bắt đầu tác vụ POST_GROUP...`);
      const campaignMeta = task.campaign.metadata || {};
      const taskMeta = task.metadata || {};
      console.log('[Facebook] Debug taskMeta:', JSON.stringify(taskMeta));
      
      // Lấy danh sách nhóm từ Từng Gói (Task) do máy chủ chia, thay vì lấy toàn bộ từ Campaign
      let groups = taskMeta.groupIds || [];
      // Fallback cho các task cũ đã được tạo ra trước khi cập nhật logic băm nhỏ
      if (!groups || groups.length === 0) {
          if (taskMeta.groupId) {
              groups = [taskMeta.groupId];
          } else {
              console.error('[Facebook] Không có danh sách nhóm để đăng bài trong Task này.');
              return false;
          }
      }

      const postData = campaignMeta.postData || {};
      const content = postData.content || '';
      const imageUrls = (postData.imageUrls || []).filter((url: string) => url && url.trim().length > 0);
      console.log(`[Facebook] Debug campaignMeta:`, JSON.stringify(campaignMeta));
      console.log(`[Facebook] Debug postData:`, JSON.stringify(postData));

      let state = this.accountPageState[accountId];
      if (!state || state.mainAccountName !== null) { // Nếu state chưa khởi tạo hoặc đang là thông tin của lô trước
          state = { mainAccountName: null, pageIndex: 0, tasksDone: 0, maxTasks: groups.length };
          this.accountPageState[accountId] = state;
      }

      const currentIndex = state.tasksDone;
      if (currentIndex >= groups.length) {
          console.log('[Facebook] Đã hoàn thành hết số lượng nhóm trong kịch bản POST_GROUP.');
          return true;
      }

      let rawGroup = groups[currentIndex];
      let groupUrl = rawGroup;
      if (!rawGroup.includes('facebook.com')) {
         groupUrl = `https://www.facebook.com/groups/${rawGroup}`;
      }

      console.log(`[Facebook] Đang vào nhóm để đăng bài: ${groupUrl}`);
      await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
      await this.automationService.wait(4000);

      // --- KIỂM TRA & TỰ ĐỘNG THAM GIA NHÓM ---
      const membershipState = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('div[role="button"]'));
        for (const btn of btns) {
          const aria = btn.getAttribute('aria-label') || '';
          if (aria === 'Đã tham gia' || aria === 'Joined') return 'JOINED';
          if (aria === 'Hủy yêu cầu' || aria === 'Cancel request') return 'PENDING';
          if (aria === 'Tham gia nhóm' || aria === 'Join Group') return 'NOT_JOINED';
        }
        return 'UNKNOWN';
      });

      if (membershipState === 'PENDING') {
        console.log('[Facebook] Nhóm đang chờ phê duyệt, bỏ qua...');
        return false;
      }

      if (membershipState === 'NOT_JOINED' || membershipState === 'UNKNOWN') {
        console.log('[Facebook] Có vẻ chưa tham gia nhóm. Thử bấm Tham gia...');
        const clickedJoin = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], [aria-label]'));
          for (const btn of btns) {
            const aria = btn.getAttribute('aria-label') || '';
            if (aria === 'Tham gia nhóm' || aria === 'Join Group') {
              (btn as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (clickedJoin) {
          console.log('[Facebook] Đã bấm Tham gia nhóm. Chờ modal câu hỏi (nếu có)...');
          await this.automationService.wait(3000);
          
          const hasModal = await page.$('div[aria-label="Trả lời câu hỏi"]');
          if (hasModal) {
             console.log('[Facebook] Nhóm yêu cầu trả lời câu hỏi. Thử tick bừa...');
             // Chọn tất cả các radio / checkbox
             const options = await page.$$('div[role="checkbox"], div[role="radio"]');
             if (options.length > 0) {
                 await options[0].click(); // Click bừa cái đầu tiên
             }
             // Điền bừa text
             const textareas = await page.$$('textarea');
             for (const ta of textareas) {
               await ta.fill('Đồng ý');
             }
             await this.automationService.simulateHumanClick(page, 'div[aria-label="Gửi"], div[aria-label="Submit"]');
          }
          console.log('[Facebook] Xử lý xong Tham gia nhóm. Sẽ thử đăng bài ngay (nếu nhóm cho phép đăng không cần duyệt)...');
          await this.automationService.wait(3000);
        }
      } else {
        console.log('[Facebook] Xác nhận đã là thành viên của Nhóm!');
      }
      // --- KẾT THÚC AUTO-JOIN ---

      // Tìm nút "Bạn viết gì đi", "Write something", "Tạo bài viết công khai"...
      const postBoxSelectors = [
          'div[role="button"]:has-text("Bạn viết gì đi")',
          'div[role="button"]:has-text("Write something")',
          'div[role="button"]:has-text("Tạo bài viết công khai")',
          'div[role="button"]:has-text("Create a public post")',
          'div.x1i10hfl.x6umtig.x1b1mbwd.xaqea5y.xav7gou.x9f619.x1ypdohk:has-text("Bạn viết gì đi")'
      ];

      let clickedBox = false;
      for (const sel of postBoxSelectors) {
          if (await this.automationService.simulateHumanClick(page, sel)) {
              clickedBox = true;
              break;
          }
      }

      if (!clickedBox) {
          // Thử dò tìm thẻ span có chứa chữ "viết gì đi" và click vào parent
          const boxText = page.locator('span').filter({ hasText: /viết gì đi|write something|tạo bài viết/i }).first();
          if (await boxText.isVisible()) {
              await boxText.click();
              clickedBox = true;
          }
      }

      if (!clickedBox) {
          console.error('[Facebook] Không tìm thấy ô đăng bài trong nhóm. Có thể nhóm đóng hoặc bị cấm đăng.');
          return false;
      }

      await this.automationService.wait(2000);

      // Tìm ô textarea hoặc the contenteditable
      console.log('[Facebook] Đang dò tìm vùng nhập văn bản (Editor)...');
      let editorLoc = page.locator('div[role="dialog"] div[role="textbox"][contenteditable="true"]').first();
      
      if (!await editorLoc.isVisible()) {
          editorLoc = page.locator('div[role="textbox"][contenteditable="true"]').last();
      }

      if (await editorLoc.isVisible()) {
          // Bấm vào để focus
          await editorLoc.click();
          await this.automationService.wait(1000);
          
          console.log('[Facebook] Bắt đầu gõ nội dung bài đăng...');
          // Gõ nội dung (Sử dụng API điền từng chữ để qua mặt hệ thống bot detection)
          await editorLoc.type(content || ' ', { delay: 50 });
          await this.automationService.wait(2000);
      } else {
          console.error('[Facebook] Không tìm thấy vùng nhập văn bản (Editor).');
          return false;
      }

      // Đính kèm ảnh nếu có
      if (imageUrls && imageUrls.length > 0) {
          console.log(`[Facebook] Đang đính kèm ${imageUrls.length} ảnh...`);
          // Nút thêm ảnh vào bài viết
          const addPhotoBtn = page.locator('div[aria-label="Ảnh/video"], div[aria-label="Photo/video"]').first();
          if (await addPhotoBtn.isVisible()) {
              // Trong Playwright, để upload file local, cách tốt nhất là tìm thẻ input[type="file"]
              // Facebook render thẻ input file ẩn trong DOM. 
              // Đôi khi addPhotoBtn click vào sẽ mở picker native. Playwright cần dùng expectFileChooser hoặc setInputFiles.
              
              // Thay vì click, lấy thẳng input type file
              const fileInput = page.locator('input[type="file"][accept*="image"]').first();
              if (await fileInput.count() > 0) {
                 await fileInput.setInputFiles(imageUrls);
                 console.log('[Facebook] Upload ảnh thành công thông qua file input.');
              } else {
                 // Nếu không tìm thấy thẻ input (FB giấu), thử cách click và hứng file chooser
                 const [fileChooser] = await Promise.all([
                   page.waitForEvent('filechooser'),
                   addPhotoBtn.click()
                 ]);
                 await fileChooser.setFiles(imageUrls);
                 console.log('[Facebook] Upload ảnh thành công thông qua FileChooser.');
              }
              
              // Chờ FB load ảnh lên bản xem trước
              await this.automationService.wait(5000); 
          }
      }

      // Bấm nút Đăng
      console.log('[Facebook] Đang bấm nút Đăng (Post)...');
      const submitBtn = page.locator('div[aria-label="Đăng"], div[aria-label="Post"]').filter({ has: page.locator('span') }).first();
      if (await submitBtn.isVisible() && !await submitBtn.isDisabled()) {
          await submitBtn.click();
          console.log('[Facebook] Bấm Đăng thành công. Đang đợi xác nhận...');
          
          // Đợi Facebook tải lên và đóng modal (Modal Editor mất đi)
          await editorLoc.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
          await this.automationService.wait(3000);
          
          state.tasksDone++;
          return true; // Thành công
      } else {
          console.error('[Facebook] Nút Đăng không sáng hoặc không tìm thấy.');
          return false;
      }

    } catch (e) {
       console.error('[Facebook] Lỗi trong quá trình postToGroup:', e);
       return false;
    }
  }
}
