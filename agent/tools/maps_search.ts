// Places search. With GOOGLE_MAPS_API_KEY in the user's secrets it uses Google
// Places (Text Search, New) — ratings, opening hours, price level; otherwise
// OpenStreetMap's Nominatim, keyless (names, addresses, coordinates only).
import { defineTool } from "eve/tools";
import { z } from "zod";

const UA = "openzo/0.3 (self-hosted Zo; https://github.com/)";

export default defineTool({
  description:
    "Find places (restaurants, shops, addresses, landmarks) and their locations. Put the area in the query (\"ramen near Tanjong Pagar, Singapore\"). Returns names, addresses, coordinates and map links; with a Google Maps key also ratings, hours and price level.",
  inputSchema: z.object({
    query: z.string().min(1).max(300),
    max_results: z.number().int().min(1).max(20).optional(),
    open_now: z.boolean().optional().describe("Google lane only."),
    min_rating: z.number().min(0).max(5).optional().describe("Google lane only."),
  }),
  async execute({ query, max_results, open_now, min_rating }) {
    const n = max_results ?? 8;
    const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (key) {
      const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours.openNow,places.googleMapsUri,places.websiteUri,places.nationalPhoneNumber",
        },
        body: JSON.stringify({ textQuery: query, pageSize: n, ...(open_now ? { openNow: true } : {}), ...(min_rating ? { minRating: min_rating } : {}) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Google Places answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as any;
      return {
        source: "google",
        results: (data.places ?? []).map((p: any) => ({
          name: p.displayName?.text,
          address: p.formattedAddress,
          lat: p.location?.latitude,
          lon: p.location?.longitude,
          rating: p.rating,
          ratings: p.userRatingCount,
          price: p.priceLevel,
          open_now: p.currentOpeningHours?.openNow,
          phone: p.nationalPhoneNumber,
          website: p.websiteUri,
          map: p.googleMapsUri,
        })),
      };
    }
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: "jsonv2", limit: String(n), extratags: "1" })}`;
    const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`OpenStreetMap answered ${res.status}`);
    const rows = (await res.json()) as any[];
    return {
      source: "openstreetmap",
      note: "Keyless OpenStreetMap lane: no ratings or reviews. Add GOOGLE_MAPS_API_KEY in Settings → Secrets for Google Places.",
      results: rows.map((r) => ({
        name: r.name || r.display_name.split(",")[0],
        address: r.display_name,
        kind: `${r.category}/${r.type}`,
        lat: Number(r.lat),
        lon: Number(r.lon),
        opening_hours: r.extratags?.opening_hours,
        website: r.extratags?.website ?? r.extratags?.["contact:website"],
        phone: r.extratags?.phone ?? r.extratags?.["contact:phone"],
        map: `https://www.openstreetmap.org/${r.osm_type}/${r.osm_id}`,
      })),
    };
  },
});
