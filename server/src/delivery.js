// Delivery zones and fees. Mirrors skills/glamoriz-sales/references/brand.md: change both together.
// Fees are calculated here, not by the model, so the customer is never quoted an invented number.

export const FREE_DELIVERY_THRESHOLD_NGN = 50000;

const ZONES = [
  { city: 'Lagos', zone: 'Lagos Island', fee: 2500, days: 1, areas: ['lekki', 'vi', 'victoria island', 'ikoyi', 'ajah', 'oniru', 'chevron', 'sangotedo'] },
  { city: 'Lagos', zone: 'Lagos Mainland', fee: 3000, days: 1, areas: ['ikeja', 'yaba', 'surulere', 'gbagada', 'maryland', 'ogba', 'magodo', 'ojota', 'ketu', 'oshodi', 'ilupeju', 'anthony', 'agege', 'isolo', 'festac', 'apapa'] },
  { city: 'Lagos', zone: 'Lagos Outer', fee: 4500, days: 2, areas: ['ikorodu', 'badagry', 'epe', 'alimosho', 'ikotun', 'igando', 'egbeda', 'iyana ipaja'] },
  { city: 'Abuja', zone: 'Abuja Central', fee: 2500, days: 1, areas: ['wuse', 'maitama', 'garki', 'asokoro', 'jabi', 'utako', 'wuye', 'central area', 'cbd'] },
  { city: 'Abuja', zone: 'Abuja Outer', fee: 3500, days: 2, areas: ['lugbe', 'kubwa', 'gwarinpa', 'lokogoma', 'apo', 'galadimawa', 'life camp', 'katampe', 'dawaki', 'karu', 'nyanya'] },
];

export function normaliseCity(city) {
  const c = String(city || '').trim().toLowerCase();
  if (['lagos', 'lag', 'lasgidi'].includes(c)) return 'Lagos';
  if (['abuja', 'fct', 'abj'].includes(c)) return 'Abuja';
  return null;
}

/**
 * Returns { ok, city, zone, fee_ngn, days, zone_uncertain } or { ok: false, reason }.
 * An unknown area in a known city gets that city's highest fee and is flagged, per brand.md.
 */
export function quoteDelivery(city, area, subtotalNgn) {
  const normCity = normaliseCity(city);
  if (!normCity) {
    return { ok: false, reason: 'outside_delivery_area', message: 'We only deliver within Lagos and Abuja. Hand over to a human for other states.' };
  }
  const a = String(area || '').trim().toLowerCase();
  const cityZones = ZONES.filter((z) => z.city === normCity);
  let match = cityZones.find((z) => z.areas.some((name) => a.includes(name)));
  let uncertain = false;
  if (!match) {
    match = cityZones.reduce((hi, z) => (z.fee > hi.fee ? z : hi));
    uncertain = true;
  }
  const free = subtotalNgn >= FREE_DELIVERY_THRESHOLD_NGN;
  return {
    ok: true,
    city: normCity,
    zone: match.zone,
    fee_ngn: free ? 0 : match.fee,
    free_delivery: free,
    delivery_days: match.days,
    zone_uncertain: uncertain,
  };
}
