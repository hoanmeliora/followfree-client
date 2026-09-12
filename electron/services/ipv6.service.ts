import { exec } from 'child_process'
import { promisify } from 'util'
import * as os from 'os'

const execAsync = promisify(exec)

export class Ipv6Service {
  private basePrefix: string = ''
  private currentVirtualIp: string | null = null
  private networkInterfaceName: string = ''

  constructor() {
    this.detectNetworkInterface()
  }

  private async detectNetworkInterface() {
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execAsync("route get default | grep interface | awk '{print $2}'")
        this.networkInterfaceName = stdout.trim() || 'en0'
      } catch (e) {
        this.networkInterfaceName = 'en0'
      }
    } else if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync('netsh interface ipv6 show address')
        if (stdout.includes('Wi-Fi')) this.networkInterfaceName = 'Wi-Fi'
        else if (stdout.includes('Ethernet')) this.networkInterfaceName = 'Ethernet'
      } catch (e) {
        console.error('Error detecting Windows network interface:', e)
      }
    }
  }

  async getBasePrefix(): Promise<string | null> {
    try {
      let prefix: string | null = null
      if (process.platform === 'darwin') {
        prefix = await this.detectMacBasePrefix()
      } else if (process.platform === 'win32') {
        prefix = await this.detectWindowsBasePrefix()
      }

      if (!prefix) return null

      // BƯỚC XÁC THỰC QUAN TRỌNG:
      // OS có thể báo có IPv6 (do cache cũ hoặc router cấp sai) nhưng không ra được Internet.
      // Cần ping/fetch thực tế để xác nhận.
      console.log(`[IPv6] Đang kiểm tra kết nối Internet thực tế của prefix ${prefix}...`)
      const isRoutable = await this.checkIpv6Connectivity()
      if (!isRoutable) {
        console.warn(`[IPv6] ⚠️ Prefix ${prefix} là ảo/stale! Không thể truy cập Internet IPv6.`)
        return null
      }

      console.log(`[IPv6] ✅ Prefix ${prefix} đã được xác thực có thể ra Internet.`)
      return prefix
    } catch (e) {
      console.error('[IPv6] Error getting base prefix:', e)
      return null
    }
  }

  private async checkIpv6Connectivity(): Promise<boolean> {
    const endpoints = [
      'https://ipv6.google.com',
      'https://v6.ident.me'
    ];

    const checkEndpoint = (url: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const req = require('https').get(url, {
          timeout: 5000,
          family: 6 // Ép buộc dùng IPv6
        }, (res: any) => {
          // Kiểm tra chắc chắn socket đã kết nối bằng IPv6 (có chứa dấu :)
          if (res.socket && res.socket.remoteAddress && res.socket.remoteAddress.includes(':')) {
            resolve(true);
          } else {
            resolve(false);
          }
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
    };

    // Kiểm tra đồng loạt, nếu TẤT CẢ đều thất bại thì mới kết luận là không có IPv6
    try {
      const results = await Promise.all(endpoints.map(checkEndpoint));
      return results.some(result => result === true);
    } catch (e) {
      return false;
    }
  }

  /**
   * Quét tất cả các interface mạng phổ biến trên macOS (en0=WiFi, en1=Ethernet/USB, en2+...).
   * Ưu tiên địa chỉ STABLE (autoconf), fallback sang TEMPORARY nếu không tìm được.
   * Lý do: macOS Privacy Extensions có thể gắn nhãn tất cả địa chỉ là "temporary".
   */
  private async detectMacBasePrefix(): Promise<string | null> {
    // Quét tất cả interfaces bằng ifconfig -a thay vì hard-code en0
    const { stdout } = await execAsync('ifconfig -a')
    const lines = stdout.split('\n')

    let stablePrefix: string | null = null
    let temporaryPrefix: string | null = null

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('inet6')) continue
      if (trimmed.includes('fe80::')) continue       // Skip link-local
      if (trimmed.includes('::1')) continue          // Skip loopback

      // Lấy địa chỉ IPv6 (token thứ 2 sau "inet6")
      const parts = trimmed.split(/\s+/)
      const ipv6Raw = parts[1]?.replace(/%.*$/, '') // bỏ scope id (VD: %en0)
      if (!ipv6Raw) continue

      const blocks = ipv6Raw.split(':')
      if (blocks.length < 4) continue

      // CHỈ CHẤP NHẬN GLOBAL UNICAST ADDRESS (GUA) - Bắt đầu bằng 2 hoặc 3 (VD: 2001:, 2404:)
      // Bỏ qua ULA (fd/fc) hoặc Link-local (fe80)
      if (!blocks[0].match(/^[23]/)) continue

      const prefix = blocks.slice(0, 4).join(':')
      const isTemporary = trimmed.includes('temporary')

      if (!isTemporary && !stablePrefix) {
        stablePrefix = prefix
      }
      if (isTemporary && !temporaryPrefix) {
        temporaryPrefix = prefix
      }
    }

    // Ưu tiên stable, fallback sang temporary
    const prefix = stablePrefix || temporaryPrefix
    if (prefix) {
      this.basePrefix = prefix
      console.log(`[IPv6] ✅ Tìm thấy prefix: ${prefix} (stable=${!!stablePrefix})`)
      return prefix
    }

    return null
  }

  private async detectWindowsBasePrefix(): Promise<string | null> {
    const { stdout } = await execAsync('ipconfig')
    const lines = stdout.split('\n')
    for (const line of lines) {
      if (line.includes('IPv6 Address')) {
        const ipv6 = line.split(' : ')[1]?.trim()
        if (!ipv6) continue
        const blocks = ipv6.split(':')
        if (blocks.length >= 4) {
          // Chỉ lấy IPv6 Public (GUA) bắt đầu bằng 2 hoặc 3
          if (!blocks[0].match(/^[23]/)) continue

          this.basePrefix = blocks.slice(0, 4).join(':')
          return this.basePrefix
        }
      }
    }
    return null
  }



  /**
   * Sinh IPv6 NGẪU NHIÊN (chỉ dùng 1 lần duy nhất khi gán cho nick mới)
   */
  generateRandomIpv6(): string {
    if (!this.basePrefix) throw new Error('No IPv6 prefix detected on this network')
    const randomBlock = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0')
    this.currentVirtualIp = `${this.basePrefix}:${randomBlock()}:${randomBlock()}:${randomBlock()}:${randomBlock()}`
    return this.currentVirtualIp
  }

  /**
   * Sinh IPv6 CỐ ĐỊNH từ accountId (deterministic).
   * Cùng 1 accountId + prefix → luôn ra cùng 1 IPv6, không bao giờ thay đổi.
   * Đây là IPv6 "dấu vân tay" gắn với nick từ lúc assign đến mãi mãi.
   */
  generateFixedIpv6ForAccount(accountId: string): string {
    if (!this.basePrefix) throw new Error('No IPv6 prefix detected on this network')

    // Hash accountId thành 4 block hex 16-bit (deterministic, không random)
    const hash = (s: string, seed: number) => {
      let h = seed
      for (let i = 0; i < s.length; i++) {
        h = Math.imul(31, h) + s.charCodeAt(i) | 0
      }
      return (Math.abs(h) % 65536).toString(16).padStart(4, '0')
    }

    const b1 = hash(accountId, 0x1a2b)
    const b2 = hash(accountId, 0x3c4d)
    const b3 = hash(accountId, 0x5e6f)
    const b4 = hash(accountId, 0x7a8b)

    const fixedIp = `${this.basePrefix}:${b1}:${b2}:${b3}:${b4}`
    this.currentVirtualIp = fixedIp
    return fixedIp
  }

  async bindIpToSystem(ip: string): Promise<boolean> {
    if (!this.networkInterfaceName) return false
    try {
      console.log(`Binding IPv6 ${ip} to ${this.networkInterfaceName}...`)
      if (process.platform === 'darwin') {
        // Đã cấu hình NOPASSWD trong /etc/sudoers.d/ nên dùng sudo -n sẽ chạy ngầm mượt mà
        await execAsync(`sudo -n ifconfig ${this.networkInterfaceName} inet6 ${ip}/64 alias`)
      } else {
        await execAsync(`netsh interface ipv6 add address "${this.networkInterfaceName}" ${ip}`)
      }
      return true
    } catch (e: any) {
      console.error('Error binding IPv6 (Run as Admin/Root required):', e.message)
      return false
    }
  }

  async unbindCurrentIp(): Promise<void> {
    if (!this.currentVirtualIp || !this.networkInterfaceName) return
    try {
      console.log(`Unbinding IPv6 ${this.currentVirtualIp}...`)
      if (process.platform === 'darwin') {
        await execAsync(`sudo -n ifconfig ${this.networkInterfaceName} inet6 ${this.currentVirtualIp}/64 -alias`)
      } else {
        await execAsync(`netsh interface ipv6 delete address "${this.networkInterfaceName}" ${this.currentVirtualIp}`)
      }
      this.currentVirtualIp = null
    } catch (e: any) {
      console.error('Error unbinding IPv6:', e.message)
    }
  }
}
