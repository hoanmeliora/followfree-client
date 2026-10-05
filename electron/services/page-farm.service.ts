import { chromium } from 'playwright-extra';
import { BrowserContext, Page } from 'playwright';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Ipv6Service } from './ipv6.service';
import { AutomationService } from './automation.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { StoreService } from './store.service';

chromium.use(stealthPlugin());

export class PageFarmService {
    private ipv6Service = new Ipv6Service();
    private automation = new AutomationService();
    private onLog?: (msg: string) => void;
    private storeService?: StoreService;

    constructor(onLogCallback?: (msg: string) => void, storeService?: StoreService) {
        this.onLog = onLogCallback;
        this.storeService = storeService;
    }

    private log(msg: string) {
        console.log(`[PageFarm] ${msg}`);
        if (this.onLog) {
            this.onLog(`[PageFarm] ${msg}`);
        }
    }

    /**
     * Tải avatar giả ngẫu nhiên
     */
    private async downloadRandomAvatar(): Promise<string> {
        return new Promise((resolve, reject) => {
            const avatarUrl = 'https://thispersondoesnotexist.com/';
            const dest = path.join(os.tmpdir(), `avatar_${Date.now()}.jpg`);
            const file = fs.createWriteStream(dest);

            https.get(avatarUrl, (response) => {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve(dest);
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => {});
                reject(err);
            });
        });
    }

    /**
     * Tạo 1 Page duy nhất (Chuẩn Bọc Thép)
     */
    public async createSinglePage(accountId: string, accountCookieStr: string, userAgent: string) {
        let context: BrowserContext | null = null;
        let virtualIp: string | null = null;
        let avatarPath: string | null = null;

        try {
            this.log('Bắt đầu quy trình tạo Page bọc thép...');

            // 1. Gắn IPv6 Cố Định Theo Tài Khoản (Chống Checkpoint)
            this.log('Đang kiểm tra và khởi tạo mạng IPv6...');
            await this.ipv6Service.getBasePrefix();
            
            this.log('Đang lấy IPv6 vân tay cho tài khoản này...');
            virtualIp = this.ipv6Service.generateFixedIpv6ForAccount(accountId);
            const bound = await this.ipv6Service.bindIpToSystem(virtualIp);
            if (!bound) {
                this.log('Lỗi: Không thể bind IPv6. Tiếp tục chạy không có IPv6 ảo.');
            } else {
                this.log(`Đã gắn thành công IPv6 ẩn danh: ${virtualIp}`);
            }

            // 2. Mở trình duyệt ẩn danh (Đồng bộ User-Agent và Cache Profile)
            this.log('Mở trình duyệt Playwright với Profile bọc thép...');
            const { app } = require('electron');
            const path = require('path');
            const profilePath = path.join(app.getPath('userData'), 'profiles', accountId);

            context = await chromium.launchPersistentContext(profilePath, {
                headless: false, // Hiển thị theo yêu cầu của sếp
                userAgent: userAgent || undefined, // Dùng đúng UserAgent của nick
                channel: 'chrome',
                args: [
                    '--disable-gpu',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    ...(virtualIp ? [`--bind-address=${virtualIp}`] : [])
                ],
                viewport: { width: 1280, height: 720 }
            });
            
            const page = await context.newPage();

            // 3. Set Cookie để bypass login
            this.log('Nạp cookies để qua mặt cổng đăng nhập...');
            try {
                let parsedCookies: any[] = [];
                try {
                    parsedCookies = JSON.parse(accountCookieStr);
                    parsedCookies = parsedCookies.map(cookie => {
                        if (cookie.sameSite) {
                            const sameSiteLower = cookie.sameSite.toLowerCase();
                            if (['strict', 'lax', 'none'].includes(sameSiteLower)) {
                                cookie.sameSite = cookie.sameSite.charAt(0).toUpperCase() + cookie.sameSite.slice(1).toLowerCase();
                            } else {
                                delete cookie.sameSite;
                            }
                        }
                        return cookie;
                    });
                } catch {
                    parsedCookies = accountCookieStr.split(';').map((pair: string) => {
                        const [name, ...rest] = pair.trim().split('=');
                        return { name, value: rest.join('='), domain: '.facebook.com', path: '/' };
                    });
                }
                await context.addCookies(parsedCookies);
            } catch (e) {
                this.log('Cookie không hợp lệ. Vui lòng kiểm tra lại!');
                return { success: false, msg: 'Invalid Cookie format' };
            }

            // 4. Vào trang chủ làm ấm tài khoản (Pre-warming)
            this.log('Pre-warming: Vào News Feed lướt dạo như người thật...');
            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
            await this.automation.simulateScroll(page, 5000); // Lướt 5 giây
            
            // 5. Chuẩn bị Avatar
            this.log('Đang gọi API xin một khuôn mặt giả (AI generated)...');
            try {
                avatarPath = await this.downloadRandomAvatar();
                this.log('Tải ảnh giả thành công!');
            } catch (e) {
                this.log('Tải ảnh thất bại, sẽ tạo Page không có ảnh.');
            }

            // 6. Điều hướng vào link tạo Page
            this.log('Bắt đầu rón rén đi vào khu vực tạo Page...');
            await page.goto('https://www.facebook.com/pages/creation/', { waitUntil: 'domcontentloaded' });
            await this.automation.wait(3000);

            // Kiểm tra xem có bị Facebook chặn vì đang ở tư cách Page không
            const isBlockedByPageContext = await page.getByText(/Bạn hiện không xem được nội dung này|This content isn't available right now/i).isVisible();
            if (isBlockedByPageContext) {
                this.log('Phát hiện đang ở tư cách Page! Tạm lùi về trang chủ để tráo đổi sang Nick chính...');
                await page.goto('https://www.facebook.com/');
                await this.automation.wait(3000);
                 
                // Mở Avatar
                const avatarMenu = page.locator('svg[aria-label="Trang cá nhân của bạn"], svg[aria-label="Your profile"]').last();
                await avatarMenu.click({ force: true }).catch(() => {});
                await this.automation.wait(2000);
                 
                // Bấm Xem tất cả
                const seeAllBtn = page.locator('div[role="button"]').filter({ hasText: /Xem tất cả trang cá nhân|See all profiles/i });
                if (await seeAllBtn.isVisible()) {
                    await seeAllBtn.click();
                    await this.automation.wait(1500);
                }
                 
                const profileLocators = await page.locator('div[role="radio"], div[role="button"], div[role="menuitemradio"]')
                   .filter({ hasNotText: /tạo trang|xem tất cả|cài đặt|đăng xuất|thông tin|đóng|trợ giúp|phản hồi|màn hình|tài khoản|tìm kiếm/i })
                   .all();
                 
                const validProfiles: any[] = [];
                for (const loc of profileLocators) {
                    if (await loc.isVisible()) {
                        const text = await loc.textContent();
                        if (text && text.trim().length > 0 && text.trim().length < 50) {
                            if (await loc.locator('image, img, svg').count() > 0) {
                                const box = await loc.boundingBox();
                                if (box && box.x > 300) validProfiles.push(loc);
                            }
                        }
                    }
                }
                 
                if (validProfiles.length > 1) {
                    // Khi đang ở tư cách Page, Nick chính LUÔN LUÔN nằm ở index 1 (ngay dưới nick hiện tại)
                    this.log('Bấm chọn Nick chính để khôi phục thân phận gốc...');
                    await validProfiles[1].click();
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                    await this.automation.wait(3000);
                }
                 
                // Vào lại link tạo Page
                this.log('Đã về Nick chính, rón rén đi vào khu vực tạo Page lần nữa...');
                await page.goto('https://www.facebook.com/pages/creation/', { waitUntil: 'domcontentloaded' });
                await this.automation.wait(3000);
            }

            // 7. Gõ phím mổ cò
            const pageNames = [
                'Góc Nhỏ Bình Yên', 'Chia Sẻ Cuộc Sống', 'Chuyện Nhà Nông', 'Thích Đi Phượt', 'Yêu Động Vật',
                'Mê Xe Cộ', 'Câu Lạc Bộ Sách hay', 'Hội Yêu Mèo', 'Ghi Chú Hàng Ngày', 'Khám Phá Quanh Ta',
                'Nguyễn Văn Huy', 'Trần Bảo Ngọc', 'Hoàng Gia Bảo', 'Lê Thị Thu Hương', 'Phạm Minh Trí'
            ];
            const bios = [
                'Chia sẻ cuộc sống hàng ngày', 'Nơi lưu giữ những kỷ niệm đẹp', 'Sống chậm lại, nghĩ khác đi',
                'Đam mê xê dịch và khám phá', 'Blog cá nhân của mình', 'Chào mừng bạn đến với thế giới của tôi',
                'Lan tỏa năng lượng tích cực', 'Giao lưu và học hỏi mỗi ngày'
            ];
            const categories = ['Blogger', 'Digital creator', 'Video creator', 'Personal blog', 'Just for fun'];
            
            const randomName = pageNames[Math.floor(Math.random() * pageNames.length)] + ' ' + Math.floor(Math.random() * 9999);
            const randomBio = bios[Math.floor(Math.random() * bios.length)];
            const randomCat = categories[Math.floor(Math.random() * categories.length)];
            
            this.log(`Bắt đầu nhập tên trang: ${randomName}`);
            let nameInput = page.getByLabel(/Tên Trang|Tên trang|Page name/i).first();
            if (await nameInput.count() === 0) {
               // Fallback in case aria-label or label tag is missing
               nameInput = page.locator('input[aria-label*="Tên"], input[aria-label*="Name"]').first();
            }
            await nameInput.click();
            await this.automation.wait(500);
            await page.keyboard.type(randomName, { delay: this.automation.randomWait(100, 250) });

            this.log(`Nhập hạng mục (Category): ${randomCat}`);
            let catInput = page.getByLabel(/Hạng mục|Category/i).first();
            if (await catInput.count() === 0) {
               catInput = page.locator('input[aria-label*="Hạng mục"], input[aria-label*="Category"]').first();
            }
            await catInput.click();
            await this.automation.wait(500);
            await page.keyboard.type(randomCat, { delay: this.automation.randomWait(100, 200) });
            await this.automation.wait(3000); // Chờ Facebook gọi API tìm Category (tăng lên 3s)
            
            // Click vào mục đầu tiên trong dropdown (tin cậy hơn ArrowDown + Enter)
            const dropdownOption = page.locator('[role="option"], [role="listitem"], ul[role="listbox"] li, div[role="menuitem"]').first();
            try {
                await dropdownOption.waitFor({ state: 'visible', timeout: 5000 });
                await dropdownOption.click();
                this.log('Chọn Category từ dropdown thành công!');
            } catch {
                // Fallback: thử dùng phím
                await page.keyboard.press('ArrowDown');
                await this.automation.wait(300);
                await page.keyboard.press('Enter');
                this.log('Chọn Category bằng phím (fallback).');
            }
            await this.automation.wait(1000);

            this.log(`Nhập tiểu sử (Bio): ${randomBio}`);
            let bioInput = page.getByLabel(/Tiểu sử|Bio/i).first();
            if (await bioInput.count() === 0) {
                bioInput = page.locator('textarea[aria-label*="Tiểu sử"], textarea[aria-label*="Bio"]').first();
            }
            await bioInput.click();
            await page.keyboard.type(randomBio, { delay: this.automation.randomWait(100, 200) });
            await this.automation.wait(500);

            this.log('Bấm nút Tạo Trang...');
            const createBtn = page.locator('div[role="button"]').filter({ hasText: /Tạo Trang|Create Page/i });
            await createBtn.first().click();
            
            // Chờ Facebook xử lý
            this.log('Đang chờ Facebook duyệt Page (Khoảng 10-15s)...');
            await this.automation.wait(10000);
            
            // Kiểm tra xem có lỗi không
            const errorVisible = await page.getByText(/An error occurred|xảy ra lỗi|not available|không khả dụng|policies/i).isVisible().catch(() => false);
            if (errorVisible) {
                this.log('Facebook từ chối tạo Page (Policy Error). Tài khoản này có thể bị hạn chế.');
                return { success: false, msg: 'Facebook từ chối tạo Page do vi phạm chính sách hoặc tài khoản bị hạn chế.' };
            }

            // 8. Tải Avatar
            if (avatarPath) {
                this.log('Up Avatar lên cho mặt mũi sáng sủa...');
                try {
                    const fileInput = await page.$('input[type="file"]');
                    if (fileInput) {
                        await fileInput.setInputFiles(avatarPath);
                        this.log('Up Avatar thành công!');
                        await this.automation.wait(5000);
                    }
                } catch(e) {
                    this.log('Không tìm thấy nút Up Avatar, bỏ qua bước này.');
                }
            }

            // Bấm nút Lưu/Tiếp tục cuối cùng
            try {
                await page.getByRole('button', { name: 'Save' }).click();
            } catch(e) {}
            
            this.log('Tạo Page thành công! Đang lưu vào chế độ NGÂM GIẤM...');
            await this.automation.wait(3000);

            // Xóa ảnh để rác
            if (avatarPath && fs.existsSync(avatarPath)) {
                fs.unlinkSync(avatarPath);
            }

            // 9. Đi tương tác dạo bằng tư cách của Page để tăng Trust
            this.log('Đang dắt Page mới đi dạo (Watch/Newsfeed) để nhặt Trust...');
            try {
                await page.goto('https://www.facebook.com/watch/', { waitUntil: 'domcontentloaded' });
                await this.automation.wait(3000);
                await this.automation.simulateScroll(page, 10000); // Lướt Watch 10 giây
                this.log('Lướt xem Video xong!');
            } catch (e) {
                this.log('Lỗi khi lướt Watch, bỏ qua.');
            }

            this.log(`Hoàn thành tạo Page: ${randomName}!`);
            return { success: true, msg: 'Tạo Page thành công', pageName: randomName };

        } catch (e: any) {
            this.log(`Lỗi không mong muốn: ${e.message}`);
            return { success: false, msg: e.message };
        } finally {
            this.log('Đóng trình duyệt, xóa dấu vết...');
            if (context) await context.close();
            
            if (virtualIp) {
                this.log('Tháo gỡ IPv6 ảo...');
                await this.ipv6Service.unbindCurrentIp();
            }
        }
    }
}
