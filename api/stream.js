export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: 'الرجاء إرسال رابط الـ stream' });
  }

  try {
    const response = await fetch(streamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Stream Error: ${response.statusText}` });
    }

    const data = await response.json();

    if (data && data.url) {
      return res.status(200).json({ success: true, direct_url: data.url });
    } else {
      return res.status(404).json({ error: 'لم يتم العثور على الرابط المباشر' });
    }

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
