// ─── ZATCA Offline Signing ────────────────────────────────────────────────────
// Mirrors Transaction::generateZatcaXml() in PHP, minus the reporting step.
// Generates a fully signed ZATCA QR (tags 1–9) for simplified (B2C) invoices,
// completely offline.
//
// NOTE: ZATCA certificates use secp256k1 (OID 1.3.132.0.10), not P-256.
// WebCrypto does not support secp256k1, so ECDSA signing is implemented in
// pure JS using BigInt arithmetic + WebCrypto HMAC-SHA256 (for RFC 6979 nonces).

// ── Minimal secp256k1 ECDSA (pure JS, BigInt + WebCrypto HMAC) ───────────────
const _SECP256K1 = (() => {
    // Curve parameters
    const P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
    const N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
    const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

    const mod = (a, m = P) => ((a % m) + m) % m;

    // Modular exponentiation (Fermat's little theorem for prime modulus)
    const modInv = (a, m = P) => {
        let [old_r, r] = [mod(a, m), m];
        let [old_s, s] = [1n, 0n];
        while (r !== 0n) {
            const q = old_r / r;
            [old_r, r] = [r, old_r - q * r];
            [old_s, s] = [s, old_s - q * s];
        }
        return mod(old_s, m);
    };

    // Affine EC point add / double. Infinity = null.
    const ptAdd = (A, B) => {
        if (!A) return B;
        if (!B) return A;
        const [x1, y1] = A, [x2, y2] = B;
        if (x1 === x2) {
            if (y1 !== y2) return null; // P + (-P) = ∞
            const lam = mod(3n * x1 * x1 * modInv(2n * y1));
            const x3  = mod(lam * lam - 2n * x1);
            return [x3, mod(lam * (x1 - x3) - y1)];
        }
        const lam = mod((y2 - y1) * modInv(x2 - x1));
        const x3  = mod(lam * lam - x1 - x2);
        return [x3, mod(lam * (x1 - x3) - y1)];
    };

    const scalarMul = (k, pt = [Gx, Gy]) => {
        let result = null, addend = pt;
        for (; k > 0n; k >>= 1n, addend = ptAdd(addend, addend))
            if (k & 1n) result = ptAdd(result, addend);
        return result;
    };

    const u8ToBigInt = (u8) => {
        let n = 0n;
        for (const b of u8) n = (n << 8n) | BigInt(b);
        return n;
    };

    const bigIntTo32 = (n) => {
        const a = new Uint8Array(32);
        let t = n;
        for (let i = 31; i >= 0; i--) { a[i] = Number(t & 0xffn); t >>= 8n; }
        return a;
    };

    // HMAC-SHA256 via WebCrypto (available in all modern browsers, incl. http)
    const hmac256 = async (keyBytes, ...chunks) => {
        const k = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const msg = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { msg.set(c, off); off += c.length; }
        return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
    };

    // RFC 6979 deterministic nonce generation
    const rfc6979 = async (msgHash, privKeyBytes) => {
        let V = new Uint8Array(32).fill(0x01);
        let K = new Uint8Array(32).fill(0x00);
        K = await hmac256(K, V, new Uint8Array([0x00]), privKeyBytes, msgHash);
        V = await hmac256(K, V);
        K = await hmac256(K, V, new Uint8Array([0x01]), privKeyBytes, msgHash);
        V = await hmac256(K, V);
        for (;;) {
            V = await hmac256(K, V);
            const k = u8ToBigInt(V);
            if (k >= 1n && k < N) return k;
            K = await hmac256(K, V, new Uint8Array([0x00]));
            V = await hmac256(K, V);
        }
    };

    return {
        /**
         * Sign a 32-byte pre-hash with secp256k1.
         * @param {Uint8Array} msgHash32  Already-hashed 32-byte message
         * @param {Uint8Array} privBytes  32-byte private key scalar
         * @returns {Promise<{r: bigint, s: bigint}>}
         */
        sign: async (msgHash32, privBytes) => {
            const d = u8ToBigInt(privBytes);
            const z = u8ToBigInt(msgHash32);
            const k = await rfc6979(msgHash32, privBytes);
            const [kGx] = scalarMul(k);
            const r = mod(kGx, N);
            const s = mod(modInv(k, N) * mod(z + r * d, N), N);
            if (r === 0n || s === 0n) throw new Error('secp256k1: degenerate signature');
            return { r, s };
        },

        /** Encode {r,s} as DER SEQUENCE { INTEGER r, INTEGER s } */
        toDer: ({ r, s }) => {
            const encInt = (n) => {
                const b = bigIntTo32(n);
                let start = 0;
                while (start < 31 && b[start] === 0) start++;
                const t = b.slice(start);
                return (t[0] & 0x80)
                    ? new Uint8Array([0x02, t.length + 1, 0x00, ...t])
                    : new Uint8Array([0x02, t.length, ...t]);
            };
            const rEnc = encInt(r), sEnc = encInt(s);
            return new Uint8Array([0x30, rEnc.length + sEnc.length, ...rEnc, ...sEnc]);
        },
    };
})();

