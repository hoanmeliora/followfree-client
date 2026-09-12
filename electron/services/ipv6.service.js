"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Ipv6Service = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class Ipv6Service {
    constructor() {
        this.basePrefix = '';
        this.currentVirtualIp = null;
        this.networkInterfaceName = '';
        this.detectNetworkInterface();
    }
    async detectNetworkInterface() {
        if (process.platform === 'darwin') {
            this.networkInterfaceName = 'en0'; // Default Wifi on Mac
        }
        else if (process.platform === 'win32') {
            try {
                const { stdout } = await execAsync('netsh interface ipv6 show address');
                if (stdout.includes('Wi-Fi'))
                    this.networkInterfaceName = 'Wi-Fi';
                else if (stdout.includes('Ethernet'))
                    this.networkInterfaceName = 'Ethernet';
            }
            catch (e) {
                console.error('Error detecting Windows network interface:', e);
            }
        }
    }
    async getBasePrefix() {
        try {
            if (process.platform === 'darwin') {
                const { stdout } = await execAsync('ifconfig en0');
                const lines = stdout.split('\n');
                for (const line of lines) {
                    if (line.includes('inet6') && !line.includes('fe80::') && !line.includes('temporary')) {
                        const ipv6 = line.trim().split(' ')[1];
                        const blocks = ipv6.split(':');
                        if (blocks.length >= 4) {
                            this.basePrefix = blocks.slice(0, 4).join(':');
                            return this.basePrefix;
                        }
                    }
                }
            }
            else if (process.platform === 'win32') {
                const { stdout } = await execAsync('ipconfig');
                const lines = stdout.split('\n');
                for (const line of lines) {
                    if (line.includes('IPv6 Address')) {
                        const ipv6 = line.split(' : ')[1].trim();
                        const blocks = ipv6.split(':');
                        if (blocks.length >= 4) {
                            this.basePrefix = blocks.slice(0, 4).join(':');
                            return this.basePrefix;
                        }
                    }
                }
            }
            return null;
        }
        catch (e) {
            console.error('Error getting base prefix:', e);
            return null;
        }
    }
    generateRandomIpv6() {
        if (!this.basePrefix)
            throw new Error('No IPv6 prefix detected on this network');
        // Sinh ngẫu nhiên 4 block cuối (64 bit host)
        const randomBlock = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0');
        this.currentVirtualIp = `${this.basePrefix}:${randomBlock()}:${randomBlock()}:${randomBlock()}:${randomBlock()}`;
        return this.currentVirtualIp;
    }
    async bindIpToSystem(ip) {
        if (!this.networkInterfaceName)
            return false;
        try {
            console.log(`Binding IPv6 ${ip} to ${this.networkInterfaceName}...`);
            if (process.platform === 'darwin') {
                // macOS requires sudo. 
                await execAsync(`sudo ifconfig ${this.networkInterfaceName} inet6 ${ip}/64 alias`);
            }
            else {
                await execAsync(`netsh interface ipv6 add address "${this.networkInterfaceName}" ${ip}`);
            }
            return true;
        }
        catch (e) {
            console.error('Error binding IPv6 (Run as Admin/Root required):', e.message);
            return false;
        }
    }
    async unbindCurrentIp() {
        if (!this.currentVirtualIp || !this.networkInterfaceName)
            return;
        try {
            console.log(`Unbinding IPv6 ${this.currentVirtualIp}...`);
            if (process.platform === 'darwin') {
                await execAsync(`sudo ifconfig ${this.networkInterfaceName} inet6 ${this.currentVirtualIp}/64 -alias`);
            }
            else {
                await execAsync(`netsh interface ipv6 delete address "${this.networkInterfaceName}" ${this.currentVirtualIp}`);
            }
            this.currentVirtualIp = null;
        }
        catch (e) {
            console.error('Error unbinding IPv6:', e.message);
        }
    }
}
exports.Ipv6Service = Ipv6Service;
