# Bale–Telegram private relay

پل Node.js برای ارتباط خصوصی دو کاربر مشخص، همراه با صف ماندگار رمزگذاری‌شده و اجرای PM2.

این مخزن عمومی هیچ شناسهٔ شخصی، نام ربات واقعی، توکن یا کلید رمزگذاری پیش‌فرض ندارد. هویت هر دو کاربر و ربات‌ها فقط در `.env` محلی تنظیم می‌شود. هر اجرا فقط یک کاربر بله و یک کاربر تلگرام را می‌پذیرد.

- [راهنمای نصب و اجرا](./README.fa.md)
- [راه‌اندازی سرور Linux با PM2](./deploy/PM2.fa.md)
- [بررسی مستندات و محدودیت‌ها](./RESEARCH.fa.md)
- [نتیجهٔ آزمون‌ها](./VALIDATION.md)

مخزن: [fanavarhub/bale-telegram-bridge-public](https://github.com/fanavarhub/bale-telegram-bridge-public)

Requires Node.js 24 or newer. No third-party application dependencies. Keep `.env`, encryption keys, queue data and backups outside Git. Run `npm test` for the mocked suite; verify real delivery separately.