// ── DER / X509 helpers ───────────────────────────────────────────────────────

/** Read a BER/DER length at bytes[offset]. Returns { value, nextOffset }. */
function derReadLength(bytes, offset) {
    const first = bytes[offset];
    if (first < 0x80) return { value: first, nextOffset: offset + 1 };
    const numOctets = first & 0x7f;
    let len = 0;
    for (let i = 0; i < numOctets; i++) len = (len << 8) | bytes[offset + 1 + i];
    return { value: len, nextOffset: offset + 1 + numOctets };
}

/** Skip one DER TLV element; return offset immediately after it. */
function derSkipTlv(bytes, offset) {
    offset++; // skip tag byte
    const lenInfo = derReadLength(bytes, offset);
    return lenInfo.nextOffset + lenInfo.value;
}

/**
 * Extract the raw 32-byte private key scalar from a secp256k1 PKCS#8 DER.
 *
 * PKCS#8 structure:
 *   SEQUENCE {
 *     INTEGER 0 (version)
 *     SEQUENCE { OID ecPublicKey, OID secp256k1 }
 *     OCTET STRING {
 *       SEQUENCE {           <- ECPrivateKey (RFC 5915)
 *         INTEGER 1
 *         OCTET STRING(32)  <- private key scalar  ← we want this
 *         [0] OID           <- optional
 *         [1] BIT STRING    <- optional public key
 *       }
 *     }
 *   }
 */
function extractEcPrivateKeyScalar(pkcs8Der) {
    let off = 0;
    if (pkcs8Der[off++] !== 0x30) throw new Error('PKCS8: expected outer SEQUENCE');
    off = derReadLength(pkcs8Der, off).nextOffset;
    off = derSkipTlv(pkcs8Der, off); // skip version INTEGER
    off = derSkipTlv(pkcs8Der, off); // skip algorithm SEQUENCE
    if (pkcs8Der[off++] !== 0x04) throw new Error('PKCS8: expected OCTET STRING');
    off = derReadLength(pkcs8Der, off).nextOffset;
    if (pkcs8Der[off++] !== 0x30) throw new Error('ECPrivateKey: expected SEQUENCE');
    off = derReadLength(pkcs8Der, off).nextOffset;
    off = derSkipTlv(pkcs8Der, off); // skip version INTEGER (1)
    if (pkcs8Der[off++] !== 0x04) throw new Error('ECPrivateKey: expected key OCTET STRING');
    const { value: scalarLen, nextOffset: scalarStart } = derReadLength(pkcs8Der, off);
    return pkcs8Der.slice(scalarStart, scalarStart + scalarLen);
}

/**
 * Parse an X509 certificate DER and return:
 *   - subjectPublicKeyInfoBytes: Uint8Array of the SubjectPublicKeyInfo SEQUENCE
 *   - certSignatureBytes: Uint8Array of the BIT STRING certificate signature value,
 *     with the leading 0x00 "unused bits" byte stripped
 *     (matches PHP: substr($cert->getCurrentCert()['signature'], 1))
 */
