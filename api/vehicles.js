const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-EC,es;q=0.9',
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseVehicles(html, dealer) {
  const vehicles = [];
  // Match vehicle links
  const linkRe = /href="(\/vehicle\/[^"]+)"/g;
  const seen = new Set();
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);

    // Extract the block around this vehicle link - find a window of text
    const idx = html.indexOf(m[0]);
    const block = html.slice(Math.max(0, idx - 800), idx + 200);

    // Title: look for h3 content
    const titleM = block.match(/<h3[^>]*>\s*([^<]+)\s*<\/h3>/i) ||
                   block.match(/###\s*(.+?)[\n<]/);
    const title = titleM ? titleM[1].replace(/&amp;/g, '&').trim() : '';
    if (!title) continue;

    // Price
    const priceM = block.match(/\$[\d,]+/);
    const price = priceM ? priceM[0] : '';
    if (!price) continue;

    // Year
    const yearM = block.match(/\b(19[89]\d|20[012]\d)\b/);
    const year = yearM ? yearM[1] : '';

    // KMs
    const kmM = block.match(/([\d,]+)\s*Kms?/i);
    const kms = kmM ? kmM[1].replace(',', '.') + ' Kms' : '';

    // Image
    const imgM = block.match(/src="(https:\/\/images\.patiotuerca\.com[^"]+)"/);
    const img = imgM ? imgM[1] : '';

    const id = path.split('/').pop();

    vehicles.push({
      id,
      title,
      price,
      year,
      kms,
      img,
      url: 'https://ecuador.patiotuerca.com' + path,
      dealer: dealer.name,
      dealerId: dealer.id,
    });
  }
  return vehicles;
}

async function fetchDealer(dealer) {
  const vehicles = [];
  const seen = new Set();

  for (let page = 1; page <= 15; page++) {
    const url = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}?page=${page}`;
    try {
      const html = await fetchPage(url);
      const found = parseVehicles(html, dealer);
      if (found.length === 0) break;

      let newCount = 0;
      for (const v of found) {
        if (!seen.has(v.id)) {
          seen.add(v.id);
          vehicles.push(v);
          newCount++;
        }
      }
      if (newCount === 0) break;

      // Check if there's a next page
      if (!html.includes('Siguiente') || html.includes('"Siguiente" disabled')) break;
    } catch (e) {
      break;
    }
  }
  return vehicles;
}

module.exports = async (req, res) => {
  // CORS headers so the frontend can call this API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const dealerId = req.query.dealer;
  const dealersToFetch = dealerId
    ? DEALERS.filter(d => d.id === dealerId)
    : DEALERS;

  try {
    const results = await Promise.all(dealersToFetch.map(fetchDealer));
    const all = results.flat();
    res.status(200).json({ vehicles: all, total: all.length, updated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
