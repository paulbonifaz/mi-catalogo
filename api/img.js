const https = require('https');

module.exports = async (req, res) => {
  const imgUrl = req.query.url;
  if (!imgUrl || !imgUrl.startsWith('https://images.patiotuerca.com/')) {
    return res.status(400).end('Invalid URL');
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');

  try {
    await new Promise((resolve, reject) => {
      https.get(imgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://ecuador.patiotuerca.com/',
        }
      }, (imgRes) => {
        if (imgRes.statusCode !== 200) {
          res.status(imgRes.statusCode).end();
          return resolve();
        }
        res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
        imgRes.pipe(res);
        imgRes.on('end', resolve);
        imgRes.on('error', reject);
      }).on('error', reject);
    });
  } catch(e) {
    res.status(502).end();
  }
};
