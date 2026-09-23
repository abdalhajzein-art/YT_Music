module.exports = async (req, res) => {
  // السماح بالطلبات من أي مصدر (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: 'الرجاء إرسال رابط الـ stream' });
  }

  try {
    // جلب الرابط النهائي المباشر للصوت من ساوند كلاود
    const response = await fetch(streamUrl);
    const data = await response.json();

    if (data && data.url) {
      return res.status(200).json({ success: true, direct_url: data.url });
    } else {
      return res.status(404).json({ error: 'لم يتم العثور على الرابط المباشر' });
    }

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
