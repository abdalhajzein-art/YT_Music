export default async function handler(req, res) {
  // السماح بالطلبات من أي مصدر (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'الرجاء إدخال كلمة البحث q' });
  }

  // Client ID عام ومستخرج من منصة ساوند كلاود
  const clientId = 'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX';

  try {
    // البحث عن الأغاني عبر API ساوند كلاود V2
    const searchUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=15`;
    const searchResponse = await fetch(searchUrl);
    const searchData = await searchResponse.json();

    if (!searchData.collection) {
      return res.status(404).json({ error: 'لم يتم العثور على نتائج' });
    }

    // تصفية وترتيب النتائج لتكون جاهزة لتطبيق الأندرويد
    const tracks = searchData.collection.map(track => {
      // البحث عن رابط التشغيل (Progressive stream)
      const transcoding = track.media?.transcodings?.find(t => t.format.protocol === 'progressive');
      
      return {
        id: track.id,
        title: track.title,
        artist: track.user?.username || 'مجهول',
        duration: track.duration,
        artwork: track.artwork_url ? track.artwork_url.replace('large', 't500x500') : null,
        stream_endpoint: transcoding ? `${transcoding.url}?client_id=${clientId}` : null
      };
    }).filter(t => t.stream_endpoint !== null);

    return res.status(200).json({ success: true, tracks });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
