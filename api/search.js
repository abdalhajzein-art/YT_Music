const https = require('https');

const instances = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.yt',
    'https://pipedapi.privacy.com.de',
    'https://pipedapi.adminforge.de'
];

function fetchFromInstance(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Invalid JSON'));
                    }
                } else {
                    reject(new Error(`Status code ${res.statusCode}`));
                }
            });
        });
        req.on('error', err => reject(err));
        req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

module.exports = async (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: 'Missing query' });
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    for (const instance of instances) {
        try {
            const url = `${instance}/search?q=${encodeURIComponent(query)}&filter=videos`;
            const result = await fetchFromInstance(url);
            return res.status(200).json(result);
        } catch (e) {
            continue; // جرب السيرفر التالي إذا فشل الحالي
        }
    }

    return res.status(500).json({ error: 'All Piped instances failed' });
};
