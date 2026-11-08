# اجرای پل با PM2 روی Linux

این روش برای Ubuntu/Debian دارای systemd، با Bash و ترجیحاً کاربر عادی دارای دسترسی sudo است. یک نمونهٔ fork اجرا می‌شود؛ چند نمونهٔ همزمان، cluster یا watch برای این ربات مناسب نیست. Docker و سرویس systemd مستقیم همین پروژه را همزمان با PM2 اجرا نکنید.

مخزن عمومی پروژه [fanavarhub/bale-telegram-bridge-public](https://github.com/fanavarhub/bale-telegram-bridge-public) است و clone آن به ورود GitHub نیاز ندارد. شناسه‌های واقعی، نام ربات‌ها، توکن و کلید فقط در `.env` سرور قرار می‌گیرند؛ هیچ مقدار شخصی پیش‌فرضی در مخزن عمومی نیست.

ابتدا هر دو کاربر مجاز در ربات سمت خود Start بزنند. سپس این بلوک را کامل در SSH اجرا کنید؛ اسکریپت توکن‌ها، شناسهٔ مجاز هر طرف و نام کاربری ربات‌ها را با ورودی مخفی فقط روی سرور می‌پرسد و کلید رمزگذاری را یک بار می‌سازد:

```bash
bash <<'BRIDGE_SETUP'
set -e
bridge_sudo=()
if [ "$(id -u)" -ne 0 ]; then
  bridge_sudo=(sudo)
fi
"${bridge_sudo[@]}" apt-get update
"${bridge_sudo[@]}" apt-get install -y git curl ca-certificates

# Install nvm for the current user; keep an existing installation.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  nvm_installer="$(mktemp)"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh -o "$nvm_installer"
  bash "$nvm_installer"
  rm -- "$nvm_installer"
fi
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
npm install -g pm2

mkdir -p "$HOME/apps"
cd "$HOME/apps"
git clone https://github.com/fanavarhub/bale-telegram-bridge-public.git bale-telegram-bridge
cd bale-telegram-bridge
bash deploy/setup-pm2.sh

# Register this same user's PM2 and Node path with systemd.
"${bridge_sudo[@]}" env "PATH=$PATH" "$(command -v pm2)" startup systemd -u "$(id -un)" --hp "$HOME"
pm2 save
pm2 logs bale-telegram-bridge --lines 50 --nostream
BRIDGE_SETUP
```

این بلوک برای نصب اول است. اگر پوشهٔ پروژه از قبل وجود دارد، `git clone` متوقف می‌شود و چیزی را جایگزین نمی‌کند؛ برای نصب موجود از دستور به‌روزرسانی پایین استفاده کنید. در نصب اول هیچ `npm install` داخل پروژه لازم نیست، چون کتابخانهٔ npm ثالث ندارد. فقط خود PM2 به شکل global در Node کاربر نصب می‌شود.

اسکریپت `setup-pm2.sh` فایل `.env` موجود را تغییر نمی‌دهد. اگر `.env` را قبلاً از نمونه کپی کرده‌اید و هنوز خالی است، آن را با ویرایشگر محلی کامل کنید و کلید را فقط یک بار با `npm run key --silent` بسازید. چهار متغیر `BALE_ALLOWED_USER_ID`، `TELEGRAM_ALLOWED_USER_ID`، `BALE_BOT_USERNAME` و `TELEGRAM_BOT_USERNAME` الزامی‌اند. در نبود آن‌ها، برنامه متوقف می‌شود و هیچ فرستنده‌ای خودکار مجاز نمی‌شود. توکن، شناسه‌های واقعی و کلید را در مخزن یا history دستور ننویسید و `.env` را در shell با `source` بارگذاری نکنید.

اگر `doctor` خطا داد، اسکریپت پیش از شروع/تغییر PM2 متوقف می‌شود. `auth`، نام ربات، مسیر شبکه یا `.env` را اصلاح و اسکریپت را دوباره اجرا کنید. اگر webhook قبلی فعال است، روال جایگزینی در README را انجام دهید؛ پل تا حذف webhook موجود شروع به دریافت نمی‌کند.

اگر پیام `existing_webhook_set_remove_flag_locally` دیده می‌شود، بات هنوز به یک گیرندهٔ webhook وصل است. برای مهاجرت به این پل، سرویس قبلیِ همین بات را متوقف کنید، برنامهٔ PM2 را stop کنید، در `.env` مقدار `REMOVE_EXISTING_WEBHOOK=true` بگذارید و با `pm2 startOrRestart ecosystem.config.cjs --update-env` اجرا کنید. برنامه هنگام شروع webhook را برمی‌دارد و برای حذف پیام‌های معوق درخواست نمی‌دهد. `doctor` خودش webhook را حذف نمی‌کند؛ با پیش‌فرض `false` این وضعیت را مانع polling می‌داند و قبل از اجرای PM2 خطا می‌دهد. پس از مهاجرت موفق می‌توانید پرچم را دوباره `false` کنید تا ایجاد webhook دیگری آشکار شود.

اگر `bootstrap_retry` با کد `network` تکرار می‌شود، خروجی تازهٔ `doctor` را بررسی کنید. `stage` مرحلهٔ شکست (`dns`، `tcp_tls` یا `http`) را نشان می‌دهد؛ مرحلهٔ `tcp_tls` شامل lookup تازه، TCP و TLS است. `errorCode` و `apiNetworkCode` فقط کدهای شناخته‌شدهٔ خطا را می‌نویسند. پیام خام خطا و URL حاوی توکن چاپ نمی‌شود. وصل‌بودن مرورگر یا ابزار دیگر، موفقیت اتصال همین فرایند Node را ثابت نمی‌کند.

برای مقایسهٔ اتصال مستقیم IPv4 و IPv6 و اولویت DNS در Node، بدون تغییر تنظیمات شبکه و بدون توقف پل:

```bash
curl -4 --noproxy '*' -sS -o /dev/null --connect-timeout 8 --max-time 15 -w 'IPv4 HTTP=%{http_code}\n' https://api.telegram.org/
curl -6 --noproxy '*' -sS -o /dev/null --connect-timeout 8 --max-time 15 -w 'IPv6 HTTP=%{http_code}\n' https://api.telegram.org/
node --env-file=.env src/doctor.js --samples=1
node --dns-result-order=ipv4first --env-file=.env src/doctor.js --samples=1
```

هر پاسخ واقعی HTTP در تست curl، دسترسی HTTPS همان مسیر را نشان می‌دهد؛ `HTTP=000` همراه با خطای curl نیازمند بررسی است. گزینهٔ Node در تست آخر فقط IPv4 را در ترتیب lookup ترجیح می‌دهد؛ نتیجهٔ مقایسه باید پیش از تغییر دائمی تنظیمات بررسی شود. ([راهنمای رسمی Node.js 24](https://nodejs.org/download/release/v24.22.1/docs/api/cli.html))

شناسهٔ چت بله به‌صورت پیش‌فرض از `BALE_ALLOWED_USER_ID` گرفته می‌شود. برای تأیید چت خصوصی، فقط وقتی پل متوقف است، از کاربر مجاز Start تازه بفرستید و اجرا کنید:

```bash
pm2 stop bale-telegram-bridge
npm run doctor -- --private-chat --samples=1
# If the allowed Bale user's private chat ID differs, edit only BALE_PRIVATE_CHAT_ID locally.
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

دستورهای مدیریت روزمره:

```bash
pm2 status bale-telegram-bridge
pm2 logs bale-telegram-bridge --lines 100
pm2 restart ecosystem.config.cjs --update-env
pm2 stop bale-telegram-bridge
npm run queue -- status
npm run queue -- backup ./backup.sqlite
```

برای توقف پایدار در reboot، بعد از stop دوباره `pm2 save` اجرا کنید؛ `pm2 save` فهرست همین کاربر را ذخیره می‌کند. مجوز پوشهٔ `~/.pm2` و پشتیبان‌ها را نیز به حساب خودتان محدود نگه دارید. PM2 فایل‌های log را به‌طور پیش‌فرض نگه می‌دارد؛ اندازهٔ آن‌ها و فضای دیسک را پایش و گردش log را طبق سیاست سرور تنظیم کنید.

هر پایگاه داده به کاربران، چت‌ها و نام ربات‌های تنظیم‌شده متصل می‌شود و شناسهٔ واقعی هر ربات نیز پس از `getMe` ثبت می‌شود. تغییر هویت‌ها روی همان صف با خطا متوقف می‌شود؛ این کار جلوی ارسال پیام‌های قدیمی به شخص یا ربات تازه را می‌گیرد. برای تغییر طرفین، پس از بررسی و رسیدگی به صف قبلی از مسیر دادهٔ تازه استفاده کنید؛ پایگاه قدیمی را برای دورزدن خطا حذف نکنید. عوض‌شدن توکن همان ربات، هویت جدید محسوب نمی‌شود.

برای مهاجرت از نسخه‌ای که هویت‌ها داخل کد ثابت بوده‌اند، ابتدا صف آن نسخه را با همان هویت‌ها تخلیه کنید، سپس فرایند قبلی را متوقف و پایگاه، `.env` و کلید را امن پشتیبان بگیرید. نسخهٔ عمومی را با `.env` کامل و `DATA_DIR` تازه اجرا کنید. پایگاه قدیمیِ دارای سابقه مستقیماً به نسخهٔ عمومی متصل نمی‌شود و خودکار پاک یا بازنویسی نخواهد شد.

به‌روزرسانی بدون دست‌زدن به داده و کلید:

```bash
cd "$HOME/apps/bale-telegram-bridge"
git pull --ff-only
npm test
npm run doctor -- --samples=1
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

پس از تغییر نسخه/مسیر Node یا PM2، startup hook را با مسیر جدید بازسازی کنید؛ سرویس ثبت‌شده مسیر قبلی را نگه می‌دارد. برای پردازش Node و فرمان‌های عادی PM2 از همان حساب نصب استفاده کنید و `sudo pm2 start` اجرا نکنید.

مبنای این راهنما، مستندات رسمی [فایل تنظیمات PM2](https://pm2.keymetrics.io/docs/usage/application-declaration/)، [startup و ذخیرهٔ پردازش‌ها](https://pm2.keymetrics.io/docs/usage/startup/) و [نصب nvm](https://github.com/nvm-sh/nvm/tree/v0.41.0#installing-and-updating) است. پشتیبانی `node_args`، مسیر `cwd` و `interpreter` برای اجرای فایل `.env` در خود Node استفاده می‌شود؛ secret داخل ecosystem ذخیره نمی‌شود. اجرای واقعی روی سرور شما و آزمایش تحویل دوطرفه همچنان لازم است.