function parseX509Der(certDer) {
    let off = 0;

    // Outer Certificate SEQUENCE
    if (certDer[off++] !== 0x30) throw new Error('X509: expected outer SEQUENCE');
    off = derReadLength(certDer, off).nextOffset; // skip outer length, enter Certificate

    // ── TBSCertificate ───────────────────────────────────────────────────────
    if (certDer[off] !== 0x30) throw new Error('X509: expected TBSCertificate SEQUENCE');
    off++; // skip 0x30 tag
    const tbsLen         = derReadLength(certDer, off);
    const tbsContentStart = tbsLen.nextOffset;
    const tbsContentEnd   = tbsContentStart + tbsLen.value;
    off = tbsContentStart;

    // TBS fields: [0]version?, serialNumber, sigAlg, issuer, validity, subject, SPKI, ...
    if (certDer[off] === 0xA0) off = derSkipTlv(certDer, off); // optional [0] version
    off = derSkipTlv(certDer, off); // serialNumber  (INTEGER)
    off = derSkipTlv(certDer, off); // signature algorithm (SEQUENCE)
    off = derSkipTlv(certDer, off); // issuer        (SEQUENCE)
    off = derSkipTlv(certDer, off); // validity      (SEQUENCE)
    off = derSkipTlv(certDer, off); // subject       (SEQUENCE)

    // SubjectPublicKeyInfo SEQUENCE
    if (certDer[off] !== 0x30) throw new Error('X509: expected SubjectPublicKeyInfo SEQUENCE');
    const spkiStart = off;
    off++;
    const spkiLen = derReadLength(certDer, off);
    const spkiEnd = spkiLen.nextOffset + spkiLen.value;
    const subjectPublicKeyInfoBytes = certDer.slice(spkiStart, spkiEnd);

    // Jump to end of TBS (skip optional extensions etc.)
    off = tbsContentEnd;

    // signatureAlgorithm SEQUENCE (after TBS)
    off = derSkipTlv(certDer, off);

    // Certificate signature BIT STRING
    if (certDer[off] !== 0x03) throw new Error('X509: expected BIT STRING for cert signature');
    off++;
    const sigLen         = derReadLength(certDer, off);
    const sigContentStart = sigLen.nextOffset;
    // Strip leading 0x00 "unused bits" byte → matches PHP getCertSignature()
    const certSignatureBytes = certDer.slice(sigContentStart + 1, sigContentStart + sigLen.value);

    return { subjectPublicKeyInfoBytes, certSignatureBytes };
}

/**
 * PEM string (with or without headers) → Uint8Array of DER bytes.
 */
function pemToDer(pem) {
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const bin  = atob(b64);
    return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/**
 * Private key string → Uint8Array of PKCS8 DER bytes.
 * Handles both PEM with "-----BEGIN PRIVATE KEY-----" headers and raw base64.
 */
function pkcs8Base64ToDer(keyStr) {
    const s = keyStr.trim();
    return s.includes('-----') ? pemToDer(s) : Uint8Array.from(atob(s.replace(/\s+/g, '')), c => c.charCodeAt(0));
}

/** Uint8Array → base64 string (chunked to avoid stack overflow). */
function bytesToBase64(bytes) {
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK)
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return btoa(binary);
}

// ── TLV encoding (matching Tag.php) ─────────────────────────────────────────
// Each field: [tag_byte][length_byte][...value_bytes]
// Tags 1–7: string values (UTF-8); Tags 8–9: binary Uint8Array.
function tlvField(tag, value) {
    const bytes = (typeof value === 'string') ? new TextEncoder().encode(value) : value;
    return new Uint8Array([tag, bytes.length, ...bytes]);
}

function buildTlvBuffer(fields) {
    const totalLen = fields.reduce((n, f) => n + f.length, 0);
    const buf = new Uint8Array(totalLen);
    let offset = 0;
    for (const f of fields) { buf.set(f, offset); offset += f.length; }
    return buf;
}

