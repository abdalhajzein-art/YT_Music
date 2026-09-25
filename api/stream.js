// 🧠 ذاكرة مؤقتة لـ Client ID
let cachedClientId = null;
let lastFetchTime = 0;
const CACHE_DURATION = 2 * 60 * 60 * 1000; // ساعتان

async function getFreshClientId(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedClientId && (now - lastFetchTime < CACHE_DURATION)) {
    return cachedClientId;
  }

  try {
    const htmlRes = await fetch('https://soundcloud.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await htmlRes.text();
    const scriptUrls = [...html.matchAll(/src="(https:\/\/[^"]+\.js)"/g)].map(m => m[1]);
    
    for (const scriptUrl of scriptUrls.slice(-6)) {
      const scriptRes = await fetch(scriptUrl);
      const scriptText = await scriptRes.text();
      const match = scriptText.match(/client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
      if (match) {
        cachedClientId = match[1];
        lastFetchTime = now;
        return cachedClientId;
      }
    }
  } catch (e) {
    console.error('فشل جلب Client ID جديد:', e);
  }

  return cachedClientId || 'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX';
}

// 🆕 دالة مساعدة: إزالة client_id من الرابط
function stripClientId(url) {
  return url.replace(/[?&]client_id=[a-zA-Z0-9]{32}/, '');
}

// 🆕 دالة مساعدة: إضافة client_id للرابط
function addClientId(url, clientId) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}client_id=${clientId}`;
}

export default async function handler(req, res) {
  // 🌐 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  // 🆕 Cache على Vercel Edge لمدة 20 دقيقة
  // SoundCloud URLs صالحة ~30 دقيقة، لذا 20 دقيقة آمنة
  // كل طلب من نفس المستخدم خلال 20 دقيقة = رد فوري بدون نداء SoundCloud
  res.setHeader('Cache-Control', 's-maxage=1200, stale-while-revalidate=300');

  let streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: 'الرجاء إرسال رابط الـ stream' });
  }

  try {
    // 🎯 استخراج الـ client_id من الرابط (إذا موجود) قبل الـ cache
    const clientIdMatch = streamUrl.match(/[?&]client_id=([a-zA-Z0-9]{32})/);
    const clientIdInUrl = clientIdMatch ? clientIdMatch[1] : null;
    
    // 🆕 إزالة client_id للحصول على رابط نظيف (cache key موحد)
    const cleanUrl = stripClientId(streamUrl);
    
    // الحصول على client_id طازج
    let clientId = await getFreshClientId();
    if (clientIdInUrl && clientIdInUrl !== clientId) {
      // لا نستخدم client_id القديم إلا إذا كان طازجاً
      clientId = clientIdInUrl;
    }
    
    // إضافة client_id للرابط
    const requestUrl = addClientId(cleanUrl, clientId);

    let response = await fetch(requestUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });

    // 🔄 تجديد Client ID إذا انتهت صلاحيته
    if (response.status === 401 || response.status === 403) {
      const freshClientId = await getFreshClientId(true);
      const retryUrl = addClientId(cleanUrl, freshClientId);
      
      response = await fetch(retryUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01'
        }
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Stream Error: ${response.statusText}` 
      });
    }

    const data = await response.json();

    if (data && data.url) {
      return res.status(200).json({ 
        success: true, 
        direct_url: data.url 
      });
    } else {
      return res.status(404).json({ error: 'لم يتم العثور على الرابط المباشر' });
    }

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
        }
