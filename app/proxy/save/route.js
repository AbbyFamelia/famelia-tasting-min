export const runtime = 'nodejs';

import crypto from "crypto";

const SHOP = process.env.SHOPIFY_SHOP;                 // e.g. famelia-wine.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;   // shpat_...
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

// 🔒 Only allow YOUR storefront origins
const ALLOWED_ORIGINS = new Set([
  "https://famelia-wine.myshopify.com",
  "https://famelia.com.au",
  "https://www.famelia.com.au"
]);

function corsHeaders(origin) {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function bad(msg, code = 400, origin = "*") {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: code, headers: corsHeaders(origin)
  });
}

async function shopifyGraphQL(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await r.json();
  if (!r.ok || json.errors) {
    throw new Error(JSON.stringify(json.errors || json));
  }
  return json.data;
}

// Handle CORS preflight
export async function OPTIONS(request) {
  const origin = request.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return bad("Origin not allowed (preflight)", 401, origin || "*");
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin)
  });
}

export async function POST(request) {
  const origin = request.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return bad("Origin not allowed", 401, origin || "*");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON", 400, origin);
  }

  const { shop, customer_id, customer_email, event_handle, event_name, product } = body || {};
  if (!shop || !customer_id || !customer_email || !event_handle || !product?.product_id) {
    return bad("Missing required fields", 400, origin);
  }

  try {
    // 1) Verify the customer really matches your store record
    const customerGID = `gid://shopify/Customer/${customer_id}`;
    const q1 = `query($id: ID!) { customer(id: $id) { id email } }`;
    const d1 = await shopifyGraphQL(q1, { id: customerGID });
    const realEmail = d1?.customer?.email;
    if (!realEmail || realEmail.toLowerCase() !== String(customer_email).toLowerCase()) {
      return bad("Customer verification failed", 401, origin);
    }

    // 2) Read existing metafield JSON
    const q2 = `
      query($id: ID!) {
        customer(id: $id) {
          metafield(namespace:"tasting", key:"events") { id type value }
        }
      }
    `;
    const d2 = await shopifyGraphQL(q2, { id: customerGID });
    let store = { events: [] };
    const mf = d2?.customer?.metafield;
    if (mf?.value) {
      try { store = JSON.parse(mf.value); } catch {}
    }

    // 3) Merge new note
const now = new Date().toISOString();
let evt = store.events.find(e => e.collection_handle === event_handle);
if (!evt) {
  evt = {
    id: event_handle,
    name: event_name || event_handle,
    date: now.slice(0,10),
    collection_handle: event_handle,
    wines: []
  };
  store.events.push(evt);
}

const pid = Number(product.product_id);
const idx = evt.wines.findIndex(w => w.product_id === pid);

if (idx === -1) {
  // New entry: write created_at once
  const entryNew = {
    product_id: pid,
    handle: product.handle || "",
    title: product.title || "",
    rating: (typeof product.rating === "number") ? product.rating : null,
    nose:   (product.nose   || "").slice(0, 2000),
    palate: (product.palate || "").slice(0, 2000),
    note:   (product.note   || "").slice(0, 2000),
    created_at: now,
    updated_at: now
  };
  evt.wines.push(entryNew);
} else {
  // Existing entry: preserve created_at, refresh updated_at
  const existing = evt.wines[idx];
  evt.wines[idx] = {
    ...existing,
    handle: product.handle || existing.handle || "",
    title:  product.title  || existing.title  || "",
    rating: (typeof product.rating === "number") ? product.rating : existing.rating ?? null,
    nose:   (product.nose   ?? existing.nose   ?? "").slice(0, 2000),
    palate: (product.palate ?? existing.palate ?? "").slice(0, 2000),
    note:   (product.note   ?? existing.note   ?? "").slice(0, 2000),
    created_at: existing.created_at || existing.updated_at || now, // backfill just in case
    updated_at: now
  };
}

// Light backfill for any legacy wines in this event missing created_at
evt.wines.forEach(w => {
  if (!w.created_at) w.created_at = w.updated_at || now;
});


    // 4) Save back
    const q3 = `
      mutation($ownerId: ID!, $value: String!) {
        metafieldsSet(metafields: [{
          ownerId: $ownerId,
          namespace: "tasting",
          key: "events",
          type: "json",
          value: $value
        }]) {
          userErrors { field message }
        }
      }
    `;
    const d3 = await shopifyGraphQL(q3, { ownerId: customerGID, value: JSON.stringify(store) });
    const errs = d3?.metafieldsSet?.userErrors || [];
    if (errs.length) return bad(errs.map(e => e.message).join("; "), 500, origin);

    return new Response(JSON.stringify({ ok: true }), {
      headers: corsHeaders(origin)
    });
  } catch (e) {
    return bad(`Server error: ${e.message || e}`, 500, origin);
  }
}
