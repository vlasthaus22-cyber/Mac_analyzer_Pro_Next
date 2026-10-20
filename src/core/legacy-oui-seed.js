export const LEGACY_OUI_SEED_VERSION = "2026.10";

// Exact MA-L values whose 2026.10 bundled assignment changed in the current
// IEEE registry. Other legacy values already match the current registry.
export const LEGACY_OUI_SEED_CHANGES = Object.freeze([
  { prefix: "B4DB91", oldVendor: "CELESTICA INC." },
  { prefix: "3CDA6D", oldVendor: "Tiandy Technologies CO.,LTD" },
  { prefix: "001EB8", oldVendor: "Aloys, Inc" },
  { prefix: "24A937", oldVendor: "PURE Storage" },
  { prefix: "34AD61", oldVendor: "CELESTICA INC." },
  { prefix: "0080C2", oldVendor: "IEEE 802.1 Chair" },
  { prefix: "000064", oldVendor: "Yokogawa Digital Computer Corporation" },
  { prefix: "D00AAB", oldVendor: "Yokogawa Digital Computer Corporation" },
  { prefix: "001E83", oldVendor: "LAN/MAN Standards Association (LMSC)" },
  { prefix: "DCDA4D", oldVendor: "CELESTICA INC." },
  { prefix: "885A23", oldVendor: "CELESTICA INC." },
  { prefix: "946442", oldVendor: "CELESTICA INC." },
  { prefix: "0C166E", oldVendor: "WirelessMobility Engineering Centre SDN. BHD" },
  { prefix: "30EB5A", oldVendor: "Landis+Gyr S.A." },
  { prefix: "98B177", oldVendor: "Landis+Gyr S.A." },
  { prefix: "BCF9F2", oldVendor: "TEKO" },
  { prefix: "7C9763", oldVendor: "Openmatics s.r.o." },
  { prefix: "F0DB30", oldVendor: "Yottabyte" },
  { prefix: "00E0EC", oldVendor: "CELESTICA INC." },
  { prefix: "006041", oldVendor: "Yokogawa Digital Computer Corporation" },
  { prefix: "001D66", oldVendor: "Hyundai Telecom" },
  { prefix: "00120F", oldVendor: "IEEE 802.3" },
  { prefix: "00905B", oldVendor: "RAYMOND AND LAE ENGINEERING" },
  { prefix: "D849BF", oldVendor: "CELESTICA INC." },
  { prefix: "F8554B", oldVendor: "WirelessMobility Engineering Centre SDN. BHD" },
  { prefix: "64F64D", oldVendor: "CELESTICA INC." },
  { prefix: "5CAAA2", oldVendor: "CELESTICA INC." },
  { prefix: "0C48C6", oldVendor: "CELESTICA INC." },
  { prefix: "34800D", oldVendor: "Cavium Inc" },
  { prefix: "0090DD", oldVendor: "MIHARU COMMUNICATIONS Inc" },
  { prefix: "6C7028", oldVendor: "Landis+Gyr S.A." },
]);

export function legacyOuiSeedMatchMap() {
  return new Map(LEGACY_OUI_SEED_CHANGES.map(({ prefix, oldVendor }) => [prefix, oldVendor]));
}
