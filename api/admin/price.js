// Cambia el precio de un vehiculo desde el admin.
// - Actualiza public/vehicles.json (se ve en la web en segundos).
// - Si el precio nuevo es MENOR, guarda el anterior en priceBefore -> etiqueta "Rebajado".
// - Lo anota en private/precios_admin.json para que los lectores (WhatsApp y
//   Marketplace) respeten este precio en sus siguientes corridas.
const crypto = require('crypto');

const REPO = process.env.GITHUB_REPO;
const TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const VEHICLES_PATH = 'public/vehicles.json';
const PRICES_PATH = 'private/precios_admin.json';

function samePassword(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function github(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'paul-autos-admin',
      ...(options.headers || {}),
    },
  });
  if (res.status === 404 && !options.method) return null;
  if (!res.ok) throw new Error(`GitHub respondio ${res.status} para ${path}`);
  return res.json();
}

async function readJson(path, fallback) {
  const file = await github(path);
  if (!file) return { sha: undefined, data: fallback };
  return { sha: file.sha, data: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) };
}

async function writeJson(path, sha, data, message) {
  const body = { message, content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64') };
  if (sha) body.sha = sha;
  await github(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

const num = s => parseInt(String(s || '').replace(/\D/g, ''), 10) || 0;
const fmt = n => '$' + n.toLocaleString('en-US');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  if (!REPO || !TOKEN || !ADMIN_PASSWORD) return res.status(500).json({ error: 'Servidor no configurado' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { id, password, price } = body || {};
  if (!samePassword(password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Contrasena incorrecta' });
  const nuevo = num(price);
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'ID invalido' });
  if (nuevo < 300 || nuevo > 500000) return res.status(400).json({ error: 'Precio invalido' });

  try {
    const catalog = await readJson(VEHICLES_PATH, { vehicles: [] });
    const v = catalog.data.vehicles.find(x => x.id === id);
    if (!v) return res.status(404).json({ error: 'Vehiculo no encontrado en el catalogo' });

    const actual = num(v.price);
    // precio "de referencia" para la etiqueta: el mayor entre el anterior ya guardado y el actual
    const referencia = Math.max(actual, num(v.priceBefore));
    v.price = fmt(nuevo);
    if (referencia > nuevo) v.priceBefore = fmt(referencia);   // bajo de precio -> "Rebajado"
    else delete v.priceBefore;                                 // subio o quedo igual -> sin etiqueta
    await writeJson(VEHICLES_PATH, catalog.sha, catalog.data, `Precio ${id}: ${fmt(actual)} -> ${v.price}`);

    const prices = await readJson(PRICES_PATH, {});
    const prev = prices.data[id] || {};
    prices.data[id] = { price: v.price, priceBefore: v.priceBefore || '', title: v.title || '',
                        // precio que tenia de su fuente (grupo/Marketplace) antes de tocarlo en el admin
                        fromPrice: prev.fromPrice || fmt(actual),
                        updatedAt: new Date().toISOString() };
    await writeJson(PRICES_PATH, prices.sha, prices.data, `Precio admin ${id}`);

    return res.status(200).json({ ok: true, price: v.price, priceBefore: v.priceBefore || '' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
