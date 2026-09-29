/**
 * ریله‌ی عمومی روی Vercel (معادل همان Cloudflare Worker).
 * هر درخواستی که به این تابع برسد، عیناً (متد، هدرها، بدنه) به UPSTREAM_BASE
 * فوروارد می‌شود و پاسخ هم عیناً برگردانده می‌شود.
 *
 * مسیر فایل مهم است: api/[...path].js یعنی این تابع روی /api/* اجرا می‌شود.
 * پس Base URL که در تنظیمات افزونه می‌گذارید باید به .../api ختم شود، مثلاً:
 *   https://your-project.vercel.app/api
 */

// ==== تنظیما: قبل از دیپلوی همین دو خط را چک/ویرایش کنید ====
const UPSTREAM_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// برای Gemini همین مقدار بالا درست است. برای OpenAI یا Groq به جایش بگذارید:
//   const UPSTREAM_BASE = 'https://api.openai.com/v1';           // OpenAI
//   const UPSTREAM_BASE = 'https://api.groq.com/openai/v1';      // Groq

const RELAY_SECRET = ''; // خالی = بدون محافظت (هرکس آدرس را پیدا کند می‌تواند استفاده کند).
// برای محافظت، یک رشته‌ی دلخواه اینجا بگذارید، مثلاً: 'a9f3-k7m2-x1qz'
// و همان رشته را در تنظیمات افزونه، فیلد «کلید Relay»، وارد کنید.
// ================================================================

const HOP_BY_HOP_REQUEST_HEADERS = [
  'host',
  'x-relay-secret',
  'connection',
  'content-length',
  'x-forwarded-proto',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-vercel-id',
  'x-vercel-deployment-url',
];

const HOP_BY_HOP_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];

// بدنه‌ی خام درخواست را عیناً می‌خواند (بدون parse کردن JSON)، تا هر Content-Type دست‌نخورده فوروارد شود.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// این پروژه بدون فریم‌ورک است؛ Vercel بدنه‌ی JSON را خودکار parse می‌کند مگر همین را خاموش کنیم.
module.exports.config = {
  api: { bodyParser: false },
};

module.exports = async function handler(req, res) {
  if (RELAY_SECRET) {
    const provided = req.headers['x-relay-secret'];
    if (provided !== RELAY_SECRET) {
      res.status(403).send('Forbidden');
      return;
    }
  }

  // req.url شامل مسیر کامل درخواست است (مثلاً /api/models/gemini-3.6-flash:generateContent?...).
  // چون فایل زیر api/ است، فقط همین پیشوند ثابت را برمی‌داریم تا بقیه‌ی مسیر به UPSTREAM_BASE اضافه شود.
  const [rawPath, rawQuery] = req.url.replace(/^\/api/, '').split('?');

  // برای مسیریابی این فایل پویا (api/[...path].js)، خودِ Vercel یک پارامتر داخلی
  // به query string اضافه می‌کند که مقدارش همان بخش پویای مسیر است (کلیدش هم
  // می‌تواند "path" باشد و هم به‌صورت خام "...path"، بسته به نسخه‌ی روتینگ Vercel).
  // این پارامتر فقط برای خود Vercel است و نباید به سرویس مقصد فوروارد شود، وگرنه
  // Gemini/OpenAI/Groq آن را پارامتر ناشناخته حساب کرده و خطای ۴۰۰ می‌دهند.
  const qs = new URLSearchParams(rawQuery || '');
  qs.delete('path');
  qs.delete('...path');
  const cleanQuery = qs.toString();

  const targetUrl = UPSTREAM_BASE.replace(/\/$/, '') + rawPath + (cleanQuery ? '?' + cleanQuery : '');

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP_REQUEST_HEADERS.includes(key.toLowerCase()) && value !== undefined) {
      headers[key] = value;
    }
  }

  const init = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = await readRawBody(req);
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, init);
  } catch (err) {
    res.status(502).send('خطای اتصال به سرویس مقصد: ' + err.message);
    return;
  }

  res.status(upstreamResponse.status);
  upstreamResponse.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_RESPONSE_HEADERS.includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });

  const buf = Buffer.from(await upstreamResponse.arrayBuffer());
  res.send(buf);
};
