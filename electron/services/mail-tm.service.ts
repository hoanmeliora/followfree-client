export class MailTmService {
  private baseUrl = 'https://api.mail.tm';
  private token: string = '';
  public address: string = '';
  public accountId: string = '';

  // Khởi tạo một tài khoản email ngẫu nhiên
  public async createAccount(onLog?: (msg: string) => void): Promise<string | null> {
    const log = onLog || console.log;
    try {
      log('[Mail.tm] Lấy danh sách tên miền...');
      const domainsRes = await fetch(`${this.baseUrl}/domains`);
      if (!domainsRes.ok) throw new Error('Không lấy được domains');
      const domainsData = await domainsRes.json();
      const domain = domainsData['hydra:member'][0].domain;

      const randomString = Math.random().toString(36).substring(2, 10);
      this.address = `${randomString}@${domain}`;
      const password = 'Aa1@' + randomString;

      log(`[Mail.tm] Đang tạo tài khoản ${this.address}...`);
      const createRes = await fetch(`${this.baseUrl}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: this.address, password })
      });
      if (!createRes.ok) throw new Error('Lỗi tạo tài khoản');
      const accountData = await createRes.json();
      this.accountId = accountData.id;

      log(`[Mail.tm] Lấy Token xác thực...`);
      const tokenRes = await fetch(`${this.baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: this.address, password })
      });
      if (!tokenRes.ok) throw new Error('Lỗi lấy token');
      const tokenData = await tokenRes.json();
      this.token = tokenData.token;

      log(`[Mail.tm] Khởi tạo thành công Email ảo: ${this.address}`);
      return this.address;
    } catch (err: any) {
      log(`[Mail.tm] Thất bại: ${err.message}`);
      return null;
    }
  }

  // Chờ và đọc OTP
  public async fetchLatestOtp(maxWaitTimeMs: number = 120000, onLog?: (msg: string) => void): Promise<string | null> {
    const log = onLog || console.log;
    const startTime = Date.now();
    
    log(`[Mail.tm] Đang chờ thư từ Facebook gửi tới ${this.address}...`);

    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        if (Date.now() - startTime > maxWaitTimeMs) {
          clearInterval(checkInterval);
          log('[Mail.tm] Đã hết thời gian chờ mà không thấy mã OTP.');
          resolve(null);
          return;
        }

        try {
          const res = await fetch(`${this.baseUrl}/messages`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
          });
          
          if (!res.ok) return;
          const data = await res.json();
          const messages = data['hydra:member'];
          
          if (messages && messages.length > 0) {
            // Tìm thư có mã Facebook
            for (const msg of messages) {
              if (msg.from.address.includes('facebookmail.com')) {
                // Lấy nội dung chi tiết
                const detailRes = await fetch(`${this.baseUrl}/messages/${msg.id}`, {
                  headers: { 'Authorization': `Bearer ${this.token}` }
                });
                const detailData = await detailRes.json();
                const subject = detailData.subject || '';
                
                // Trích xuất mã 5 số
                const match = subject.match(/\b\d{5}\b/);
                if (match) {
                  clearInterval(checkInterval);
                  log(`[Mail.tm] Tìm thấy mã OTP: ${match[0]}`);
                  resolve(match[0]);
                  return;
                }
              }
            }
          }
        } catch (err) {
          // Ignore fetch errors during polling
        }
      }, 5000); // Polling mỗi 5 giây
    });
  }
}
