// Great-circle distance between two lat/lon points, in kilometers (Haversine).
// Pure JS on purpose: the candidate set is tiny (branches of the user's chains)
// and this DB has no PostGIS, so an inline SQL spherical formula would just be
// unreadable for no gain.
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371; // mean earth radius, km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
