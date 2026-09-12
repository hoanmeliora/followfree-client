import Imap from 'imap-simple';
import { simpleParser } from 'mailparser';

export class ImapService {
  private config: any;

  constructor(email: string, appPassword: string) {
    this.config = {
      imap: {
        user: email,
        password: appPassword,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 10000,
        tlsOptions: { rejectUnauthorized: false }
      }
    };
  }

  // Chờ và đọc OTP của một email mục tiêu
  public async fetchLatestOtp(targetEmail: string, maxWaitTimeMs: number = 60000, onLog?: (msg: string) => void): Promise<string | null> {
    const log = onLog || console.log;
    const startTime = Date.now();

    return new Promise(async (resolve) => {
      let connection: any = null;
      let checkInterval: NodeJS.Timeout;

      try {
        log(`[IMAP] Đang kết nối tới Gmail ${this.config.imap.user}...`);
        connection = await Imap.connect(this.config);
        
        // Thử mở Tất cả thư (All Mail) để tìm cả trong Spam, nếu lỗi thì fallback về INBOX
        try {
            await connection.openBox('[Gmail]/All Mail');
        } catch(e) {
            try {
                await connection.openBox('[Gmail]/Tất cả thư');
            } catch (e2) {
                await connection.openBox('INBOX');
            }
        }
        
        log(`[IMAP] Kết nối thành công! Đang chờ thư từ FB gửi tới ${targetEmail}...`);

        const searchCriteria = [
          ['FROM', 'registration@facebookmail.com']
        ];
        
        const fetchOptions = {
          bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'],
          markSeen: true
        };

        checkInterval = setInterval(async () => {
          if (Date.now() - startTime > maxWaitTimeMs) {
            clearInterval(checkInterval);
            if (connection) connection.end();
            log('[IMAP] Đã hết thời gian chờ (60s) mà không thấy mã OTP.');
            resolve(null);
            return;
          }

          try {
            const messages = await connection.search(searchCriteria, fetchOptions);
            
            for (const msg of messages) {
              const headerPart = msg.parts.find((p: any) => p.which === 'HEADER.FIELDS (FROM TO SUBJECT DATE)');
              const textPart = msg.parts.find((p: any) => p.which === 'TEXT');
              
              if (!headerPart || !textPart) continue;

              const subject = headerPart.body.subject ? headerPart.body.subject[0] : '';
              
              // Tách mã OTP (5 đến 8 chữ số) từ tiêu đề "FB-123456 is your Facebook confirmation code"
              const match = subject.match(/(?:FB-)?(\d{5,8})/);
              if (match) {
                const otp = match[1];
                log(`[IMAP] Tuyệt vời! Đã lấy được mã OTP: ${otp}`);
                clearInterval(checkInterval);
                if (connection) connection.end();
                resolve(otp);
                return;
              }
            }
          } catch (err: any) {
            log(`[IMAP] Lỗi khi tìm kiếm thư: ${err.message}`);
          }
        }, 5000); // Check mỗi 5s

      } catch (err: any) {
        log(`[IMAP] Lỗi kết nối IMAP: ${err.message}`);
        resolve(null);
      }
    });
  }
}
