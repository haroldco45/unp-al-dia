// Robot de noticias de UNP al Día — Vibras Positivas HM
// Corre en GitHub Actions cada 30 minutos (Node 20+, sin dependencias).
// Trae noticias reales sobre la Unidad Nacional de Protección desde Google Noticias,
// Bing Noticias y los RSS de medios colombianos, busca la foto real de cada nota
// y videos de canales de noticias en YouTube. Solo escribe si hay cambios.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const SALIDA = new URL('../data/noticias.json', import.meta.url);
const UA = 'Mozilla/5.0 (compatible; UNPalDiaBot/1.0; +https://unp-al-dia.netlify.app)';
const MAX_NOTAS = 70;
const MAX_VIDEOS = 12;

// Palabras que deben aparecer para que una nota cuente como del caso
const FILTRO = /(unidad nacional de protecci[oó]n|\bunp\b|esquemas? de (protecci[oó]n|seguridad)|escoltas)/i;
// Notas que de verdad son de la UNP (para medios generales)
const FILTRO_FUERTE = /(unidad nacional de protecci[oó]n|\bunp\b)/i;

const CONSULTAS = [
  '"Unidad Nacional de Protección"',
  'UNP viáticos',
  'UNP escoltas',
  'UNP presupuesto',
  'Alejandro Murcia UNP',
  'UNP Contraloría OR Procuraduría OR Fiscalía',
];

const MEDIOS_RSS = [
  ['Infobae', 'https://www.infobae.com/arc/outboundfeeds/rss/category/colombia/?outputType=xml'],
  ['Semana', 'https://www.semana.com/arc/outboundfeeds/rss/?outputType=xml'],
  ['El Espectador', 'https://www.elespectador.com/arc/outboundfeeds/rss/?outputType=xml'],
  ['El Colombiano', 'https://www.elcolombiano.com/arc/outboundfeeds/rss/?outputType=xml'],
  ['Noticias Caracol', 'https://www.noticiascaracol.com/arc/outboundfeeds/rss/?outputType=xml'],
  ['Blu Radio', 'https://www.bluradio.com/arc/outboundfeeds/rss/?outputType=xml'],
  ['Pulzo', 'https://www.pulzo.com/rss'],
  ['El Tiempo', 'https://www.eltiempo.com/rss/justicia.xml'],
  ['Noticias RCN', 'https://www.noticiasrcn.com/rss'],
  ['La FM', 'https://www.lafm.com.co/rss'],
];

const CANALES_YT = [
  'NoticiasCaracol', 'NoticiasRCN', 'RevistaSemana', 'eltiempo',
  'ElEspectador', 'BluRadioCo', 'NoticiasUno', 'CambioColombia',
];

const log = (ok, nombre, n = '') => console.log(`${ok ? '✓' : '✗'} ${nombre}${n !== '' ? ' — ' + n : ''}`);

