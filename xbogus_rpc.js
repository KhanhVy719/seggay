const puppeteer = require('puppeteer');

class RpcSigner {
    constructor() {
        this.browser = null;
        this.page = null;
        this.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        this.initPromise = null;
    }

    async init() {
        // If already initializing, return the same promise to prevent concurrent launches
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = (async () => {
            if (this.browser && this.page) {
                return;
            }

            console.log('\n[+] Khởi chạy Puppeteer cho RPC Signer...');
            this.browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            });

            this.page = await this.browser.newPage();
            await this.page.setUserAgent(this.userAgent);

            console.log('[+] Đang truy cập select-account để lấy SDK bảo mật webmssdk...');
            await this.page.goto('https://business.tiktok.com/select-account', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            console.log('[+] Đang chờ window.byted_acrawler sẵn sàng...');
            await this.page.waitForFunction(() => {
                return window.byted_acrawler && typeof window.byted_acrawler.frontierSign === 'function';
            }, { timeout: 15000, polling: 100 });

            console.log('[+] RPC Signer đã sẵn sàng hoạt động.');
        })();

        try {
            await this.initPromise;
        } catch (err) {
            this.initPromise = null;
            await this.close();
            throw err;
        }
    }

    async sign(queryParams, customUserAgent) {
        // Automatically initialize if needed
        if (!this.browser || !this.page) {
            await this.init();
        }

        const ua = customUserAgent || this.userAgent;

        const result = await this.page.evaluate((qs, userAgentVal) => {
            const crawler = window.byted_acrawler;
            if (!crawler || typeof crawler.frontierSign !== 'function') {
                return { error: 'byted_acrawler.frontierSign not found inside page context' };
            }
            const targetUrl = `https://www.tiktok.com/api/upload/image/?${qs}`;
            try {
                const signObj = crawler.frontierSign({ url: targetUrl, userAgent: userAgentVal });
                const xBogus = signObj ? (signObj['X-Bogus'] || signObj) : null;
                return { success: true, xBogus };
            } catch (e) {
                return { error: e.message };
            }
        }, queryParams, ua);

        if (result.error) {
            throw new Error(`Lỗi ký X-Bogus trong trang: ${result.error}`);
        }

        return result.xBogus;
    }

    async close() {
        if (this.browser) {
            console.log('[+] Đóng trình duyệt Puppeteer RPC Signer...');
            try {
                await this.browser.close();
            } catch (e) {
                console.error('[-] Lỗi khi đóng Puppeteer:', e.message);
            }
            this.browser = null;
            this.page = null;
            this.initPromise = null;
        }
    }
}

module.exports = new RpcSigner();
