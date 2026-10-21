// Devuelve private/proveedores.json SOLO con la contrasena de admin.
// El archivo no esta en /public, asi que no se puede abrir desde la web.
const crypto = require('crypto');

const REPO = process.env.GITHUB_REPO;
const TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PATH = 'private/proveedores.json';

function samePassword(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metodo no permitido' });
  if (!REPO || !TOKEN || !ADMIN_PASSWORD) return res.status(500).json({ error: 'Servidor no configurado' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!samePassword((body || {}).password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Contrasena incorrecta' });
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'paul-autos-admin' },
    });
    if (r.status === 404) return res.status(200).json({ proveedores: {} });
    if (!r.ok) throw new Error(`GitHub respondio ${r.status}`);
    const file = await r.json();
    const data = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    return res.status(200).json({ proveedores: data });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
