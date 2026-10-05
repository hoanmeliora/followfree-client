export class SupabaseOtpService {
  private targetEmail: string;
  private supabaseUrl: string;
  private supabaseKey: string;

  constructor(targetEmail: string, supabaseUrl: string, supabaseKey: string) {
    this.targetEmail = targetEmail;
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
  }

  public async fetchLatestOtp(maxWaitTimeMs: number = 60000, onLog?: (msg: string) => void): Promise<string | null> {
    const log = onLog || console.log;
    const startTime = Date.now();

    log(`[SupabaseOTP] Bắt đầu tìm mã OTP cho email: ${this.targetEmail} qua hệ thống Supabase...`);

    return new Promise((resolve) => {
      let isResolved = false;

      const checkInterval = setInterval(async () => {
        if (Date.now() - startTime > maxWaitTimeMs) {
          if (!isResolved) {
            isResolved = true;
            clearInterval(checkInterval);
            log('[SupabaseOTP] Đã hết thời gian chờ mà không thấy mã OTP.');
            resolve(null);
          }
          return;
        }

        try {
          // Gọi API lên Supabase để lấy OTP
          const res = await fetch(`${this.supabaseUrl}/rest/v1/otps?email=eq.${encodeURIComponent(this.targetEmail)}&select=otp`, {
            method: 'GET',
            headers: {
              'apikey': this.supabaseKey,
              'Authorization': `Bearer ${this.supabaseKey}`,
              'Content-Type': 'application/json'
            }
          });

          if (res.ok) {
            const data = await res.json();
            if (data && data.length > 0 && data[0].otp) {
              const otp = data[0].otp;
              if (!isResolved) {
                isResolved = true;
                log(`[SupabaseOTP] Tuyệt vời! Đã lấy được OTP qua Supabase: ${otp}`);
                clearInterval(checkInterval);
                resolve(otp);
                return;
              }
            }
          }
        } catch (err: any) {
          log(`[SupabaseOTP] Lỗi khi check API: ${err.message}`);
        }
      }, 3000); // Mỗi 3s gọi API một lần
    });
  }
}
