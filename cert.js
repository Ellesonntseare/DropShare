// Local CA + server certificate generator. Zero dependencies (Node crypto only).
// The CA is created once. The server certificate is re-issued automatically
// whenever this PC's network addresses change, so the phone only trusts the CA once.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CA_CN = 'DropShare Local CA';

/* ---- tiny DER encoder ---- */
const len = n => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (t, ...c) => { const b = Buffer.concat(c); return Buffer.concat([Buffer.from([t]), len(b.length), b]); };
const seq = (...c) => tlv(0x30, ...c);
const set = (...c) => tlv(0x31, ...c);
const octet = b => tlv(0x04, b);
const utf8 = s => tlv(0x0c, Buffer.from(s));
const oid = s => {
  const p = s.split('.').map(Number), out = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) { const st = [n & 127]; let v = n >> 7; while (v > 0) { st.unshift((v & 127) | 128); v >>= 7; } out.push(...st); }
  return tlv(0x06, Buffer.from(out));
};
const int = buf => {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 128)) b = b.subarray(1);
  if (b[0] & 128) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const utc = d => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const name = cn => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id, critical, val) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octet(val));
const SIGALG = seq(oid('1.2.840.113549.1.1.11'), tlv(0x05, Buffer.alloc(0))); // sha256WithRSAEncryption
const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const isIPv4 = h => /^\d+\.\d+\.\d+\.\d+$/.test(h);

function makeCert({ cn, issuerCn, pub, signKey, days, ca, hosts, aki }) {
  const spki = pub.export({ type: 'spki', format: 'der' });
  const ski = crypto.createHash('sha1').update(spki).digest();
  const exts = [
    ext('2.5.29.19', true, ca ? seq(tlv(0x01, Buffer.from([0xff]))) : seq()),                         // basicConstraints
    ext('2.5.29.15', true, ca ? tlv(0x03, Buffer.from([1, 0x06])) : tlv(0x03, Buffer.from([5, 0xa0]))), // keyUsage
    ext('2.5.29.14', false, octet(ski)),                                                                // subjectKeyIdentifier
  ];
  if (aki) exts.push(ext('2.5.29.35', false, seq(tlv(0x80, aki))));                                     // authorityKeyIdentifier
  if (!ca) {
    exts.push(ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))));                                  // serverAuth
    exts.push(ext('2.5.29.17', false, seq(...hosts.map(h =>                                             // subjectAltName
      isIPv4(h) ? tlv(0x87, Buffer.from(h.split('.').map(Number))) : tlv(0x82, Buffer.from(h))))));
  }
  const serial = crypto.randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x01;
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), int(serial), SIGALG, name(issuerCn),
    seq(utc(new Date(now - 3600e3)), utc(new Date(now + days * 864e5))),
    name(cn), spki, tlv(0xa3, seq(...exts)),
  );
  const sig = crypto.sign('sha256', tbs, signKey);
  return { der: seq(tbs, SIGALG, tlv(0x03, Buffer.concat([Buffer.from([0]), sig]))), ski };
}

function ensureCerts(dir, hostList) {
  fs.mkdirSync(dir, { recursive: true });
  const f = n => path.join(dir, n);
  const hosts = [...new Set(hostList.filter(h => isIPv4(h) || /^[A-Za-z0-9.-]+$/.test(h)))].sort();

  if (!fs.existsSync(f('ca.key')) || !fs.existsSync(f('ca.crt'))) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const c = makeCert({ cn: CA_CN, issuerCn: CA_CN, pub: publicKey, signKey: privateKey, days: 3650, ca: true });
    fs.writeFileSync(f('ca.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(f('ca.crt'), pem('CERTIFICATE', c.der));
    fs.rmSync(f('server.json'), { force: true });
  }
  const caCrt = fs.readFileSync(f('ca.crt'), 'utf8');
  const caKey = crypto.createPrivateKey(fs.readFileSync(f('ca.key')));
  const caSpki = new crypto.X509Certificate(caCrt).publicKey.export({ type: 'spki', format: 'der' });
  const caSki = crypto.createHash('sha1').update(caSpki).digest();

  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(f('server.json'), 'utf8')); } catch {}
  const fresh = meta && JSON.stringify(meta.hosts) === JSON.stringify(hosts) && meta.expires - Date.now() > 30 * 864e5
    && fs.existsSync(f('server.key')) && fs.existsSync(f('server.crt'));
  if (!fresh) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const days = 825;
    const c = makeCert({ cn: 'DropShare', issuerCn: CA_CN, pub: publicKey, signKey: caKey, days, ca: false, hosts, aki: caSki });
    fs.writeFileSync(f('server.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(f('server.crt'), pem('CERTIFICATE', c.der));
    fs.writeFileSync(f('server.json'), JSON.stringify({ hosts, expires: Date.now() + days * 864e5 }));
  }
  return { key: fs.readFileSync(f('server.key')), cert: fs.readFileSync(f('server.crt')), ca: caCrt };
}

module.exports = { ensureCerts };
