import { session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { chromium } from 'playwright-extra';
import { BrowserContext, Page } from 'playwright';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { GmailWebService } from './gmail-web.service';
import { GmailApiService } from './gmail-api.service';
import { StoreService } from './store.service';
import { Ipv6Service } from './ipv6.service';
import { LocalProxyService } from './local-proxy.service';

chromium.use(stealthPlugin());

export class AutoRegService {
    private isRunning: boolean = false;
    private currentCount: number = 0;
    private targetCount: number = 0;
    private domain: string = '';
    private browserContext: BrowserContext | null = null;
    private browserPage: Page | null = null;
    private onLog?: (msg: string) => void;
    private gmailAccount: any = null;
    private gmailCookies: any[] = [];
    private storeService?: StoreService;
    private ipv6Service = new Ipv6Service();
    private localProxyService = new LocalProxyService();
    private hasClickedSubmit: boolean = false;
    private platform: string = 'facebook';
    private proxy: string = '';

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

    constructor(onLogCallback?: (msg: string) => void, storeService?: StoreService) {
        this.onLog = onLogCallback;
        this.storeService = storeService;
    }

    private log(msg: string) {
        console.log(msg);
        if (this.onLog) {
            this.onLog(msg);
        }
    }

    public startReg(config: { count: number; domain: string; proxy?: string; gmailList?: any[]; selectedGmailId?: string; platform?: string }) {
        if (this.isRunning) return { success: false, msg: 'Đang chạy rồi' };

        this.isRunning = true;
        this.hasClickedSubmit = false;
        this.currentCount = 0;
        this.targetCount = config.count;
        this.domain = config.domain;
        this.proxy = config.proxy || '';
        this.platform = config.platform || 'facebook';

        // Khởi tạo danh sách Gmail xoay vòng
        (this as any).gmailList = config.gmailList || [];
        (this as any).selectedGmailId = config.selectedGmailId || '';

        if ((this as any).gmailList.length > 0) {
            if ((this as any).selectedGmailId) {
                this.gmailAccount = (this as any).gmailList.find((g: any) => g.id === (this as any).selectedGmailId);
            }
            if (!this.gmailAccount) {
                this.gmailAccount = (this as any).gmailList[0];
            }
        }

        if (this.gmailAccount && this.gmailAccount.cookieData) {
            try {
                this.gmailCookies = JSON.parse(this.gmailAccount.cookieData);
            } catch (e) { }
        }

        this.log(`[Auto-Reg] Bắt đầu tạo ${config.count} nick cho tên miền ${config.domain || 'Mẹo Dấu Chấm'}...`);

        // Chạy bất đồng bộ vòng lặp tạo nick
        this.runLoop();

        return { success: true };
    }

    public async stopReg() {
        this.isRunning = false;
        this.localProxyService.setBindIp(null);
        if (this.browserContext) {
            await this.browserContext.browser()?.close();
            this.browserContext = null;
            this.browserPage = null;
        }
        return { success: true };
    }

    private async runLoop() {
        // 0. Khởi tạo Proxy nội bộ (IPv6) nếu người dùng không điền Proxy
        if (!this.proxy || this.proxy.trim() === '') {
            this.log('[Auto-Reg] Đang kiểm tra sóng IPv6 trên mạng Wifi của ngài...');
            this.localProxyService.start(8889); // Dùng cổng 8889 để tránh đụng độ với Worker (8888)
            const prefix = await this.ipv6Service.getBasePrefix();
            if (!prefix) {
                this.log('[Auto-Reg] 🛑 Dừng khẩn cấp: Mạng Wifi hiện tại không hỗ trợ IPv6.');
                this.log('[Auto-Reg] Vui lòng nhập Proxy vào giao diện hoặc đổi sang mạng có sóng IPv6.');
                this.isRunning = false;
                return; // Dừng hệ thống
            }
            this.log(`[Auto-Reg] ✅ Mạng có sóng IPv6! Bắt đầu cày với dải mạng: ${prefix}`);
        }

        while (this.isRunning && this.currentCount < this.targetCount) {
            this.currentCount++;
            this.log(`[Auto-Reg] Đang tạo nick thứ ${this.currentCount}/${this.targetCount}...`);

            try {
                await this.createOneAccount();
            } catch (err: any) {
                this.log(`[Auto-Reg] Lỗi khi tạo nick: ${err.message || err}`);
                // Dừng toàn bộ hệ thống nếu lỗi liên quan đến Mạng/IP hoặc Playwright bị kẹt do IPv6
                if (err.message && (err.message.includes('Mạng/IP') || err.message.includes('IPv6') || err.message.includes('Timeout') || err.message.includes('closed'))) {
                    if (this.ipv6Service.getBasePrefix() !== null && this.localProxyService['bindIp']) {
                        this.log('[Auto-Reg] 🛑 Dừng khẩn cấp: IPv6 ảo (không thể kết nối Internet qua IP đã gán).');
                        this.log('[Auto-Reg] Mạng của ngài chặn tạo nhiều IPv6. Vui lòng cày bằng 4G hoặc mua Proxy tĩnh.');
                    } else {
                        this.log('[Auto-Reg] 🛑 Dừng khẩn cấp hệ thống do lỗi Mạng/IP.');
                    }
                    this.isRunning = false;
                    break;
                }
            }

            // Nghỉ 5s trước khi tạo nick tiếp theo
            if (this.isRunning) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        this.isRunning = false;
        this.log('[Auto-Reg] Đã hoàn thành mẻ đăng ký!');
    }

    private rotateGmail() {
        if (!(this as any).gmailList || (this as any).gmailList.length <= 1) return false;
        const currentIndex = (this as any).gmailList.findIndex((g: any) => g.id === this.gmailAccount.id);
        const nextIndex = (currentIndex + 1) % (this as any).gmailList.length;
        this.gmailAccount = (this as any).gmailList[nextIndex];

        if (this.gmailAccount && this.gmailAccount.cookieData) {
            try {
                this.gmailCookies = JSON.parse(this.gmailAccount.cookieData);
            } catch (e) { }
        }
        return true;
    }

    private generateEmail(): string {
        if (this.domain && this.domain.trim() !== '') {
            const randomPrefix = Math.random().toString(36).substring(2, 10) + Math.floor(Math.random() * 9999);
            const cleanDomain = this.domain.replace('@', '').trim();
            return `${randomPrefix}@${cleanDomain}`;
        } else {
            if (!this.gmailAccount || !this.gmailAccount.username || !this.gmailAccount.username.includes('@gmail.com')) {
                throw new Error('Vui lòng nhập Tên miền Catch-All hoặc chọn một tài khoản Gmail hợp lệ để sử dụng!');
            }
            const [name, domainName] = this.gmailAccount.username.split('@');
            let dottedName = '';
            for (let i = 0; i < name.length; i++) {
                dottedName += name[i];
                if (i < name.length - 1 && Math.random() > 0.5) dottedName += '.';
            }
            return `${dottedName}@${domainName}`;
        }
    }

    private async createOneAccount() {
        // 1. Sinh cấu hình Fingerprint xịn (Apify)
        const { FingerprintGenerator } = require('fingerprint-generator');
        const { FingerprintInjector } = require('fingerprint-injector');

        const fingerprintGenerator = new FingerprintGenerator({
            browsers: [{ name: 'chrome', minVersion: 110 }, { name: 'safari', minVersion: 15 }],
            devices: ['mobile'],
            operatingSystems: ['ios', 'android'],
        });

        const fingerprint = fingerprintGenerator.getFingerprint();
        const fingerprintInjector = new FingerprintInjector();

        this.log(`[Auto-Reg] Khởi tạo Browser ẩn danh với dấu vân tay: ${fingerprint.fingerprint.navigator.userAgent}`);

        let proxyUrl: string | undefined = undefined;

        if (this.proxy && this.proxy.trim() !== '') {
            this.log(`[Auto-Reg] Sử dụng Proxy tĩnh: ${this.proxy}`);
            proxyUrl = this.proxy;
        } else {
            // Dùng IPv6 tự động xoay vòng
            try {
                const randomIpv6 = this.ipv6Service.generateFixedIpv6ForAccount('autoreg_' + Date.now());
                const bound = await this.ipv6Service.bindIpToSystem(randomIpv6);
                if (bound) {
                    this.localProxyService.setBindIp(randomIpv6);
                    await new Promise(r => setTimeout(r, 2000));
                    proxyUrl = 'http://127.0.0.1:8889';
                    this.log(`[Auto-Reg] Đã gán IPv6 tàng hình thành công: ${randomIpv6}`);
                } else {
                    throw new Error("Không thể bind IPv6, mạng không hỗ trợ");
                }
            } catch (e: any) {
                throw new Error(`Để bảo vệ tài khoản, Tool từ chối tạo nick bằng IP thật (do mạng Ethernet/Wifi của sếp không có IPv6). IP thật tạo nick sẽ bị Checkpoint ngay lập tức! Vui lòng nhập Proxy ngoài hoặc đổi sang mạng 4G/Wifi có IPv6.`);
            }
        }

        // 2. Khởi tạo Trình duyệt Playwright Ẩn (Sử dụng Google Chrome THẬT thay vì Chromium)
        const browser = await chromium.launch({
            headless: false, // Hiển thị theo yêu cầu của sếp
            channel: 'chrome',
            args: [
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security'
            ]
        });

        const contextOptions: any = {
            userAgent: fingerprint.fingerprint.navigator.userAgent,
            locale: fingerprint.fingerprint.navigator.language,
            viewport: { 
                width: fingerprint.fingerprint.screen.width || 390, 
                height: fingerprint.fingerprint.screen.height || 844 
            },
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: fingerprint.fingerprint.screen.devicePixelRatio || 2,
        };

        if (proxyUrl) {
            contextOptions.proxy = { server: proxyUrl };
        }

        this.browserContext = await browser.newContext(contextOptions);

        this.browserPage = await this.browserContext.newPage();

        // Bơm dấu vân tay siêu cấp vào mọi frame của trình duyệt
        await fingerprintInjector.attachFingerprintToPlaywright(
            this.browserContext,
            fingerprint
        );

        if (this.platform === 'gmail') {
            this.log('[Auto-Reg] Đang mở trình duyệt ẩn danh (đã fake IP + Vân tay) để tạo Gmail...');
            try {
                await this.browserPage.goto('https://accounts.google.com/signup', { waitUntil: 'networkidle' });
            } catch (e) { }

            // Không chạy tiếp vòng lặp tự động điền form
            this.isRunning = false;
            this.log('[Auto-Reg] Trình duyệt đã mở. Ngài có thể thao tác lập Gmail bằng tay an toàn mà không sợ Google soi phần cứng.');
            return;
        }

        try {
            // Khởi tạo Session Cookie chuẩn (Cực kỳ quan trọng để lách thuật toán Server)
            this.log('[Auto-Reg] Đang truy cập trang chủ để tạo Cookie (datr) hợp lệ...');
            try {
                await this.browserPage.goto('https://m.facebook.com', { waitUntil: 'networkidle' });
                await new Promise(r => setTimeout(r, 2000));
                
                // Thay vì chuyển hướng thẳng sang /reg (dễ bị đánh dấu bot), ta sẽ bấm nút "Tạo tài khoản mới" trên trang chủ
                this.log('[Auto-Reg] Đang bấm nút Tạo tài khoản mới...');
                const createBtnTexts = ['Tạo tài khoản mới', 'Create new account', 'Create New Account'];
                let clicked = false;
                for (const text of createBtnTexts) {
                    try {
                        const btn = this.browserPage.getByRole('button', { name: text }).first();
                        if (await btn.isVisible()) {
                            await btn.click();
                            clicked = true;
                            break;
                        }
                    } catch (e) {}
                    
                    try {
                        const linkBtn = this.browserPage.getByRole('link', { name: text }).first();
                        if (await linkBtn.isVisible()) {
                            await linkBtn.click();
                            clicked = true;
                            break;
                        }
                    } catch (e) {}
                }

                
                if (!clicked) {
                    // Fallback nếu không tìm thấy nút
                    this.log('[Auto-Reg] Không tìm thấy nút Tạo tài khoản, fallback sang /reg...');
                    await this.browserPage.goto('https://m.facebook.com/reg', { waitUntil: 'networkidle' });
                }
            } catch(e) {
                this.log('[Auto-Reg] Cảnh báo lỗi tải trang, vẫn tiếp tục...');
            }

            // Chờ tải form đăng ký (popup hoặc trang mới)
            await new Promise(r => setTimeout(r, 4000));
            this.log('[Auto-Reg] Trang đã tải, bắt đầu bơm dữ liệu giả...');

            // 3.5 Lựa chọn chiến lược sinh Email (Catch-All Domain hoặc Gmail Dot)
            let email = this.generateEmail();
            this.log(`[Auto-Reg] Dùng Email (Mẹo Đảo Chấm/Domain): ${email}`);

            // Tạo dữ liệu giả
            const data = this.generateDummyData();
            this.log(`[Auto-Reg] Thông tin giả lập: ${data.lastName} ${data.firstName} | ${email}`);

            // 4. Kịch bản điền form bằng Playwright
            let lastStepTime = Date.now();
            let loopCount = 0;
            let reachedOtp = false;

            while (Date.now() - lastStepTime < 60000 && this.isRunning) {
                loopCount++;
                await new Promise(r => setTimeout(r, 2000));

                try {
                    const url = this.browserPage.url();
                    
                    // Reset cờ combo nếu trang thay đổi (chuyển qua trang mới)
                    if (url !== (this as any).lastUrl) {
                        (this as any).hasFilledCombos = false;
                        (this as any).lastUrl = url;
                    }
                    
                    const bodyText = await this.browserPage.evaluate(() => document.body.textContent?.toLowerCase() || '');

                    // 1. Kiểm tra màn hình OTP
                    const isOtpScreen =
                        url.includes('confirmemail.php') ||
                        await this.browserPage.$('input[name="c"]') ||
                        await this.browserPage.$('input[name="code"]') ||
                        bodyText.includes('nhập mã xác nhận') ||
                        bodyText.includes('enter confirmation code') ||
                        bodyText.includes('enter the confirmation code') ||
                        bodyText.includes('mã gồm') ||
                        bodyText.includes('mã xác nhận') ||
                        bodyText.includes('confirm your account') ||
                        bodyText.includes('enter that code');

                    if (isOtpScreen) {
                        this.log("REACHED OTP!");
                        reachedOtp = true;
                        break;
                    }

                    // 2. Xử lý Form Đăng ký trên Giao diện Mobile (m.facebook.com)
                    let didFillSomething = false;
                    let hasError = false;

                    // 2.1 Cố gắng điền bằng ID/Name chuẩn
                    try {
                        const firstNameLoc = this.browserPage.locator('input[name="firstname"], input[aria-label="First name"], input[aria-label="Tên"]').first();
                        if (await firstNameLoc.isVisible() && !(await firstNameLoc.inputValue())) {
                            this.log('[Auto-Reg] Điền Tên');
                            await firstNameLoc.fill(data.firstName);
                            didFillSomething = true;
                        }

                        const lastNameLoc = this.browserPage.locator('input[name="lastname"], input[name="reg_email__"] ~ input[type="text"], input[aria-label="Surname"], input[aria-label="Họ"]').first();
                        if (await lastNameLoc.isVisible() && !(await lastNameLoc.inputValue())) {
                            this.log('[Auto-Reg] Điền Họ');
                            await lastNameLoc.fill(data.lastName);
                            didFillSomething = true;
                        }

                        const emailLoc = this.browserPage.locator('input[name="reg_email__"], input[type="email"], input[type="tel"]').first();
                        if (await emailLoc.isVisible()) {
                            const val = await emailLoc.inputValue();
                            if (val !== email) {
                                this.log('[Auto-Reg] Điền Email');
                                await emailLoc.fill(email);
                                didFillSomething = true;
                            }
                        }

                        const passLoc = this.browserPage.locator('input[name="reg_passwd__"], input[type="password"]').first();
                        if (await passLoc.isVisible() && !(await passLoc.inputValue())) {
                            this.log('[Auto-Reg] Điền Mật khẩu');
                            await passLoc.fill(data.password);
                            didFillSomething = true;
                        }
                    } catch (e) {}

                    // 2.2 Fallback nếu không tìm thấy Name/Aria-label (Dùng Index)
                    // 2.2 Fallback nếu không tìm thấy Name/Aria-label (Dùng Index)
                        const textInputs = await this.browserPage.$$('input[type="text"]');
                        const emailInputs = await this.browserPage.$$('input[type="email"], input[type="tel"]');
                        const passInputs = await this.browserPage.$$('input[type="password"]');

                        if (textInputs.length >= 2) {
                            const firstVal = await textInputs[0].inputValue();
                            if (!firstVal) {
                                this.log('[Auto-Reg] Điền Họ Tên (Fallback)');
                                await textInputs[0].fill(data.firstName);
                                await textInputs[1].fill(data.lastName);
                                didFillSomething = true;
                            }
                        }

                        if (emailInputs.length >= 1) {
                            const emailVal = await emailInputs[0].inputValue();
                            if (!emailVal || emailVal !== email) {
                                this.log('[Auto-Reg] Điền Email (Fallback)');
                                await emailInputs[0].fill(email);
                                didFillSomething = true;
                            }
                        } else if (textInputs.length >= 3) {
                            const emailVal = await textInputs[2].inputValue();
                            if (!emailVal || emailVal !== email) {
                                this.log('[Auto-Reg] Điền Email (Fallback Text)');
                                await textInputs[2].fill(email);
                                didFillSomething = true;
                            }
                        }

                        if (passInputs.length >= 1) {
                            const passVal = await passInputs[0].inputValue();
                            if (!passVal) {
                                this.log('[Auto-Reg] Điền Mật khẩu (Fallback)');
                                await passInputs[0].fill(data.password);
                                didFillSomething = true;
                            }
                        }

                    // 2.3 Điền Select (Ngày sinh & Giới tính)
                    try {
                        if (!(this as any).hasFilledCombos) {

                        const injectedFill = await this.browserPage.evaluate((d) => {
                            let filled = false;
                            
                            // Tuyệt chiêu kích hoạt React Synthetic Event khi sửa DOM bằng JS
                            const setReactValue = (elem: any, val: any) => {
                                const proto = Object.getPrototypeOf(elem);
                                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set || Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
                                if (setter) setter.call(elem, val);
                                else elem.value = val;
                                elem.dispatchEvent(new Event('change', { bubbles: true }));
                            };

                            const selects = Array.from(document.querySelectorAll('select'));
                            
                            // Tìm Select Ngày (chứa các số từ 1-31)
                            const daySel = selects.find(s => s.options.length >= 28 && s.options.length <= 32);
                            if (daySel && daySel.value !== d.day.toString()) {
                                setReactValue(daySel, d.day.toString());
                                filled = true;
                            }
                            
                            // Tìm Select Tháng (chứa 12 tháng)
                            const monthSel = selects.find(s => s.options.length >= 12 && s.options.length <= 13);
                            if (monthSel && monthSel.value !== d.month.toString()) {
                                setReactValue(monthSel, d.month.toString());
                                filled = true;
                            }
                            
                            // Tìm Select Năm (chứa nhiều năm, thường > 50)
                            const yearSel = selects.find(s => s.options.length > 50);
                            if (yearSel && yearSel.value !== d.year.toString()) {
                                setReactValue(yearSel, d.year.toString());
                                filled = true;
                            }
                            
                            // Tìm Select Giới tính (Female/Male hoặc Nữ/Nam)
                            const targetGenderVal = d.gender === 'male' ? '2' : '1';
                            const genderSel = selects.find(s => s.innerText.includes('Female') || s.innerText.includes('Nữ'));
                            if (genderSel && genderSel.value !== targetGenderVal) {
                                let option = Array.from(genderSel.options).find(o => o.value === targetGenderVal);
                                if (!option && d.gender === 'male') option = Array.from(genderSel.options).find(o => o.text.includes('Male') || o.text.includes('Nam'));
                                if (!option && d.gender === 'female') option = Array.from(genderSel.options).find(o => o.text.includes('Female') || o.text.includes('Nữ'));
                                
                                if (option) {
                                    setReactValue(genderSel, option.value);
                                    filled = true;
                                }
                            }
                            
                            // Tìm Radio Giới tính (nếu có)
                            const maleRadio = document.querySelector('input[type="radio"][value="2"]') as HTMLInputElement;
                            const femaleRadio = document.querySelector('input[type="radio"][value="1"]') as HTMLInputElement;
                            if (maleRadio && femaleRadio) {
                                if (d.gender === 'male' && !maleRadio.checked) {
                                    maleRadio.click();
                                    filled = true;
                                } else if (d.gender !== 'male' && !femaleRadio.checked) {
                                    femaleRadio.click();
                                    filled = true;
                                }
                            }

                            return filled;
                        }, { day: data.day, month: data.month, year: data.year, gender: data.gender });

                        if (injectedFill) {
                            this.log('[Auto-Reg] Đã dùng Haki Bá Vương (JS Injection) ép điền Ngày Sinh & Giới Tính!');
                            didFillSomething = true;
                        } else {
                            // Fallback Click (dùng force: true để xuyên thủng lớp div chặn click của React)
                            const dayBox = this.browserPage.getByText('Day', { exact: true }).first();
                            if (await dayBox.isVisible().catch(()=>false)) {
                                this.log('[Auto-Reg] Click Ngày sinh (React Dropdown)');
                                await dayBox.click({ force: true }).catch(()=>{});
                                await this.browserPage.waitForTimeout(500);
                                await this.browserPage.getByText(data.day.toString(), { exact: true }).last().click({ force: true }).catch(()=>{});
                                didFillSomething = true;
                            }

                            const monthBox = this.browserPage.getByText('Month', { exact: true }).first();
                            if (await monthBox.isVisible().catch(()=>false)) {
                                this.log('[Auto-Reg] Click Tháng sinh (React Dropdown)');
                                await monthBox.click({ force: true }).catch(()=>{});
                                await this.browserPage.waitForTimeout(500);
                                const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                                await this.browserPage.getByText(monthNames[data.month - 1], { exact: false }).last().click({ force: true }).catch(()=>{});
                                didFillSomething = true;
                            }

                            const yearBox = this.browserPage.getByText('Year', { exact: true }).first();
                            if (await yearBox.isVisible().catch(()=>false)) {
                                this.log('[Auto-Reg] Click Năm sinh (React Dropdown)');
                                await yearBox.click({ force: true }).catch(()=>{});
                                await this.browserPage.waitForTimeout(500);
                                await this.browserPage.getByText(data.year.toString(), { exact: true }).last().click({ force: true }).catch(()=>{});
                                didFillSomething = true;
                            }

                            const genderBox = this.browserPage.getByText('Select your gender', { exact: true }).first();
                            if (await genderBox.isVisible().catch(()=>false)) {
                                this.log('[Auto-Reg] Click Giới tính (React Dropdown)');
                                await genderBox.click({ force: true }).catch(()=>{});
                                await this.browserPage.waitForTimeout(500);
                                await this.browserPage.getByText(data.gender === 'male' ? 'Male' : 'Female', { exact: true }).last().click({ force: true }).catch(()=>{});
                                didFillSomething = true;
                            }
                            // Đánh dấu đã chạy hàm dropdown fallback xong (dù thành công hay không, chỉ chạy 1 lần tránh lặp vô hạn)
                            (this as any).hasFilledCombos = true;
                        }
                        }

                    } catch (e) {
                        this.log('[Auto-Reg] Lỗi khi điền combobox: ' + e);
                    }

                    if (didFillSomething || !(this as any).hasClickedSubmit) {
                        lastStepTime = Date.now();
                        // Chờ một xíu rồi bấm nút Tiếp Tục hoặc Đăng Ký (nút chung trên các màn hình Mobile)
                        // Tự động cuộn xuống dưới cùng để nút hiện ra rõ ràng
                        await this.browserPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{});
                        await new Promise(r => setTimeout(r, 500));

                        // Cải tiến locator: Bắt mọi thẻ button hoặc thẻ div có role=button hoặc input type=submit
                        // Dùng getByRole để bắt chính xác các nút bấm có nhãn Tiếp tục/Đăng ký trên mọi ngôn ngữ
                        const nextBtn = this.browserPage.getByRole('button', { name: /Next|Tiếp|Tiếp tục|Sign Up|Sign up|Đăng ký|Submit/i }).last();
                        
                        if (await nextBtn.isVisible()) {
                            this.log('[Auto-Reg] Bấm nút Tiếp tục/Đăng ký...');
                            await nextBtn.click();
                            (this as any).hasClickedSubmit = true;
                            await new Promise(r => setTimeout(r, 2000));
                        } else {
                            this.log('[Auto-Reg] Không tìm thấy nút Submit, thử bấm Enter...');
                            await this.browserPage.keyboard.press('Enter');
                            (this as any).hasClickedSubmit = true;
                            await new Promise(r => setTimeout(r, 2000));
                        }
                        continue;
                    }

                    // Bắt buộc phải kiểm tra element hiển thị, không dùng textContent vì React ẩn sẵn các đoạn text lỗi trong DOM!
                    // Lọc bớt các từ khóa dễ gây nhầm lẫn.
                    const errorLocators = [
                        this.browserPage.getByText('đã được liên kết').first(),
                        this.browserPage.getByText('đã được sử dụng').first(),
                        this.browserPage.getByText('Already in use').first(),
                        this.browserPage.getByText('Too many users').first(),
                        this.browserPage.getByText('pending').first(),
                        this.browserPage.getByText('valid email').first()
                    ];

                    if (!hasError) {
                        for (const loc of errorLocators) {
                            if (await loc.isVisible().catch(() => false)) {
                                hasError = true;
                                break;
                            }
                        }
                    }

                    // Kiểm tra lỗi Mạng/IP/Trình duyệt (Lỗi chết người - Blocked by Facebook)
                    if ((this as any).hasClickedSubmit) {
                        const fatalLocators = [
                            this.browserPage.getByText('an error occurred during your registration').first(),
                            this.browserPage.getByText('đã xảy ra lỗi trong quá trình đăng ký').first()
                        ];
                        for (const loc of fatalLocators) {
                            if (await loc.isVisible().catch(() => false)) {
                                throw new Error(`Facebook chặn đăng ký (IP hoặc Vân tay bị cờ). Đang tự động đổi IP/Vân tay mới...`);
                            }
                        }
                    }

                    // Nếu có lỗi đỏ lòm ở ô Email -> Xoay vòng Email
                    if (hasError) {
                        (this as any).retryCount = ((this as any).retryCount || 0) + 1;
                        this.log(`[Auto-Reg] ⚠️ Bôi đỏ lỗi Email (Trùng lặp/Lỗi). Lần thử: ${(this as any).retryCount}/4`);

                        if ((this as any).retryCount >= 4) {
                            // Ban vĩnh viễn Gmail này vì đã bị cháy phôi
                            if (this.platform === 'facebook' && this.gmailAccount && this.storeService) {
                                this.storeService.updateAccountStatus(this.gmailAccount.id, 'error');
                                this.log(`[Auto-Reg] 🚫 Đã ĐÁNH DẤU LỖI vĩnh viễn Gmail: ${this.gmailAccount.username} do bị cháy phôi!`);
                            }

                            const rotated = this.rotateGmail();
                            if (rotated) {
                                this.log(`[Auto-Reg] 🔄 Đã xoay vòng sang Gmail mới: ${this.gmailAccount.username}`);
                                (this as any).retryCount = 0;
                            } else {
                                throw new Error(`Phát hiện lỗi từ Facebook: Trùng lặp hoặc dữ liệu không hợp lệ. Đã hết Gmail để xoay vòng.`);
                            }
                        } else {
                            // Xóa ô email để điền lại (Trên màn hình Mobile, nếu gặp lỗi trùng email nó sẽ văng lại màn hình điền email)
                            const emailInput = await this.browserPage.$('input[name="reg_email__"]');
                            if (emailInput && await emailInput.isVisible()) {
                                await emailInput.fill('');
                            }
                            email = this.generateEmail();
                            (this as any).hasClickedSubmit = false; // Reset cờ để vòng lặp tới nó click lại Submit
                            this.log(`[Auto-Reg] 🔄 Thử lại với Mẹo Đảo Chấm Mới: ${email}`);
                            await new Promise(r => setTimeout(r, 1000));
                        }
                        lastStepTime = Date.now();
                        continue;
                    }


                    // Không cần khối code "Bấm Đăng ký (Tìm nút Submit bằng Text)" ở đây nữa
                    // Vì luồng mobile đã tự động tìm và bấm nút Submit/Next ở bên trong khối if (didFillSomething) bên trên rồi
                    // Ta chỉ cập nhật hasClickedSubmit khi đã điền mật khẩu
                    const passLoc = this.browserPage.locator('input[name="reg_passwd__"], input[type="password"]').first();
                    if (await passLoc.isVisible() && didFillSomething) {
                        (this as any).hasClickedSubmit = true;
                    }

                } catch (err: any) {
                    this.log(`[Auto-Reg] Lỗi trong vòng lặp Playwright: ${err}`);
                    if (err.message && (err.message.includes('Lỗi Mạng') || err.message.includes('IP'))) {
                        throw err; // Thoát vòng lặp ngay lập tức và ném ra ngoài
                    }
                }
            }

            if (!reachedOtp) {
                throw new Error('Kịch bản bị kẹt hoặc quá thời gian (Timeout). Không tới được màn hình OTP.');
            }

            // 5. Đọc OTP bằng GmailWeb (Cookie Automation)
            this.log(`[Auto-Reg] Đang khởi động Mắt Đọc GmailWeb để tìm mã OTP gửi tới ${email}...`);
            let otp: string | null = null;
            let gmailService: any;

            if (this.gmailAccount && this.gmailAccount.platform === 'GMAIL_OAUTH') {
                const parsedData = JSON.parse(this.gmailAccount.cookieData || '{}');
                const tokenData = parsedData.token ? parsedData.token : parsedData; // Backward compatible
                gmailService = new GmailApiService(tokenData);
                otp = await gmailService.fetchLatestOtp(120000, (msg: string) => this.log(msg));
            } else {
                gmailService = new GmailWebService(email, this.gmailCookies);
                otp = await gmailService.fetchLatestOtp(120000, (msg: string) => this.log(msg));
            }

            if (!otp) {
                this.log(`[Auto-Reg] Thử click "Tôi không nhận được mã" để yêu cầu gửi lại OTP...`);
                const resendBtn = await this.browserPage.$('text="Tôi không nhận được mã"') || await this.browserPage.$('text="Gửi lại mã"');
                if (resendBtn) await resendBtn.click();

                await new Promise(r => setTimeout(r, 5000));
                this.log(`[Auto-Reg] Đang chờ OTP lần 2 (thêm 120s)...`);
                otp = await gmailService.fetchLatestOtp(120000, (msg: any) => this.log(msg));
            }

            if (otp) {
                this.log(`[Auto-Reg] Bắt đầu điền mã OTP ${otp} vào Facebook...`);
                const otpInput = await this.browserPage.$('input[name="c"]') ||
                    await this.browserPage.$('input[name="code"]') ||
                    await this.browserPage.$('input[name="n"]') ||
                    await this.browserPage.$('input[type="text"]');

                if (otpInput) {
                    await otpInput.fill(otp);
                    await new Promise(r => setTimeout(r, 1000));

                    try {
                        let clicked = false;
                        const texts = ['Continue', 'Xác nhận', 'Tiếp'];
                        for (const text of texts) {
                            const btn = this.browserPage.getByText(text, { exact: true }).first();
                            if (await btn.isVisible().catch(() => false)) {
                                await btn.click();
                                clicked = true;
                                break;
                            }
                        }

                        if (!clicked) {
                            const fallbackBtn = this.browserPage.locator('input[type="submit"][name="submit"], button[name="reset_action"], button[type="submit"]').first();
                            if (await fallbackBtn.isVisible().catch(() => false)) {
                                await fallbackBtn.click();
                            }
                        }
                    } catch (e) {
                        this.log(`[Auto-Reg] Lỗi khi bấm nút xác nhận OTP: ${e}`);
                    }

                    this.log('[Auto-Reg] Đã điền mã OTP xong! Đợi Facebook xác nhận...');
                    await new Promise(r => setTimeout(r, 8000)); // Đợi kết quả
                    // Kiểm tra thành công bằng cookie
                    let cookies = await this.browserContext.cookies('https://www.facebook.com').catch(() => []);
                    let cUser = cookies.find(c => c.name === 'c_user');

                    if (!cUser) {
                        this.log(`[Auto-Reg] ⚠️ Không thấy đăng nhập thành công. Nếu ngài đang thao tác tay, hệ thống sẽ kiên nhẫn đợi thêm 3 phút...`);
                        for (let i = 0; i < 36; i++) {
                            if (!this.isRunning || !this.browserContext) break;
                            cookies = await this.browserContext.cookies('https://www.facebook.com').catch(() => []);
                            cUser = cookies.find(c => c.name === 'c_user');
                            if (cUser) {
                                this.log(`[Auto-Reg] 🎉 Bắt được tín hiệu thao tác tay thành công!`);
                                break;
                            }
                            await new Promise(r => setTimeout(r, 5000));
                        }
                    }

                    if (cUser) {
                        this.log(`[Auto-Reg] THÀNH CÔNG! Đã đăng ký thành công UID: ${cUser.value}`);
                        if (this.storeService) {
                            const newAcc = {
                                id: 'autoreg_' + cUser.value,
                                platform: 'FACEBOOK',
                                username: `${data.lastName} ${data.firstName} | ${email}`,
                                avatarUrl: '',
                                cookieData: JSON.stringify(cookies),
                                status: 'ACTIVE',
                                isManual: true,
                                userAgent: fingerprint.fingerprint.navigator.userAgent,
                                password: data.password
                            };
                            this.storeService.addAccounts([newAcc]);
                            this.log(`[Auto-Reg] Đã tự động thêm nick vào Hệ thống Quản Lý Người Dùng.`);

                            // [NURTURE] Tự động kết bạn sau khi reg xong
                            this.log(`[Auto-Reg] Bắt đầu đi dạo kết bạn dạo (Nurturing) để tài khoản cứng cáp hơn...`);
                            try {
                                await this.browserPage.goto('https://www.facebook.com/friends/suggestions', { waitUntil: 'networkidle' });
                                await new Promise(r => setTimeout(r, 5000));

                                const addFriendSelectors = [
                                    'div[aria-label="Thêm bạn bè"][role="button"]',
                                    'div[aria-label="Add friend"][role="button"]',
                                    'span:has-text("Thêm bạn bè")',
                                    'span:has-text("Add friend")'
                                ];

                                let friendsAdded = 0;
                                for (const selector of addFriendSelectors) {
                                    try {
                                        const buttons = await this.browserPage.locator(selector).all();
                                        if (buttons.length > 0) {
                                            // Yêu cầu của sếp: kết bạn 4-6 người
                                            const targetCount = Math.floor(Math.random() * 3) + 4;
                                            for (let i = 0; i < Math.min(buttons.length, targetCount); i++) {
                                                await buttons[i].scrollIntoViewIfNeeded();
                                                await new Promise(r => setTimeout(r, 1000));
                                                await buttons[i].click();
                                                friendsAdded++;
                                                this.log(`[Auto-Reg] Đã bấm Thêm bạn bè (${friendsAdded}). Tạm nghỉ...`);
                                                await new Promise(r => setTimeout(r, Math.random() * 3000 + 3000)); // Nghỉ 3-6s
                                            }
                                            break;
                                        }
                                    } catch (e) { }
                                }

                                if (friendsAdded > 0) {
                                    this.log(`[Auto-Reg] ✅ Đã hoàn thành quá trình đi dạo & kết bạn (${friendsAdded} người).`);
                                } else {
                                    this.log(`[Auto-Reg] Không tìm thấy gợi ý kết bạn nào ở thời điểm hiện tại.`);
                                }

                                // 2. Thêm ảnh đại diện
                                try {
                                    this.log(`[Auto-Reg] Bắt đầu tải ảnh đại diện AI...`);
                                    const avatarPath = await this.downloadRandomAvatar();
                                    this.log(`[Auto-Reg] Đang truy cập trang cá nhân để cập nhật Avatar...`);
                                    await this.browserPage.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded' });
                                    await new Promise(r => setTimeout(r, 4000));

                                    // Tìm nút Cập nhật ảnh đại diện (Camera icon)
                                    const updateAvatarBtn = this.browserPage.locator('[aria-label="Cập nhật ảnh đại diện"], [aria-label="Update profile picture"]').first();
                                    if (await updateAvatarBtn.isVisible()) {
                                        await updateAvatarBtn.click();
                                        await new Promise(r => setTimeout(r, 2000));

                                        // Lắng nghe sự kiện filechooser
                                        const [fileChooser] = await Promise.all([
                                            this.browserPage.waitForEvent('filechooser'),
                                            this.browserPage.locator('div[role="button"]').filter({ hasText: /Tải ảnh lên|Upload photo/i }).first().click()
                                        ]);
                                        await fileChooser.setFiles(avatarPath);
                                        this.log(`[Auto-Reg] Đã tải ảnh lên. Đợi xử lý và lưu...`);
                                        await new Promise(r => setTimeout(r, 4000));

                                        const saveBtn = this.browserPage.locator('div[role="button"]').filter({ hasText: /Lưu|Save/i }).first();
                                        await saveBtn.click();
                                        await new Promise(r => setTimeout(r, 6000));
                                        this.log(`[Auto-Reg] ✅ Cập nhật Avatar thành công!`);
                                    } else {
                                        this.log(`[Auto-Reg] Không tìm thấy nút cập nhật Avatar.`);
                                    }
                                } catch (e: any) {
                                    this.log(`[Auto-Reg] Lỗi khi cập nhật Avatar: ${e.message}`);
                                }

                                // 3. Lướt bản tin (News Feed)
                                try {
                                    this.log(`[Auto-Reg] Bắt đầu lướt News Feed dạo...`);
                                    await this.browserPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
                                    await new Promise(r => setTimeout(r, 3000));
                                    // Cuộn xuống 5 lần, mỗi lần cách nhau 2-4 giây
                                    for(let i=0; i<5; i++) {
                                        await this.browserPage.mouse.wheel(0, 500 + Math.random()*500);
                                        await new Promise(r => setTimeout(r, 2000 + Math.random()*2000));
                                    }
                                    this.log(`[Auto-Reg] ✅ Hoàn tất kịch bản Nurturing (Làm ấm)!`);
                                } catch (e: any) {
                                    this.log(`[Auto-Reg] Lỗi khi lướt News Feed: ${e.message}`);
                                }
                            } catch (err) {
                                this.log(`[Auto-Reg] Lỗi khi đi kết bạn tự động (Không quan trọng): ${err}`);
                            }
                        }
                    } else {
                        this.log(`[Auto-Reg] THẤT BẠI: Hết thời gian chờ. Chuyển sang nick tiếp theo.`);
                    }
                } // Kết thúc if (otpInput)
            } else { // Kết thúc if (otp)
                this.log('[Auto-Reg] THẤT BẠI: Không nhận được mã OTP.');
            }

        } catch (err: any) { // Bắt lỗi của try block to nhất
            if (!err.message?.includes('closed') && this.browserContext) {
                this.log(`[Auto-Reg] Kịch bản tự động gặp sự cố (${err.message}). Chuyển sang chế độ Hỗ trợ Thủ công!`);
                this.log(`[Auto-Reg] Xin ngài hãy thao tác nốt trên Trình duyệt đang mở. Hệ thống sẽ đợi 3 phút...`);

                let cUser: any = null;
                let cookies: any[] = [];
                for (let i = 0; i < 36; i++) {
                    if (!this.isRunning || !this.browserContext) break;
                    cookies = await this.browserContext.cookies('https://www.facebook.com').catch(() => []);
                    cUser = cookies.find((c: any) => c.name === 'c_user');
                    if (cUser) {
                        this.log(`[Auto-Reg] 🎉 Bắt được tín hiệu thao tác tay thành công!`);
                        break;
                    }
                    await new Promise(r => setTimeout(r, 5000));
                }

                if (cUser) {
                    this.log(`[Auto-Reg] THÀNH CÔNG! Đã đăng ký thành công UID: ${cUser.value}`);
                    if (this.storeService) {
                        const newAcc = {
                            id: 'autoreg_' + cUser.value,
                            platform: 'FACEBOOK',
                            username: `Ngài Chủ Nhân (Làm tay)`,
                            avatarUrl: '',
                            cookieData: JSON.stringify(cookies),
                            status: 'ACTIVE',
                            isManual: true,
                            userAgent: fingerprint.fingerprint.navigator.userAgent,
                            password: 'Unknown (Thao tác tay)'
                        };
                        this.storeService.addAccounts([newAcc]);
                        this.log(`[Auto-Reg] Đã tự động thêm nick vào Hệ thống Quản Lý Người Dùng.`);
                    }
                    return; // Đã xong, không ném lỗi nữa
                } else {
                    this.log(`[Auto-Reg] THẤT BẠI: Hết thời gian chờ 3 phút. Chuyển sang nick tiếp theo.`);
                }
            }

            // Đảm bảo lỗi văng ra để vòng lặp chính xử lý (nếu là lỗi mạng hoặc hết giờ làm tay)
            throw err;
        }

        // Đóng cửa sổ sau khi xong 1 nick
        if (this.browserContext) {
            await this.browserContext.browser()?.close();
            this.browserContext = null;
            this.browserPage = null;
        }
    }

    // Hàm tạo User-Agent giả
    private generateFingerprint() {
        // Để tối đa hóa khả năng thành công của Tool Reg, ta dùng User-Agent của Windows Desktop
        // Điều này ép Facebook phải trả về trang facebook.com/reg (HTML thuần) rất dễ để Bot điều khiển.
        return {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            platform: 'Windows'
        };
    }

    private generateDummyData() {
        const firstNames = ['Hoàng Hải', 'Minh Quân', 'Trung Đức', 'Tuấn Dũng', 'Thanh Hoa', 'Ngọc Lan', 'Hoàng Nam', 'Thu Trang', 'Quốc Hùng', 'Quang Minh'];
        const lastNames = ['Nguyễn', 'Trần', 'Phạm', 'Hoàng', 'Đặng', 'Huỳnh', 'Phan', 'Dương'];

        const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
        const ln = lastNames[Math.floor(Math.random() * lastNames.length)];

        const randomString = Math.random().toString(36).substring(2, 7);
        const rawUsername = (fn + ln + randomString).toLowerCase();
        const username = rawUsername.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");

        return {
            firstName: fn,
            lastName: ln,
            username: username,
            password: 'Aa1@' + Math.random().toString(36).substring(2, 10).toUpperCase(),
            day: Math.floor(Math.random() * 28) + 1,
            month: Math.floor(Math.random() * 12) + 1,
            year: 1990 + Math.floor(Math.random() * 10), // 1990 - 1999
            gender: Math.random() > 0.5 ? 'male' : 'female'
        };
    }
}
