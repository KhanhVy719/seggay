const { JSDOM } = require('jsdom');

class JsdomSigner {
    constructor() {
        this.window = null;
        this.initPromise = null;
        this.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    }

    async init() {
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            if (this.window) return;

            console.log('[+] Đang khởi chạy JSDOM và tải trang bảo mật select-account từ TikTok...');
            const dom = await JSDOM.fromURL("https://business.tiktok.com/select-account", {
                resources: "usable", // Tải các tài nguyên ngoài như script
                runScripts: "dangerously", // Cho phép chạy script
                userAgent: this.userAgent,
                pretendToBeVisual: true
            });

            const window = dom.window;

            // Chờ đối tượng byted_acrawler sẵn sàng
            let ready = false;
            for (let i = 0; i < 150; i++) {
                if (window.byted_acrawler && typeof window.byted_acrawler.frontierSign === 'function') {
                    ready = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 100));
            }

            if (!ready) {
                window.close();
                throw new Error('Không tìm thấy window.byted_acrawler trên trang select-account.');
            }

            this.window = window;
            console.log('[+] JSDOM Signer đã khởi tạo thành công và sẵn sàng.');
        })();

        try {
            await this.initPromise;
        } catch (err) {
            this.initPromise = null;
            this.close();
            throw err;
        }
    }

    async sign(queryParams, userAgent) {
        await this.init();
        const ua = userAgent || this.userAgent;
        const targetUrl = `https://www.tiktok.com/api/upload/image/?${queryParams}`;
        
        try {
            const signObj = this.window.byted_acrawler.frontierSign({ url: targetUrl, userAgent: ua });
            const xBogus = signObj ? (signObj['X-Bogus'] || signObj) : null;
            return xBogus;
        } catch (e) {
            throw new Error(`Lỗi khi ký X-Bogus trong JSDOM: ${e.message}`);
        }
    }

    close() {
        if (this.window) {
            try {
                this.window.close();
            } catch (e) {}
            this.window = null;
            this.initPromise = null;
            console.log('[+] Đã đóng máy ảo JSDOM.');
        }
    }
}

module.exports = new JsdomSigner();