// ── XML escape helper ────────────────────────────────────────────────────────
function escXml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ── Simplified UBL 2.1 invoice XML (pre-canonical, for hashing) ─────────────
// Generates the base XML that gets hashed — no UBLExtensions, no <cac:Signature>,
// no QR AdditionalDocumentReference — matching what PHP strips before C14N/hash.
function buildSimplifiedInvoiceXml(sale, business, location, icv, pih) {
    const now       = new Date(sale.created_at);
    const issueDate = now.toISOString().slice(0, 10);         // YYYY-MM-DD
    const issueTime = now.toISOString().slice(11, 19) + 'Z';  // HH:MM:SSZ

    const sellerName = escXml(business.name || '');
    const vatNumber  = escXml(business.tax_number_1 || '');
    const crNumber   = escXml(business.tax_number_2 || '');
    const crLabel    = escXml(business.tax_label_2  || 'CRN');

    // Currency code: prefer business.currency.code (synced config), fallback to 'SAR'
    const currCode = (typeof business.currency === 'object' && business.currency?.code)
        || business.currency_code || 'SAR';

    const totalIncTax = (+sale.total).toFixed(2);
    const taxAmount   = (+sale.tax).toFixed(2);
    const taxableAmt  = Math.max(0, +sale.total - +sale.tax).toFixed(2);
    const discountAmt = (+(sale.discount || 0)).toFixed(2);

    // Invoice lines
    const lines = (sale.items || []).map((item, idx) => {
        const qty        = +(item.quantity) || 0;
        const unitPriceInc = +(item.unit_price) || 0;
        const unitPriceExc = +(item.unit_price_exc_tax ?? item.unit_price) || 0;
        const taxPct     = +(item.tax_percent || 0);
        const itemTax    = +(item.item_tax_per_unit || 0);
        const lineTotal  = (qty * unitPriceInc).toFixed(2);
        const lineTaxAmt = (qty * itemTax).toFixed(2);
        return `    <cac:InvoiceLine>
        <cbc:ID>${idx + 1}</cbc:ID>
        <cbc:InvoicedQuantity unitCode="PCE">${qty}</cbc:InvoicedQuantity>
        <cbc:LineExtensionAmount currencyID="${currCode}">${lineTotal}</cbc:LineExtensionAmount>
        <cac:TaxTotal>
            <cbc:TaxAmount currencyID="${currCode}">${lineTaxAmt}</cbc:TaxAmount>
            <cbc:RoundingAmount currencyID="${currCode}">${lineTotal}</cbc:RoundingAmount>
        </cac:TaxTotal>
        <cac:Item>
            <cbc:Name>${escXml(item.name)}</cbc:Name>
            <cac:ClassifiedTaxCategory>
                <cbc:Percent>${taxPct.toFixed(2)}</cbc:Percent>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:ClassifiedTaxCategory>
        </cac:Item>
        <cac:Price>
            <cbc:PriceAmount currencyID="${currCode}">${unitPriceExc.toFixed(2)}</cbc:PriceAmount>
        </cac:Price>
    </cac:InvoiceLine>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
    xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
    xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>${escXml(sale.invoice_no)}</cbc:ID>
    <cbc:UUID>${escXml(sale.local_uuid)}</cbc:UUID>
    <cbc:IssueDate>${issueDate}</cbc:IssueDate>
    <cbc:IssueTime>${issueTime}</cbc:IssueTime>
    <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
    <cbc:DocumentCurrencyCode>${currCode}</cbc:DocumentCurrencyCode>
    <cbc:TaxCurrencyCode>${currCode}</cbc:TaxCurrencyCode>
    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>${icv}</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>PIH</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${pih}</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
    <cac:AccountingSupplierParty>
        <cac:Party>
            <cac:PartyIdentification>
                <cbc:ID schemeID="${crLabel}">${crNumber}</cbc:ID>
            </cac:PartyIdentification>
            <cac:PostalAddress>
                <cbc:StreetName>${escXml(location.street || '')}</cbc:StreetName>
                <cbc:BuildingNumber>${escXml(location.building_number || '')}</cbc:BuildingNumber>
                <cbc:CitySubdivisionName>${escXml(location.sub_division_name || location.landmark || '')}</cbc:CitySubdivisionName>
                <cbc:CityName>${escXml(location.city || '')}</cbc:CityName>
                <cbc:PostalZone>${escXml(location.zip_code || '')}</cbc:PostalZone>
                <cbc:CountrySubentity>${escXml(location.state || '')}</cbc:CountrySubentity>
                <cac:Country>
                    <cbc:IdentificationCode>${escXml(location.country || 'SA')}</cbc:IdentificationCode>
                </cac:Country>
            </cac:PostalAddress>
            <cac:PartyTaxScheme>
                <cbc:CompanyID>${vatNumber}</cbc:CompanyID>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:PartyTaxScheme>
            <cac:PartyLegalEntity>
                <cbc:RegistrationName>${sellerName}</cbc:RegistrationName>
            </cac:PartyLegalEntity>
        </cac:Party>
    </cac:AccountingSupplierParty>
    <cac:AccountingCustomerParty>
        <cac:Party/>
    </cac:AccountingCustomerParty>
    <cac:PaymentMeans>
        <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
    </cac:PaymentMeans>
    <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${currCode}">${taxAmount}</cbc:TaxAmount>
        <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="${currCode}">${taxableAmt}</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="${currCode}">${taxAmount}</cbc:TaxAmount>
            <cac:TaxCategory>
                <cbc:Percent>15.00</cbc:Percent>
                <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
            </cac:TaxCategory>
        </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:LegalMonetaryTotal>
        <cbc:LineExtensionAmount currencyID="${currCode}">${taxableAmt}</cbc:LineExtensionAmount>
        <cbc:TaxExclusiveAmount currencyID="${currCode}">${taxableAmt}</cbc:TaxExclusiveAmount>
        <cbc:TaxInclusiveAmount currencyID="${currCode}">${totalIncTax}</cbc:TaxInclusiveAmount>
        <cbc:AllowanceTotalAmount currencyID="${currCode}">${discountAmt}</cbc:AllowanceTotalAmount>
        <cbc:PrepaidAmount currencyID="${currCode}">0.00</cbc:PrepaidAmount>
        <cbc:PayableAmount currencyID="${currCode}">${totalIncTax}</cbc:PayableAmount>
    </cac:LegalMonetaryTotal>
${lines}
</Invoice>`;
}

// ── Main export: generateZatcaQr ─────────────────────────────────────────────
/**
 * Generates a fully signed ZATCA QR code (tags 1–9) offline.
 *
 * @param {object} sale        - transaction object
 * @param {object} business    - synced business object
 * @param {object} location    - synced location object
 * @param {object} certRecord  - ZatcaCertificate record (private, csid_certificate, …)
 * @param {string|null} pih    - Previous Invoice Hash (base64); null → ZATCA default
 * @param {number} icv         - Invoice Counter Value
 *
 * @returns {Promise<{zatca_qr_code: string, zatca_hash: string, zatca_uuid: string}>}
 */
async function generateZatcaQr(sale, business, location, certRecord, pih, icv) {
    try {
        const PIH_DEFAULT = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';
        const effectivePih = pih || PIH_DEFAULT;

        // 1. Build simplified UBL XML (no UBL ext / Signature / QR ref)
        const xmlStr   = buildSimplifiedInvoiceXml(sale, business, location, icv, effectivePih);
        const xmlBytes = new TextEncoder().encode(xmlStr);

        // 2. SHA-256 hash of XML → Tag 6
        const hashBuffer = await crypto.subtle.digest('SHA-256', xmlBytes);
        const hashBytes  = new Uint8Array(hashBuffer);
        const hashBase64 = bytesToBase64(hashBytes);

        // 3. Extract secp256k1 private key scalar (32 bytes) from PKCS#8 PEM/DER
        const privKeyDer    = pkcs8Base64ToDer(certRecord.private);
        const privKeyScalar = extractEcPrivateKeyScalar(privKeyDer);

        // 4. ECDSA-secp256k1 sign
        //    phpseclib3 applies SHA256 internally before ECDSA (SHA256withECDSA),
        //    so we hash the invoice hash one more time to match server behavior.
        const signInputBuf   = await crypto.subtle.digest('SHA-256', hashBytes);
        const signInputBytes = new Uint8Array(signInputBuf);
        const rawSig  = await _SECP256K1.sign(signInputBytes, privKeyScalar);
        const sigDer  = _SECP256K1.toDer(rawSig);
        const sigBase64 = bytesToBase64(sigDer); // Tag 7

        // 5. Parse X509 cert DER → SubjectPublicKeyInfo + cert signature bytes
        const certPem = certRecord.csid_production_certificate || certRecord.csid_certificate || '';
        const certDer = pemToDer(certPem);
        const { subjectPublicKeyInfoBytes, certSignatureBytes } = parseX509Der(certDer);

        // 6. Build TLV (tags 1–9) and base64-encode
        const sellerName = business.name || '';
        const vatNumber  = business.tax_number_1 || '';
        const isoTs      = new Date(sale.created_at).toISOString().replace(/\.\d+Z$/, 'Z');
        const totalStr   = (+sale.total).toFixed(2);
        const taxStr     = (+sale.tax).toFixed(2);

        const tlvBuf = buildTlvBuffer([
            tlvField(1, sellerName),
            tlvField(2, vatNumber),
            tlvField(3, isoTs),
            tlvField(4, totalStr),
            tlvField(5, taxStr),
            tlvField(6, hashBase64),
            tlvField(7, sigBase64),
            tlvField(8, subjectPublicKeyInfoBytes),
            tlvField(9, certSignatureBytes),
        ]);

        return {
            zatca_qr_code: bytesToBase64(tlvBuf),
            zatca_hash:    hashBase64,
            zatca_uuid:    sale.local_uuid,
        };
    } catch (e) {
        console.error('[ZATCA] Offline signing failed:', e);
        throw e; // re-throw so the caller can surface it
    }
}
