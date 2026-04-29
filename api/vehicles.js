const https = require('https');

const DEALERS = [
  { id: '1167', name: 'Autos Quito' },
  { id: '1378', name: 'Sucursal' },
  { id: '1570', name: '10 de Agosto' },
];

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-EC,es;q=0.9',
        'Referer': 'https://ecuador.patiotuerca.com/',
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: null, raw: data.slice(0, 300) }); }
      });
    }).on('error', e => resolve({ status: 0, body: null, error: e.message }));
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const dealerId = req.query.dealer || '1167';
  const debug = req.query.debug === '1';

  // Probe multiple possible API endpoints
  const endpointsToTry = [
    `https://ecuador.patiotuerca.com/api/search?dealer=${dealerId}&page=1&pageSize=12&country=ecuador`,
    `https://ecuador.patiotuerca.com/api/dealers/${dealerId}/vehicles?page=1&limit=12`,
    `https://ecuador.patiotuerca.com/api/v2/search?dealerId=${dealerId}&from=0&size=12`,
    `https://ecuador.patiotuerca.com/api/v1/dealers/${dealerId}/listings?page=1`,
    `https://ecuador.patiotuerca.com/_next/data/index.json?dealerSlug=autos-quito&dealerId=${dealerId}`,
  ];

  if (debug) {
    const results = {};
    for (const url of endpointsToTry) {
      results[url] = await fetchJSON(url);
    }
    return res.status(200).json(results);
  }

  // Try each endpoint until one works
  let vehicles = [];
  for (const url of endpointsToTry) {
    const result = await fetchJSON(url);
    if (!result.body) continue;
    const body = result.body;
    const items = body.results || body.vehicles || body.data || body.hits || body.items || [];
    if (Array.isArray(items) && items.length > 0) {
      // Found working endpoint - now fetch all pages
      vehicles = await fetchAllPages(url, dealerId, items, body);
      break;
    }
  }

  res.status(200).json({ vehicles, total: vehicles.length, updated: new Date().toISOString() });
};

async function fetchAllPages(workingUrl, dealerId, firstItems, firstBody) {
  const vehicles = [];
  const pageSize = 24;

  function mapItem(raw, dealerName) {
    const item = raw._source || raw;
    const brand = item.brand || item.marca || '';
    const model = item.model || item.modelo || '';
    const version = item.version || item.version_name || item.trim || '';
    const price = item.price || item.precio || 0;
    const mileage = item.mileage || item.kilometraje || item.km || 0;
    const year = item.year || item.anio || item.año || '';
    const id = item.id || item._id || item.vehicleId || '';
    const slug = item.slug || item.url_slug || '';
    const img = item.mainImage || item.main_image || item.thumbnail ||
                (Array.isArray(item.images) ? item.images[0] : '') || '';
    const urlPath = item.url || (slug ? `/vehicle/${slug}/${id}` : `/vehicle/${id}`);
    return {
      id: String(id),
      title: [brand, model, version].filter(Boolean).join(' · ') || item.title || item.name || String(id),
      price: price ? `$${Number(price).toLocaleString('en-US')}` : '',
      year: String(year),
      kms: mileage ? `${Number(mileage).toLocaleString('en-US')} Kms` : '',
      img: img.startsWith('http') ? img : (img ? 'https://ecuador.patiotuerca.com' + img : ''),
      url: urlPath.startsWith('http') ? urlPath : 'https://ecuador.patiotuerca.com' + urlPath,
      dealer: 'Autos Quito',
      dealerId,
    };
  }

  // Add first page
  for (const item of firstItems) {
    const v = mapItem(item);
    if (v.title) vehicles.push(v);
  }

  const total = firstBody.total || firstBody.totalCount || firstBody.count || 0;
  if (!total || vehicles.length >= total) return vehicles;

  // Fetch remaining pages
  let page = 2;
  while (vehicles.length < total && page <= 20) {
    let nextUrl;
    if (workingUrl.includes('page=')) {
      nextUrl = workingUrl.replace(/page=\d+/, `page=${page}`);
    } else if (workingUrl.includes('from=')) {
      nextUrl = workingUrl.replace(/from=\d+/, `from=${(page-1)*pageSize}`);
    } else {
      break;
    }

    const result = await fetchJSON(nextUrl);
    if (!result.body) break;
    const items = result.body.results || result.body.vehicles || result.body.data || result.body.hits || result.body.items || [];
    if (!items.length) break;

    for (const item of items) {
      const v = mapItem(item);
      if (v.title) vehicles.push(v);
    }
    page++;
  }

  return vehicles;
}
