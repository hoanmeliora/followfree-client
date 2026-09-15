import * as http from 'http'
import * as net from 'net'
import { URL } from 'url'

export class LocalProxyService {
  private server: http.Server
  private bindIp: string | null = null
  private port: number = 8888

  constructor() {
    this.server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('Local Proxy is running')
    })

    // Xử lý các request HTTPS (CONNECT method)
    this.server.on('connect', (req, clientSocket, head) => {
      const { port, hostname } = new URL(`http://${req.url}`)
      
      const serverSocket = net.connect({
        port: Number(port || 443),
        host: hostname,
        localAddress: this.bindIp || undefined, // ÉP ĐI QUA IPV6 ẢO
        family: this.bindIp?.includes(':') ? 6 : undefined
      }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        serverSocket.write(head)
        serverSocket.pipe(clientSocket)
        clientSocket.pipe(serverSocket)
      })

      serverSocket.on('error', (err) => {
        // console.error(`Proxy connection error for ${hostname}:`, err.message)
        clientSocket.end()
      })
      
      clientSocket.on('error', () => {
        serverSocket.end()
      })
    })
  }

  start(port = 8888) {
    if (this.server.listening) {
      if (this.port === port) {
        console.log(`✅ Local Proxy already listening on 127.0.0.1:${this.port}`)
        return;
      }
      this.stop();
    }
    this.port = port
    
    // Bắt lỗi EADDRINUSE nếu cổng đang bị ứng dụng khác chiếm dụng
    this.server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`⚠️ Cổng ${this.port} đang bị chiếm dụng bởi ứng dụng khác.`)
      }
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`✅ Local Proxy listening on 127.0.0.1:${this.port}`)
    })
  }

  setBindIp(ip: string | null) {
    this.bindIp = ip
    console.log(`🔄 Local Proxy outbound IP switched to: ${ip || 'Default OS IP'}`)
  }

  stop() {
    if (this.server.listening) {
      this.server.close()
    }
  }
}
