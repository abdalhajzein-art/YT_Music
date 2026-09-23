const https = require('https');

module.exports = async (req, res) => {
    const videoId = req.query.id;
    if (!videoId) {
        return res.status(400).json({ error: 'Missing video ID' });
    }

    const pipedUrl = `https://pipedapi.kavin.rocks/streams/${videoId}`;

    https.get(pipedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (apiRes) => {
        let data = '';
        apiRes.on('data', (chunk) => data += chunk);
        apiRes.on('end', () => {
            try {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.status(200).json(JSON.parse(data));
            } catch (e) {
                res.status(500).json({ error: 'Failed to parse JSON' });
            }
        });
    }).on('error', (e) => {
        res.status(500).json({ error: e.message });
    });
};
