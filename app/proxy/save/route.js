export const runtime = 'nodejs';

import crypto from "crypto";
import { supabase } from "../../../lib/supabase";

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

  // 1) Genuine broken payload (no shop / event / product)
  if (!shop || !event_handle || !product?.product_id) {
    return bad("Missing required fields", 400, origin);
  }

  // 2) Special case: not logged in → return login link
  if (!customer_id || !customer_email) {
    return bad(
      '<a href="https://account.famelia.com.au/?locale=en&region_country=AU">Log in here to save your tasting notes.</a>',
      401,
      origin
    );
  }

  try {
    // 1) Verify the customer really matches your store record
    const customerGID = `gid://shopify/Customer/${customer_id}`;
    const q1 = `query($id: ID!) { customer(id: $id) { id email firstName lastName } }`;
    const d1 = await shopifyGraphQL(q1, { id: customerGID });
    const realEmail = d1?.customer?.email;

    const firstName = d1?.customer?.firstName || "";
    const lastName = d1?.customer?.lastName || "";
    const customer_name = (firstName + " " + lastName).trim() || null;
    
    if (!realEmail || realEmail.toLowerCase() !== String(customer_email).toLowerCase()) {
      return bad("Customer verification failed", 401, origin);
    }

    // 2) Read existing metafield JSON (wine-first model)
    const q2 = `
      query($id: ID!) {
        customer(id: $id) {
          metafield(namespace:"tasting", key:"events") { id type value }
        }
      }
    `;
    const d2 = await shopifyGraphQL(q2, { id: customerGID });

    // New shape: { wines: [ { ... } ] }
    let store = { wines: [] };

    const mf = d2?.customer?.metafield;
    if (mf?.value) {
      try {
        const parsed = JSON.parse(mf.value);

        // If it’s already wine-first, keep it; otherwise start fresh
        if (parsed && Array.isArray(parsed.wines)) {
          store = parsed;
        }
      } catch {
        // ignore parse errors; start from empty
      }
    }

    // 3) Merge new note into wine-first store
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const pid = Number(product.product_id);

    // Find or create the wine record
    let wine = store.wines.find(w => w.product_id === pid);

    if (!wine) {
      wine = {
        product_id: pid,
        handle: product.handle || "",
        title: product.title || "",
        product_image_url: product.product_image_url || "",
        rating: (typeof product.rating === "number") ? product.rating : null,
        nose:   (product.nose   || "").slice(0, 2000),
        palate: (product.palate || "").slice(0, 2000),
        note:   (product.note   || "").slice(0, 2000),
        created_at: now,
        updated_at: now,
        events: []
      };
      store.wines.push(wine);
    } else {
      // Existing entry: preserve created_at, update tasting fields
      wine.handle = product.handle || wine.handle || "";
      wine.title  = product.title  || wine.title  || "";
      wine.product_image_url = product.product_image_url || wine.product_image_url || "";

      if (typeof product.rating === "number") {
        wine.rating = product.rating;
      }

      wine.nose   = (product.nose   ?? wine.nose   ?? "").slice(0, 2000);
      wine.palate = (product.palate ?? wine.palate ?? "").slice(0, 2000);
      wine.note   = (product.note   ?? wine.note   ?? "").slice(0, 2000);

      wine.created_at = wine.created_at || wine.updated_at || now;
      wine.updated_at = now;
    }

    // Ensure events[] exists
    if (!Array.isArray(wine.events)) wine.events = [];

    // Attach or update the event entry (by collection_handle)
    let ev = wine.events.find(e => e.collection_handle === event_handle);

    if (!ev) {
      ev = {
        id: event_handle,
        name: event_name || event_handle,
        collection_handle: event_handle,
        date: today
      };
      wine.events.push(ev);
    } else {
      // Keep name up to date if you ever change event_name
      if (event_name) ev.name = event_name;
      // You can decide whether to bump the date; for now we leave it as first-seen
    }

    // 4) Save back to Shopify metafield
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

    // 5) 🔄 Mirror into Supabase tasting_ratings
    try {
      const row = {
        shop: shop || SHOP || "famelia-wine.myshopify.com",
        customer_id: String(customer_id),
        customer_name: customer_name || null,
        customer_email: customer_email || null,
        event_handle: event_handle || null,
        event_name: event_name || null,
        event_date: today, // 👈 NEW: satisfies NOT NULL "event_date"

        product_id: pid,
        product_handle: product.handle || "",
        product_title: product.title || "",
        product_image_url: product.product_image_url || "",
        rating: (typeof product.rating === "number") ? product.rating : null,
        nose: (product.nose || "").slice(0, 2000) || null,
        palate: (product.palate || "").slice(0, 2000) || null,
        note: (product.note || "").slice(0, 2000) || null,
        // created_at is handled by Supabase default if you set one
      };

      console.log("Saving to Supabase:", {
  product_id: pid,
  product_image_url: product.product_image_url
});

            const { error: supaError } = await supabase
        .from("tasting_ratings")
        .upsert(row, {
          onConflict: "customer_id,product_id,event_handle",
        });

            if (supaError) {
        console.error("Supabase upsert error (tasting_ratings)", supaError);
        // Don't block the customer – just log it
      }
    } catch (supErr) {
      console.error("Supabase upsert exception", supErr);
      // Still don't block saving to Shopify
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: corsHeaders(origin)
    });
  } catch (e) {
    return bad(`Server error: ${e.message || e}`, 500, origin);
  }
}
