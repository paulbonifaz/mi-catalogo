const https = require('https');
const http = require('http');

const DEALERS = [
  { id: '1167', name: 'Autos Quito', slug: 'autos-quito' },
  { id: '1378', name: 'Sucursal', slug: 'autos-quito-sucursal' },
  { id: '1570', name: '10 de Agosto', slug: 'autos-quito-10-de-agosto' },
];

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-EC,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      }
    };
    lib.get(url, options, (res) => {
      // Follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

function parseVehiclesFromHTML(html, dealer) {
  const vehicles = [];
  const seen = new Set();

  // Extract Next.js __NEXT_DATA__ JSON embedded in the page
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      // Walk the props tree to find vehicle listings
      const str = JSON.stringify(nextData);
      // Find vehicle arrays by looking for objects with brand+price+mileage
      const vehiclePattern = /"id":(\d+).*?"brand":"([^"]+)".*?"model":"([^"]+)".*?"price":(\d+)/g;
      let m;
      while ((m = vehiclePattern.exec(str)) !== null) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        // Extract more details around this match
        const start = Math.max(0, m.index - 100);
        const end = Math.min(str.length, m.index + 600);
        const chunk = str.slice(start, end);
        const yearM = chunk.match(/"year":(\d{4})/);
        const mileageM = chunk.match(/"mileage":(\d+)/);
        const slugM = chunk.match(/"slug":"([^"]+)"/);
        const imgM = chunk.match(/"mainImage":"([^"]+)"/);
        const versionM = chunk.match(/"version":"([^"]+)"/);
        vehicles.push({
          id,
          title: [m[2], m[3], versionM?.[1]].filter(Boolean).join(' · '),
          price: `$${Number(m[4]).toLocaleString('en-US')}`,
          year: yearM?.[1] || '',
          kms: mileageM ? `${Number(mileageM[1]).toLocaleString('en-US')} Kms` : '',
          img: imgM ? imgM[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/') : '',
          url: slugM
            ? `https://ecuador.patiotuerca.com/vehicle/${slugM[1].replace(/\\u002F/g,'/')}/${id}`
            : `https://ecuador.patiotuerca.com/vehicle/${id}`,
          dealer: dealer.name,
          dealerId: dealer.id,
        });
      }
      if (vehicles.length > 0) return vehicles;
    } catch(e) {}
  }

  // Fallback: parse HTML anchor tags with vehicle URLs
  const linkRe = /href="(\/vehicle\/[^"?#]+)"/g;
  let m2;
  while ((m2 = linkRe.exec(html)) !== null) {
    const path = m2[1];
    const id = path.split('/').pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const idx = m2.index;
    const block = html.slice(Math.max(0, idx - 1000), idx + 300);

    const priceM = block.match(/\$\s*([\d,]+)/);
    const yearM  = block.match(/\b(19[89]\d|20[012]\d)\b/);
    const kmM    = block.match(/([\d.,]+)\s*[Kk]ms?/);
    const imgM   = block.match(/src="(https:\/\/images\.patiotuerca\.com[^"]+)"/);
    const titleM = block.match(/<h3[^>]*>([^<]+)<\/h3>/i);

    const price = priceM ? `$${priceM[1]}` : '';
    const title = titleM ? titleM[1].trim() : '';
    if (!price && !title) continue;

    vehicles.push({
      id,
      title: title || path.split('/').slice(-2, -1)[0]?.replace(/-/g,' ') || id,
      price,
      year: yearM?.[1] || '',
      kms: kmM ? `${kmM[1]} Kms` : '',
      img: imgM?.[1] || '',
      url: 'https://ecuador.patiotuerca.com' + path,
      dealer: dealer.name,
      dealerId: dealer.id,
    });
  }

  return vehicles;
}

async function fetchDealerAllPages(dealer) {
  const allVehicles = [];
  const seenIds = new Set();

  for (let page = 1; page <= 20; page++) {
    const url = `https://ecuador.patiotuerca.com/dealers-profile/${dealer.slug}/${dealer.id}?page=${page}`;
    try {
      const res = await fetchUrl(url);
      i