async function traer(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'es-CO,es;q=0.9' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

const decodificar = (s = '') => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&');
const limpiar = (s = '') => decodificar(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function campo(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodificar(m[1]).trim() : '';
}
function atributo(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"`, 'i'));
  return m ? decodificar(m[1]) : '';
}

export function leerRSS(xml, fuentePorDefecto = '') {
  const items = xml.split(/<item[\s>]/i).slice(1).map(b => b.split(/<\/item>/i)[0]);
  return items.map(b => {
    let titulo = limpiar(campo(b, 'title'));
    let fuente = limpiar(campo(b, 'source')) || fuentePorDefecto;
    // Google Noticias agrega " - Medio" al final del título
    if (fuente && titulo.endsWith(' - ' + fuente)) titulo = titulo.slice(0, -(fuente.length + 3));
    let enlace = limpiar(campo(b, 'link'));
    // Bing envuelve el enlace real en ?url=
    const real = enlace.match(/[?&]url=([^&]+)/);
    if (/bing\.com/.test(enlace) && real) enlace = decodeURIComponent(real[1]);
    const img = atributo(b, 'media:content', 'url') || atributo(b, 'media:thumbnail', 'url')
      || atributo(b, 'News:Image', 'url') || limpiar(campo(b, 'News:Image'))
      || atributo(b, 'enclosure', 'url') || ((campo(b, 'description').match(/<img[^>]+src="([^"]+)"/i) || [])[1] || '');
    const fecha = new Date(campo(b, 'pubDate') || campo(b, 'dc:date') || Date.now());
    const resumen = limpiar(campo(b, 'description')).slice(0, 260);
    return { t: titulo, u: enlace, f: fuente, d: isNaN(fecha) ? new Date().toISOString() : fecha.toISOString(), img: img || '', r: resumen };
  }).filter(n => n.t && n.u);
}

const clave = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').split(' ').filter(w => w.length > 3).slice(0, 8).join(' ');

async function googleNoticias() {
  const out = [];
  for (const q of CONSULTAS) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:30d')}&hl=es-419&gl=CO&ceid=CO:es-419`;
    try { const n = leerRSS(await traer(url)); out.push(...n); log(true, 'Google Noticias: ' + q, n.length); }
    catch (e) { log(false, 'Google Noticias: ' + q, e.message); }
  }
  return out;
}

async function bingNoticias() {
  const out = [];
  for (const q of ['Unidad Nacional de Protección Colombia', 'UNP escoltas viáticos']) {
    const url = `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=es-CO&cc=CO`;
    try { const n = leerRSS(await traer(url)); out.push(...n); log(true, 'Bing Noticias: ' + q, n.length); }
    catch (e) { log(false, 'Bing Noticias: ' + q, e.message); }
  }
  return out;
}

async function mediosRSS() {
  const out = [];
  for (const [nombre, url] of MEDIOS_RSS) {
    try {
      const n = leerRSS(await traer(url), nombre).filter(x => FILTRO_FUERTE.test(x.t + ' ' + x.r));
      out.push(...n); log(true, 'RSS ' + nombre, n.length);
    } catch (e) { log(false, 'RSS ' + nombre, e.message); }
  }
  return out;
}

async function fotoDe(url) {
  if (!url || /news\.google\.com/.test(url)) return '';
  try {
    const html = await traer(url, 10000);
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    return m ? decodificar(m[1]) : '';
  } catch { return ''; }
}

async function videosYouTube() {
  const out = [];
  for (const canal of CANALES_YT) {
    try {
      const html = await traer(`https://www.youtube.com/@${canal}`);
      const id = (html.match(/"channelId":"(UC[\w-]{22})"/) || html.match(/channel_id=(UC[\w-]{22})/) || [])[1];
      if (!id) throw new Error('sin channelId');
      const xml = await traer(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
      const entradas = xml.split('<entry>').slice(1).map(e => ({
        id: campo(e, 'yt:videoId'),
        t: limpiar(campo(e, 'title')),
        canal: limpiar(campo(e, 'name')) || canal,
        d: campo(e, 'published'),
        r: limpiar(campo(e, 'media:description')).slice(0, 200),
      })).filter(v => v.id && FILTRO_FUERTE.test(v.t + ' ' + v.r));
      out.push(...entradas); log(true, 'YouTube @' + canal, entradas.length);
    } catch (e) { log(false, 'YouTube @' + canal, e.message); }
  }
  return out;
}

async function main() {
  let anterior = { items: [], videos: [] };
  try { anterior = JSON.parse(await readFile(SALIDA, 'utf8')); } catch {}

  const [g, b, m, v] = await Promise.all([googleNoticias(), bingNoticias(), mediosRSS(), videosYouTube()]);

  // Unir, filtrar y quitar repetidas (prefiere la versión con foto y con enlace directo)
  const mapa = new Map();
  for (const n of [...m, ...b, ...g, ...(anterior.items || [])]) {
    if (!FILTRO.test(n.t + ' ' + (n.r || ''))) continue;
    const k = clave(n.t);
    if (!k) continue;
    const previa = mapa.get(k);
    if (!previa) { mapa.set(k, n); continue; }
    if (!previa.img && n.img) previa.img = n.img;
    if (/news\.google\.com/.test(previa.u) && !/news\.google\.com/.test(n.u)) previa.u = n.u;
  }
  const hace45 = Date.now() - 45 * 864e5;
  let items = [...mapa.values()]
    .filter(n => new Date(n.d).getTime() > hace45)
    .sort((a, b) => new Date(b.d) - new Date(a.d))
    .slice(0, MAX_NOTAS);

  // Fotos reales: busca og:image de las notas sin foto (máximo 25 por corrida)
  const sinFoto = items.filter(n => !n.img).slice(0, 25);
  await Promise.all(sinFoto.map(async n => { n.img = await fotoDe(n.u); }));
  log(true, 'Fotos encontradas', items.filter(n => n.img).length + ' de ' + items.length);

  const vistos = new Set();
  const videos = [...v, ...(anterior.videos || [])]
    .filter(x => x.id && !vistos.has(x.id) && vistos.add(x.id))
    .sort((a, b) => new Date(b.d) - new Date(a.d))
    .slice(0, MAX_VIDEOS);

  const firma = JSON.stringify([items.map(n => n.u + n.img), videos.map(x => x.id)]);
  const firmaAnterior = JSON.stringify([(anterior.items || []).map(n => n.u + n.img), (anterior.videos || []).map(x => x.id)]);
  if (firma === firmaAnterior && anterior.actualizado) {
    console.log('Sin cambios: no se escribe el archivo.');
    return;
  }
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  const datos = { actualizado: new Date().toISOString(), total: items.length, items, videos };
  await writeFile(SALIDA, JSON.stringify(datos, null, 1));
  console.log(`Guardadas ${items.length} noticias y ${videos.length} videos.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => { console.error(e); process.exit(1); });
}
